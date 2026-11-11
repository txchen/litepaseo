import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { deriveAgentStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { AgentState, AgentSummary, Permission, WorkspaceSummary } from "../shared/wire.ts";
import type { VersionedCollection } from "./versioned-collection.ts";

type SyncCursor = { generation: string; afterSeq: number };
type Placement = { projectKey: string; projectName: string } | null | undefined;
interface Payload {
  entries: unknown[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
  sync?: {
    generation: string;
    headSeq: number;
    mode: "snapshot" | "changes";
    removals: { id: string; seq: number }[];
  };
}
interface Subscription {
  subscribe(observer: {
    snapshot(payload: Payload): void;
    update(message: { type: string; payload?: unknown }): void;
    error?(error: unknown): void;
  }): () => void;
  release(): Promise<void>;
}

/** The DaemonClient surface the directories need; kept narrow so tests can supply a double. */
export interface DirectoryDriver {
  getConnectionState(): { status: string };
  subscribeConnectionStatus(listener: (state: { status: string }) => void): () => void;
  getLastServerInfoMessage(): { features?: { directorySync?: boolean } } | null;
  observeAgents(options: Record<string, unknown>): Subscription;
  fetchAgents(options: Record<string, unknown>): Promise<Payload>;
  observeWorkspaces?(options: Record<string, unknown>): Subscription;
  fetchWorkspaces?(options: Record<string, unknown>): Promise<Payload>;
}

const PAGE = 200;
const RETRY_MS = 2000;

const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;
const time = (value: string | null | undefined) => (value ? Date.parse(value) || 0 : 0);

/** A published summary changing; `previous` is null on first sight, `next` null on removal. */
export type Transition<S> = (previous: S | null, next: S | null) => void;

type Upsert<Raw, Extra> = { kind: "upsert"; raw: Raw; extra?: Extra; generation?: string; seq?: number };
type Remove = { kind: "remove"; id: string; generation?: string; seq?: number };

/** What differs between mirrored daemon directories (agents, workspaces). */
interface Adapter<Raw, Extra, Memo, S extends { key: string }> {
  updateType: string;
  base: Record<string, unknown>;
  observe(driver: DirectoryDriver, options: Record<string, unknown>): Subscription;
  fetch(driver: DirectoryDriver, options: Record<string, unknown>): Promise<Payload>;
  entry(entry: unknown): { raw: Raw; seq?: number; extra?: Extra };
  update(payload: unknown): Upsert<Raw, Extra> | Remove;
  id(raw: Raw): string;
  excluded(raw: Raw): boolean;
  summarize(hostId: string, raw: Raw, extra: Extra | undefined, previous?: Memo): { summary: S; memo: Memo };
}

interface Member<Extra, Memo, S> {
  fingerprint: string;
  version?: number;
  extra?: Extra;
  memo: Memo;
  summary: S;
}

/**
 * Mirrors one daemon directory into a shared collection. After the first snapshot it consumes
 * only update deltas; reconnects resume from the daemon's directory-sync cursor, so
 * steady-state cost is proportional to changes. Summaries that did not change are dropped.
 */
class HostMirror<Raw, Extra, Memo, S extends { key: string }> {
  private cursor: SyncCursor | undefined;
  private readonly members = new Map<string, Member<Extra, Memo, S>>();
  private subscription: Subscription | null = null;
  private token = 0;
  private stopStatus: (() => void) | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  /** Items touched by live updates while a paged (non-sync) snapshot is being read. */
  private liveTouched: Set<string> | null = null;
  private readonly adapter: Adapter<Raw, Extra, Memo, S>;
  private readonly hostId: string;
  private readonly driver: DirectoryDriver;
  private readonly collection: VersionedCollection<S>;
  private readonly changed: () => void;
  private readonly transition: Transition<S>;

  constructor(
    adapter: Adapter<Raw, Extra, Memo, S>,
    hostId: string,
    driver: DirectoryDriver,
    collection: VersionedCollection<S>,
    changed: () => void,
    transition: Transition<S> = () => {},
  ) {
    this.adapter = adapter;
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
    const { base } = this.adapter;
    const subscription = this.adapter.observe(
      this.driver,
      sync ? { ...base, sync: this.cursor ?? {} } : { ...base, page: { limit: PAGE } },
    );
    this.subscription = subscription;
    subscription.subscribe({
      snapshot: (payload) => {
        if (token === this.token) void this.onSnapshot(payload, token, sync).catch(() => this.fail(token));
      },
      update: (message) => {
        if (token === this.token && message.type === this.adapter.updateType)
          this.onUpdate(this.adapter.update(message.payload));
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

  private async onSnapshot(payload: Payload, token: number, sync: boolean) {
    if (payload.sync?.mode === "changes") {
      if (this.cursor?.generation !== payload.sync.generation) {
        // Changes relative to a cursor we no longer hold cannot be applied safely.
        this.cursor = undefined;
        this.close();
        this.open();
        return;
      }
      for (const e of payload.entries) {
        const { raw, seq, extra } = this.adapter.entry(e);
        this.upsert(raw, seq, false, extra);
      }
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
        const page = await this.adapter.fetch(this.driver, { ...this.adapter.base, page: { limit: PAGE, cursor: next } });
        if (token !== this.token) return;
        entries.push(...page.entries);
        next = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
      }
    }
    const seen = new Set<string>();
    for (const e of entries) {
      const { raw, seq, extra } = this.adapter.entry(e);
      seen.add(this.adapter.id(raw));
      this.upsert(raw, sync ? seq : undefined, sync, extra);
    }
    for (const id of [...this.members.keys()])
      if (!seen.has(id) && !this.liveTouched?.has(id)) this.remove(id);
    this.liveTouched = null;
    this.cursor = payload.sync
      ? { generation: payload.sync.generation, afterSeq: payload.sync.headSeq }
      : undefined;
  }

  private onUpdate(update: Upsert<Raw, Extra> | Remove) {
    if (update.generation && this.cursor && update.generation !== this.cursor.generation) {
      // The daemon restarted its directory sequence underneath us: resubscribe from scratch.
      this.cursor = undefined;
      this.close();
      this.open();
      return;
    }
    const id = update.kind === "upsert" ? this.adapter.id(update.raw) : update.id;
    this.liveTouched?.add(id);
    if (update.kind === "upsert") this.upsert(update.raw, update.seq, false, update.extra);
    else this.remove(update.id, update.seq);
    if (update.seq !== undefined && this.cursor)
      this.cursor.afterSeq = Math.max(this.cursor.afterSeq, update.seq);
  }

  private upsert(raw: Raw, version?: number, force = false, extra?: Extra) {
    const id = this.adapter.id(raw);
    if (this.adapter.excluded(raw)) return this.remove(id, version, force);
    const member = this.members.get(id);
    if (!force && member?.version !== undefined && version !== undefined && version < member.version)
      return;
    // An update without extra context (e.g. project placement) keeps the last one seen.
    const kept = extra === undefined ? member?.extra : extra;
    const { summary, memo } = this.adapter.summarize(this.hostId, raw, kept, member?.memo);
    const fingerprint = JSON.stringify(summary);
    const next: Member<Extra, Memo, S> = { fingerprint, version, extra: kept, memo, summary };
    this.members.set(id, next);
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

// ---- Agents ------------------------------------------------------------------------------------

const isRunning = (agent: AgentSnapshotPayload) => agent.status === "running" || !!agent.activeTurn;

/** Activity bookkeeping kept between observations of one session. */
export interface ActivityMemo {
  activityAt: number;
  running: boolean;
  lastUserMessageAt: number;
}

/**
 * When the session was last *used*: the moment its most recent turn ended. It holds still while
 * a turn runs and ignores idle metadata changes, so the sidebar does not reshuffle mid-turn.
 * The daemon has no turn-end timestamp, so it is derived from observed transitions:
 *  - first sight, idle: the last change (normally the turn end);
 *  - first sight, running: the turn start, else the last user message;
 *  - running → idle: the change time at that moment;
 *  - idle, but a new user message appeared (a turn we missed while disconnected): the change time.
 */
export function deriveActivity(
  current: { running: boolean; changedAt: number; startedAt: number; lastUserMessageAt: number },
  previous?: ActivityMemo,
): ActivityMemo {
  const memo = (activityAt: number) => ({
    activityAt,
    running: current.running,
    lastUserMessageAt: current.lastUserMessageAt,
  });
  if (!previous)
    return memo(current.running ? current.startedAt || current.lastUserMessageAt || current.changedAt : current.changedAt);
  if (current.running) return memo(previous.activityAt);
  if (previous.running || current.lastUserMessageAt > previous.lastUserMessageAt)
    return memo(Math.max(current.changedAt, previous.activityAt));
  return memo(previous.activityAt);
}

export function summarize(
  hostId: string,
  agent: AgentSnapshotPayload,
  project?: Placement,
  activity = time(agent.updatedAt),
): AgentSummary {
  const permissions = (agent.pendingPermissions ?? []) as unknown as Permission[];
  const bucket = deriveAgentStateBucket({
    status: agent.status,
    pendingPermissionCount: permissions.length,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
  });
  const state: AgentState =
    agent.status === "initializing" && bucket === "done"
      ? "running"
      : bucket === "attention"
        ? "unread"
        : bucket;
  return {
    key: `${hostId}:${agent.id}`,
    hostId,
    id: agent.id,
    workspaceId: agent.workspaceId ?? null,
    title: agent.title ?? null,
    status: agent.status,
    provider: agent.provider,
    cwd: agent.cwd,
    project: project?.projectName || basename(agent.cwd) || "Other",
    projectKey: project?.projectKey ?? null,
    activityAt: activity,
    attention: state === "needs_input",
    state,
    unread: agent.requiresAttention === true && state !== "needs_input",
    lastError: agent.lastError ? agent.lastError.slice(0, 300) : null,
    pendingPermissions: permissions,
  };
}

type AgentEntry = { agent: AgentSnapshotPayload; project?: Placement; syncSeq?: number };
type AgentUpdate =
  | { kind: "upsert"; agent: AgentSnapshotPayload; project?: Placement; generation?: string; seq?: number }
  | { kind: "remove"; agentId: string; generation?: string; seq?: number };

const agentAdapter: Adapter<AgentSnapshotPayload, Placement, ActivityMemo, AgentSummary> = {
  updateType: "agent_update",
  base: { scope: "active" },
  observe: (driver, options) => driver.observeAgents(options),
  fetch: (driver, options) => driver.fetchAgents(options),
  entry: (e) => {
    const entry = e as AgentEntry;
    return { raw: entry.agent, seq: entry.syncSeq, extra: entry.project };
  },
  update: (p) => {
    const u = p as AgentUpdate;
    return u.kind === "upsert"
      ? { kind: "upsert", raw: u.agent, extra: u.project, generation: u.generation, seq: u.seq }
      : { kind: "remove", id: u.agentId, generation: u.generation, seq: u.seq };
  },
  id: (agent) => agent.id,
  excluded: (agent) => !!agent.archivedAt || !!agent.internal,
  summarize: (hostId, agent, project, previous) => {
    const memo = deriveActivity(
      {
        running: isRunning(agent),
        changedAt: time(agent.updatedAt),
        startedAt: time(agent.activeTurn?.startedAt),
        lastUserMessageAt: time(agent.lastUserMessageAt),
      },
      previous,
    );
    return { summary: summarize(hostId, agent, project, memo.activityAt), memo };
  },
};

/** One daemon's active agents. */
export class HostDirectory extends HostMirror<AgentSnapshotPayload, Placement, ActivityMemo, AgentSummary> {
  constructor(
    hostId: string,
    driver: DirectoryDriver,
    collection: VersionedCollection<AgentSummary>,
    changed: () => void,
    transition?: Transition<AgentSummary>,
  ) {
    super(agentAdapter, hostId, driver, collection, changed, transition);
  }
}

// ---- Workspaces --------------------------------------------------------------------------------

/** The fields of Paseo's workspace descriptor the console uses. */
export interface WorkspaceDescriptor {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  workspaceKind: string;
  name: string;
  title?: string | null;
  pinnedAt?: string | null;
  internal?: boolean;
  background?: boolean;
  archivingAt?: string | null;
  status: "needs_input" | "failed" | "running" | "attention" | "done";
  statusEnteredAt?: string | null;
  activityAt: string | null;
  createdAt?: string;
  lastUserMessageAt?: string | null;
  gitRuntime?: { currentBranch?: string | null } | null;
  project?: { projectKey: string; projectName: string } | null;
  syncSeq?: number;
}

/**
 * A workspace (a "thread" in Paseo's sidebar). Its state is the daemon's own aggregate over the
 * workspace's agents; recency follows the same turn-end rule as agents.
 */
export function summarizeWorkspace(hostId: string, ws: WorkspaceDescriptor, activity: number): WorkspaceSummary {
  const state: AgentState = ws.status === "attention" ? "unread" : ws.status;
  return {
    key: `${hostId}:${ws.id}`,
    hostId,
    id: ws.id,
    name: ws.name,
    title: ws.title ?? null,
    project: ws.project?.projectName || ws.projectDisplayName || basename(ws.projectRootPath) || "Other",
    projectKey: ws.project?.projectKey ?? ws.projectId,
    rootPath: ws.projectRootPath,
    directory: ws.workspaceDirectory ?? ws.projectRootPath,
    kind: ws.workspaceKind,
    branch: ws.gitRuntime?.currentBranch ?? null,
    pinnedAt: time(ws.pinnedAt),
    activityAt: activity,
    state,
    attention: state === "needs_input",
    unread: state === "unread" || state === "failed",
  };
}

type WorkspaceUpdate =
  | { kind: "upsert"; workspace: WorkspaceDescriptor; generation?: string; seq?: number }
  | { kind: "remove"; id: string; generation?: string; seq?: number };

const workspaceAdapter: Adapter<WorkspaceDescriptor, undefined, ActivityMemo, WorkspaceSummary> = {
  updateType: "workspace_update",
  base: {},
  observe: (driver, options) => {
    if (!driver.observeWorkspaces) throw new Error("Workspaces unsupported");
    return driver.observeWorkspaces(options);
  },
  fetch: (driver, options) => {
    if (!driver.fetchWorkspaces) throw new Error("Workspaces unsupported");
    return driver.fetchWorkspaces(options);
  },
  entry: (e) => {
    const ws = e as WorkspaceDescriptor;
    return { raw: ws, seq: ws.syncSeq };
  },
  update: (p) => {
    const u = p as WorkspaceUpdate;
    return u.kind === "upsert"
      ? { kind: "upsert", raw: u.workspace, generation: u.generation, seq: u.seq }
      : { kind: "remove", id: u.id, generation: u.generation, seq: u.seq };
  },
  id: (ws) => ws.id,
  excluded: (ws) => !!ws.archivingAt || !!ws.internal || !!ws.background,
  summarize: (hostId, ws, _extra, previous) => {
    const memo = deriveActivity(
      {
        running: ws.status === "running",
        changedAt: time(ws.statusEnteredAt) || time(ws.activityAt),
        startedAt: ws.status === "running" ? time(ws.statusEnteredAt) : 0,
        lastUserMessageAt: time(ws.lastUserMessageAt),
      },
      previous,
    );
    // A workspace first seen idle sorts by the daemon's own activity time; one first seen
    // running sorts by when its turn started (its activity time moves while it works).
    const activity =
      previous || ws.status === "running"
        ? memo.activityAt
        : time(ws.activityAt) || memo.activityAt || time(ws.createdAt);
    return { summary: summarizeWorkspace(hostId, ws, activity), memo: { ...memo, activityAt: activity } };
  },
};

/** One daemon's workspaces (Paseo's threads). */
export class HostWorkspaces extends HostMirror<WorkspaceDescriptor, undefined, ActivityMemo, WorkspaceSummary> {
  constructor(hostId: string, driver: DirectoryDriver, collection: VersionedCollection<WorkspaceSummary>, changed: () => void) {
    super(workspaceAdapter, hostId, driver, collection, changed);
  }
}
