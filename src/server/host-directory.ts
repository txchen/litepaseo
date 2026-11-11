import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { AgentSummary, Permission } from "../shared/wire.ts";
import type { VersionedCollection } from "./versioned-collection.ts";

type SyncCursor = { generation: string; afterSeq: number };
type Placement = { projectKey: string; projectName: string } | null | undefined;
type Entry = { agent: AgentSnapshotPayload; project?: Placement; syncSeq?: number };
interface AgentsPayload {
  entries: Entry[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
  sync?: {
    generation: string;
    headSeq: number;
    mode: "snapshot" | "changes";
    removals: { id: string; seq: number }[];
  };
}
type AgentUpdate =
  | {
      kind: "upsert";
      agent: AgentSnapshotPayload;
      project?: Placement;
      generation?: string;
      seq?: number;
    }
  | { kind: "remove"; agentId: string; generation?: string; seq?: number };

interface Subscription {
  subscribe(observer: {
    snapshot(payload: AgentsPayload): void;
    update(message: { type: string; payload?: unknown }): void;
    error?(error: unknown): void;
  }): () => void;
  release(): Promise<void>;
}

/** The DaemonClient surface the directory needs; kept narrow so tests can supply a double. */
export interface DirectoryDriver {
  getConnectionState(): { status: string };
  subscribeConnectionStatus(listener: (state: { status: string }) => void): () => void;
  getLastServerInfoMessage(): { features?: { directorySync?: boolean } } | null;
  observeAgents(options: Record<string, unknown>): Subscription;
  fetchAgents(options: Record<string, unknown>): Promise<AgentsPayload>;
}

const PAGE = 200;
const RETRY_MS = 2000;

const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

const time = (value: string | null | undefined) => (value ? Date.parse(value) || 0 : 0);
const isRunning = (agent: AgentSnapshotPayload) => agent.status === "running" || !!agent.activeTurn;

interface Member {
  fingerprint: string;
  version?: number;
  project?: Placement;
  activityAt: number;
  running: boolean;
  lastUserMessageAt: number;
  summary: AgentSummary;
}

/** A published summary changing; `previous` is null on first sight, `next` null on removal. */
export type Transition = (previous: AgentSummary | null, next: AgentSummary | null) => void;

/**
 * When the session was last *used*: the moment its most recent turn ended. It holds still while
 * a turn runs and ignores idle metadata changes, so the sidebar does not reshuffle mid-turn.
 * The daemon has no turn-end timestamp, so it is derived from observed transitions:
 *  - first sight, idle: updatedAt (the last change, normally the turn end);
 *  - first sight, running: the turn start, else the last user message;
 *  - running → idle: updatedAt at that moment;
 *  - idle, but a new user message appeared (a turn we missed while disconnected): updatedAt.
 */
export function activityAt(agent: AgentSnapshotPayload, previous?: Member): number {
  const running = isRunning(agent);
  const updated = time(agent.updatedAt);
  if (!previous)
    return running
      ? time(agent.activeTurn?.startedAt) || time(agent.lastUserMessageAt) || updated
      : updated;
  if (running) return previous.activityAt;
  if (previous.running) return Math.max(updated, previous.activityAt);
  if (time(agent.lastUserMessageAt) > previous.lastUserMessageAt)
    return Math.max(updated, previous.activityAt);
  return previous.activityAt;
}

export function summarize(
  hostId: string,
  agent: AgentSnapshotPayload,
  project?: Placement,
  activity = time(agent.updatedAt),
): AgentSummary {
  const permissions = (agent.pendingPermissions ?? []) as unknown as Permission[];
  return {
    key: `${hostId}:${agent.id}`,
    hostId,
    id: agent.id,
    title: agent.title ?? null,
    status: agent.status,
    provider: agent.provider,
    cwd: agent.cwd,
    project: project?.projectName || basename(agent.cwd) || "Other",
    projectKey: project?.projectKey ?? null,
    activityAt: activity,
    attention: permissions.length > 0 || agent.requiresAttention === true,
    pendingPermissions: permissions,
  };
}

/**
 * Mirrors one daemon's active agent directory into the shared collection. After the first
 * snapshot it consumes only `agent_update` deltas; reconnects resume from the daemon's
 * directory-sync cursor, so steady-state cost is proportional to changes.
 */
export class HostDirectory {
  private cursor: SyncCursor | undefined;
  /** agent id → fingerprint of the published summary and its sync version. */
  private readonly members = new Map<string, Member>();
  private subscription: Subscription | null = null;
  private token = 0;
  private stopStatus: (() => void) | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  /** Agents touched by live updates while a paged (non-sync) snapshot is being read. */
  private liveTouched: Set<string> | null = null;

  private readonly hostId: string;
  private readonly driver: DirectoryDriver;
  private readonly collection: VersionedCollection<AgentSummary>;
  private readonly changed: () => void;

  private readonly transition: Transition;

  constructor(
    hostId: string,
    driver: DirectoryDriver,
    collection: VersionedCollection<AgentSummary>,
    changed: () => void,
    transition: Transition = () => {},
  ) {
    this.hostId = hostId;
    this.driver = driver;
    this.collection = collection;
    this.changed = changed;
    this.transition = transition;
  }

  start() {
    this.stopStatus = this.driver.subscribeConnectionStatus((state) => this.onStatus(state.status));
    this.onStatus(this.driver.getConnectionState().status);
  }

  dispose() {
    this.close();
    this.stopStatus?.();
    for (const [id, member] of this.members) {
      this.collection.delete(this.key(id));
      this.transition(member.summary, null);
    }
    if (this.members.size) this.changed();
    this.members.clear();
  }

  private key(id: string) {
    return `${this.hostId}:${id}`;
  }

  private onStatus(status: string) {
    if (status === "connected") {
      if (!this.subscription) this.open();
    } else this.close();
  }

  private open() {
    clearTimeout(this.retry);
    const token = ++this.token;
    const sync = this.driver.getLastServerInfoMessage()?.features?.directorySync === true;
    const subscription = this.driver.observeAgents(
      sync
        ? { scope: "active", sync: this.cursor ?? {} }
        : { scope: "active", page: { limit: PAGE } },
    );
    this.subscription = subscription;
    subscription.subscribe({
      snapshot: (payload) => {
        if (token === this.token) void this.onSnapshot(payload, token, sync).catch(() => this.fail(token));
      },
      update: (message) => {
        if (token === this.token && message.type === "agent_update")
          this.onUpdate(message.payload as AgentUpdate);
      },
      error: () => this.fail(token),
    });
  }

  private close() {
    this.token++;
    clearTimeout(this.retry);
    this.liveTouched = null;
    const subscription = this.subscription;
    this.subscription = null;
    void subscription?.release().catch(() => {});
  }

  private fail(token: number) {
    if (token !== this.token) return;
    this.close();
    this.cursor = undefined;
    this.retry = setTimeout(() => {
      if (!this.subscription && this.driver.getConnectionState().status === "connected") this.open();
    }, RETRY_MS);
    this.retry.unref?.();
  }

  private async onSnapshot(payload: AgentsPayload, token: number, sync: boolean) {
    if (payload.sync?.mode === "changes") {
      if (this.cursor?.generation !== payload.sync.generation) {
        // Changes relative to a cursor we no longer hold cannot be applied safely.
        this.cursor = undefined;
        this.close();
        this.open();
        return;
      }
      for (const entry of payload.entries)
        this.upsert(entry.agent, entry.syncSeq, false, entry.project);
      for (const removal of payload.sync.removals) this.remove(removal.id, removal.seq);
      this.cursor = { generation: payload.sync.generation, afterSeq: payload.sync.headSeq };
      return;
    }
    let entries = payload.entries;
    if (!sync && payload.pageInfo.hasMore) {
      // Daemons without directory sync: page once per connection, never again while connected.
      this.liveTouched = new Set();
      entries = [...entries];
      let next = payload.pageInfo.nextCursor;
      while (next) {
        const page = await this.driver.fetchAgents({
          scope: "active",
          page: { limit: PAGE, cursor: next },
        });
        if (token !== this.token) return;
        entries.push(...page.entries);
        next = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
      }
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      seen.add(entry.agent.id);
      this.upsert(entry.agent, sync ? entry.syncSeq : undefined, sync, entry.project);
    }
    for (const id of [...this.members.keys()])
      if (!seen.has(id) && !this.liveTouched?.has(id)) this.remove(id);
    this.liveTouched = null;
    this.cursor = payload.sync
      ? { generation: payload.sync.generation, afterSeq: payload.sync.headSeq }
      : undefined;
  }

  private onUpdate(update: AgentUpdate) {
    if (update.generation && this.cursor && update.generation !== this.cursor.generation) {
      // The daemon restarted its directory sequence underneath us: resubscribe from scratch.
      this.cursor = undefined;
      this.close();
      this.open();
      return;
    }
    const id = update.kind === "upsert" ? update.agent.id : update.agentId;
    this.liveTouched?.add(id);
    if (update.kind === "upsert") this.upsert(update.agent, update.seq, false, update.project);
    else this.remove(update.agentId, update.seq);
    if (update.seq !== undefined && this.cursor)
      this.cursor.afterSeq = Math.max(this.cursor.afterSeq, update.seq);
  }

  private upsert(
    agent: AgentSnapshotPayload,
    version?: number,
    force = false,
    placement?: Placement,
  ) {
    if (agent.archivedAt || agent.internal) return this.remove(agent.id, version, force);
    const member = this.members.get(agent.id);
    if (!force && member?.version !== undefined && version !== undefined && version < member.version)
      return;
    // An update without a placement keeps the project the agent was last seen in.
    const project = placement === undefined ? member?.project : placement;
    const activity = activityAt(agent, member);
    const summary = summarize(this.hostId, agent, project, activity);
    const fingerprint = JSON.stringify(summary);
    const next: Member = {
      fingerprint,
      version,
      project,
      activityAt: activity,
      running: isRunning(agent),
      lastUserMessageAt: time(agent.lastUserMessageAt),
      summary,
    };
    this.members.set(agent.id, next);
    if (member?.fingerprint === fingerprint) {
      next.summary = member.summary;
      return;
    }
    this.collection.set(summary.key, summary);
    this.changed();
    this.transition(member?.summary ?? null, summary);
  }

  private remove(id: string, version?: number, force = false) {
    const member = this.members.get(id);
    if (!member) return;
    if (!force && member.version !== undefined && version !== undefined && version < member.version)
      return;
    this.members.delete(id);
    this.collection.delete(this.key(id));
    this.changed();
    this.transition(member.summary, null);
  }
}
