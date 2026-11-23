import { messageDeliveryModes } from "./message-delivery.ts";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { deriveAgentStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentState, AgentSummary, EmptyProjectSummary, Permission, RewindMode, WorkspaceSummary } from "../shared/wire.ts";
import type { VersionedCollection } from "./versioned-collection.ts";

type SyncCursor = { generation: string; afterSeq: number };
type Placement = { projectKey: string; projectName: string } | null | undefined;
interface Payload {
  entries: unknown[];
  emptyProjects?: unknown[];
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
  getLastServerInfoMessage(): { features?: { directorySync?: boolean; projectCustomIcon?: boolean } } | null;
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
  /** Server-only facts kept per member (not published), e.g. agent capabilities. */
  retain?(raw: Raw): unknown;
}

interface Member<Extra, Memo, S> {
  fingerprint: string;
  version?: number;
  extra?: Extra;
  memo: Memo;
  summary: S;
  retained?: unknown;
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
  protected readonly hostId: string;
  private readonly driver: DirectoryDriver;
  private readonly collection: VersionedCollection<S>;
  protected readonly changed: () => void;
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

  /** What the adapter retained for a member, from the latest update; O(1). */
  protected retained(id: string): unknown {
    return this.members.get(id)?.retained;
  }

  start() {
    this.stopStatus = this.driver.subscribeConnectionStatus((state) => this.onStatus(state.status));
    this.onStatus(this.driver.getConnectionState().status);
  }

  dispose() {
    const released = this.close();
    this.stopStatus?.();
    for (const [id, member] of this.members) {
      this.collection.delete(this.key(id));
      this.transition(member.summary, null);
    }
    if (this.members.size) this.changed();
    this.members.clear();
    this.onDisposed();
    return released;
  }

  protected onSnapshotProcessed(_payload: Payload, _full: boolean) {}
  protected onRawUpdate(_payload: unknown) {}
  protected onDisposed() {}

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
        if (token === this.token && message.type === this.adapter.updateType) {
          this.onUpdate(this.adapter.update(message.payload));
          this.onRawUpdate(message.payload);
        }
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
    return subscription?.release().catch(() => {}) ?? Promise.resolve();
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
      // A live update may already have moved the cursor past the snapshot's head.
      this.cursor = { generation: payload.sync.generation, afterSeq: Math.max(this.cursor.afterSeq, payload.sync.headSeq) };
      this.onSnapshotProcessed(payload, false);
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
      const id = this.adapter.id(raw);
      seen.add(id);
      // Paged rows predate the live updates seen while paging: those win, deletions included.
      if (this.liveTouched?.has(id)) continue;
      this.upsert(raw, sync ? seq : undefined, sync, extra);
    }
    for (const id of [...this.members.keys()])
      if (!seen.has(id) && !this.liveTouched?.has(id)) this.remove(id);
    this.liveTouched = null;
    this.onSnapshotProcessed(payload, true);
    this.cursor = payload.sync
      ? {
          generation: payload.sync.generation,
          afterSeq: this.cursor?.generation === payload.sync.generation
            ? Math.max(this.cursor.afterSeq, payload.sync.headSeq)
            : payload.sync.headSeq,
        }
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
    // A versionless update keeps the version guard of the last versioned one.
    const next: Member<Extra, Memo, S> = { fingerprint, version: version ?? member?.version, extra: kept, memo, summary, retained: this.adapter.retain?.(raw) };
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
  const turnActive = isRunning(agent) || agent.status === "initializing";
  const parentAgentId = getParentAgentIdFromLabels(agent.labels);
  return {
    key: `${hostId}:${agent.id}`,
    hostId,
    id: agent.id,
    workspaceId: agent.workspaceId ?? null,
    title: agent.title ?? null,
    status: agent.status,
    turnActive,
    provider: agent.provider,
    deliveryModes: messageDeliveryModes(agent.provider),
    cwd: agent.cwd,
    project: project?.projectName || basename(agent.cwd) || "Other",
    projectKey: project?.projectKey ?? null,
    activityAt: activity,
    turnStartedAt: turnActive
      ? time(agent.activeTurn?.startedAt) || time(agent.lastUserMessageAt) || null
      : null,
    attention: state === "needs_input",
    state,
    unread: agent.requiresAttention === true && state !== "needs_input",
    lastError: agent.lastError ? agent.lastError.slice(0, 300) : null,
    pendingPermissions: permissions,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinking: agent.effectiveThinkingOptionId ?? agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    modeId: agent.currentModeId ?? null,
    contextUsed: agent.lastUsage?.contextWindowUsedTokens ?? null,
    contextMax: agent.lastUsage?.contextWindowMaxTokens ?? null,
    ...(Array.isArray((agent as { sessionMetrics?: unknown }).sessionMetrics) && (agent as { sessionMetrics: unknown[] }).sessionMetrics.length
      ? { sessionMetrics: (agent as { sessionMetrics: AgentSummary["sessionMetrics"] }).sessionMetrics }
      : {}),
    rewind: rewindModes(agent.capabilities),
    ...(parentAgentId ? { parentAgentId } : {}),
  };
}

/** The rewind modes a provider supports, in Paseo's menu order. */
export function rewindModes(capabilities: AgentSnapshotPayload["capabilities"] | undefined): RewindMode[] {
  const c = (capabilities ?? {}) as Record<string, unknown>;
  const modes: RewindMode[] = [];
  if (c.supportsRewindConversation === true) modes.push("conversation");
  if (c.supportsRewindFiles === true) modes.push("files");
  if (c.supportsRewindBoth === true) modes.push("both");
  return modes;
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
  retain: (agent): AgentFacts => ({
    provider: agent.provider,
    capabilities: agent.capabilities,
    availableModes: agent.availableModes ?? [],
    features: agent.features ?? [],
  }),
};

/** Kept from the latest directory update so requests need no daemon round trip. */
export interface AgentFacts {
  provider: string;
  capabilities: AgentSnapshotPayload["capabilities"];
  availableModes: NonNullable<AgentSnapshotPayload["availableModes"]>;
  features: NonNullable<AgentSnapshotPayload["features"]>;
}

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
  /** Provider and capabilities from the live directory; undefined if the agent is not listed. */
  facts(agentId: string) {
    return this.retained(agentId) as AgentFacts | undefined;
  }
}

// ---- Workspaces --------------------------------------------------------------------------------

/** The fields of Paseo's workspace descriptor the console uses. */
export interface WorkspaceDescriptor {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectCustomName?: string | null;
  projectCustomIconRevision?: string | null;
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
  labels?: string[];
  diffStat?: { additions: number; deletions: number } | null;
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
    projectId: ws.projectId,
    projectCustomName: ws.projectCustomName ?? null,
    projectIconRevision: ws.projectCustomIconRevision ?? null,
    rootPath: ws.projectRootPath,
    directory: ws.workspaceDirectory ?? ws.projectRootPath,
    kind: ws.workspaceKind,
    branch: ws.gitRuntime?.currentBranch ?? null,
    pinnedAt: time(ws.pinnedAt),
    activityAt: activity,
    state,
    attention: state === "needs_input",
    unread: state === "unread" || state === "failed",
    ...(ws.labels?.length ? { labels: ws.labels } : {}),
    ...(ws.diffStat ? { diffStat: ws.diffStat } : {}),
  };
}

/** A project parent with zero active workspaces, as reported by the daemon. */
export interface EmptyProjectDescriptor {
  projectId: string;
  projectKey?: string;
  projectDisplayName: string;
  projectCustomName?: string | null;
  projectCustomIconRevision?: string | null;
  projectIconRevision?: string;
  projectRootPath: string;
  projectKind: string;
}

export function summarizeEmptyProject(hostId: string, p: EmptyProjectDescriptor): EmptyProjectSummary {
  return {
    key: `${hostId}:${p.projectId}`,
    hostId,
    projectId: p.projectId,
    projectKey: p.projectKey ?? p.projectId,
    name: p.projectCustomName || p.projectDisplayName || basename(p.projectRootPath) || "Other",
    customName: p.projectCustomName ?? null,
    iconRevision: p.projectCustomIconRevision ?? p.projectIconRevision ?? null,
    rootPath: p.projectRootPath,
    kind: p.projectKind,
  };
}

export type ProjectUpdatePayload =
  | { kind: "upsert"; project: EmptyProjectDescriptor }
  | { kind: "remove"; projectId: string };

type WorkspaceUpdate =
  | { kind: "upsert"; workspace: WorkspaceDescriptor; generation?: string; seq?: number }
  | { kind: "remove"; id: string; emptyProject?: EmptyProjectDescriptor; removedProjectId?: string; generation?: string; seq?: number };

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

/** One daemon's workspaces (Paseo's threads) and projects with zero active workspaces. */
export class HostWorkspaces extends HostMirror<WorkspaceDescriptor, undefined, ActivityMemo, WorkspaceSummary> {
  private readonly emptyProjects?: VersionedCollection<EmptyProjectSummary>;
  private readonly activeByProject = new Map<string, Set<string>>();
  private readonly emptyMembers = new Map<string, { fingerprint: string; summary: EmptyProjectSummary }>();

  constructor(
    hostId: string,
    driver: DirectoryDriver,
    collection: VersionedCollection<WorkspaceSummary>,
    changed: () => void,
    emptyProjects?: VersionedCollection<EmptyProjectSummary>,
  ) {
    super(workspaceAdapter, hostId, driver, collection, changed, (previous, next) => this.trackProject(previous, next));
    this.emptyProjects = emptyProjects;
  }

  private trackProject(previous: WorkspaceSummary | null, next: WorkspaceSummary | null) {
    if (previous && previous.projectId !== next?.projectId) {
      const set = this.activeByProject.get(previous.projectId);
      if (set) {
        set.delete(previous.id);
        if (!set.size) this.activeByProject.delete(previous.projectId);
      }
    }
    if (next && next.projectId) {
      let set = this.activeByProject.get(next.projectId);
      if (!set) this.activeByProject.set(next.projectId, (set = new Set()));
      set.add(next.id);
      this.removeEmpty(next.projectId);
    }
  }

  private upsertEmpty(descriptor: EmptyProjectDescriptor) {
    if (!this.emptyProjects || this.activeByProject.has(descriptor.projectId)) return;
    const summary = summarizeEmptyProject(this.hostId, descriptor);
    const fingerprint = JSON.stringify(summary);
    const existing = this.emptyMembers.get(descriptor.projectId);
    if (existing?.fingerprint === fingerprint) return;
    this.emptyMembers.set(descriptor.projectId, { fingerprint, summary });
    this.emptyProjects.set(summary.key, summary);
    this.changed();
  }

  private removeEmpty(projectId: string) {
    if (!this.emptyProjects) return;
    const existing = this.emptyMembers.get(projectId);
    if (!existing) return;
    this.emptyMembers.delete(projectId);
    this.emptyProjects.delete(existing.summary.key);
    this.changed();
  }

  onProjectUpdate(payload: ProjectUpdatePayload) {
    if (payload.kind === "remove") this.removeEmpty(payload.projectId);
    else if (payload.kind === "upsert") this.upsertEmpty(payload.project);
  }

  protected override onSnapshotProcessed(payload: Payload, full: boolean) {
    if (!this.emptyProjects) return;
    const list = Array.isArray(payload.emptyProjects) ? (payload.emptyProjects as EmptyProjectDescriptor[]) : null;
    if (!full) {
      if (list) for (const p of list) this.upsertEmpty(p);
      return;
    }
    const seen = new Set<string>();
    if (list) {
      for (const p of list) {
        if (this.activeByProject.has(p.projectId)) continue;
        seen.add(p.projectId);
        this.upsertEmpty(p);
      }
    }
    for (const projectId of [...this.emptyMembers.keys()])
      if (!seen.has(projectId)) this.removeEmpty(projectId);
  }

  protected override onRawUpdate(payload: unknown) {
    const update = payload as WorkspaceUpdate | undefined;
    if (!update || update.kind !== "remove") return;
    if (update.removedProjectId) this.removeEmpty(update.removedProjectId);
    else if (update.emptyProject) this.upsertEmpty(update.emptyProject);
  }

  protected override onDisposed() {
    if (this.emptyProjects && this.emptyMembers.size) {
      for (const member of this.emptyMembers.values()) this.emptyProjects.delete(member.summary.key);
      this.changed();
    }
    this.emptyMembers.clear();
    this.activeByProject.clear();
  }
}
