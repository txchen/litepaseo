import { notifyListeners } from "./listeners.ts";
import { connectionProblem } from "./diagnostics.ts";
import { createHostClient } from "@getpaseo/client/node";
import { createPaseoApi } from "@getpaseo/client";
import type { Host } from "./store.ts";
import type { AgentState, AgentSummary, EmptyProjectSummary, WorkspaceSummary, HostDiagnostic, TimelineOp } from "../shared/wire.ts";
import { VersionedCollection } from "./versioned-collection.ts";
import { deriveWorkspaceAgentState, HostDirectory, HostWorkspaces, type DirectoryDriver, type ProjectUpdatePayload, type Transition } from "./host-directory.ts";
import { TimelineView, type TimelineDriver, type TimelineResume } from "./timeline-view.ts";
import { HostSubagents, type SubagentDriver } from "./subagents.ts";
import { HostBackgroundWork, type BackgroundWorkDriver } from "./background-work.ts";
import type { AgentBackgroundWorkItem, ProviderSubagent } from "../shared/wire.ts";
import { HostLiveness, forceReconnect, type LivenessDriver } from "./host-liveness.ts";
import { logEvent } from "./log-event.ts";

type Driver = ReturnType<typeof createHostClient>;

export class UnknownHostError extends Error {
  constructor() {
    super("Unknown host");
  }
}
type Api = ReturnType<typeof createPaseoApi>;
interface Client {
  driver: Driver;
  api: Api;
  directory: HostDirectory;
  workspaces: HostWorkspaces;
  subagents: HostSubagents;
  backgroundWork: HostBackgroundWork;
  liveness?: HostLiveness;
  stopStatus: () => void;
  stopProjects?: () => void;
}

/**
 * Idle grace before an unwatched timeline releases its daemon subscription. Browsers keep
 * recently opened conversations and come back to them; while the view lives, coming back
 * costs only the rows that changed meanwhile, not a reload from the daemon.
 */
const TIMELINE_GRACE_MS = 5 * 60_000;
/** Conversation opens slower than this are logged with a per-layer breakdown. */
const SLOW_TIMELINE_MS = 3000;
/** A viewer still without rows after this long has the daemon checked for a silent connection. */
const LIVENESS_CHECK_MS = 2000;
/** How long a conversation snapshot waits for the host before giving up. */
const SNAPSHOT_TIMEOUT_MS = 45_000;

export class TimelineTimeoutError extends Error {
  constructor() {
    super("The host did not load this conversation in time.");
  }
}

export class Hosts {
  readonly agents = new VersionedCollection<AgentSummary>();
  readonly workspaces = new VersionedCollection<WorkspaceSummary>();
  readonly emptyProjects = new VersionedCollection<EmptyProjectSummary>();
  readonly clients = new Map<string, Client>();
  private readonly diagnostics = new Map<string, HostDiagnostic>();
  private readonly labels = new Map<string, string>();
  private readonly timelines = new Map<
    string,
    { view: TimelineView; hostId: string; fresh: boolean; idle?: ReturnType<typeof setTimeout> }
  >();
  private readonly agentListeners = new Set<() => void>();
  private readonly hostListeners = new Set<() => void>();
  private readonly transitionListeners = new Set<Transition<AgentSummary>>();

  add(host: Host) {
    this.assertDetached(host.id);
    const driver = createHostClient(host.connection, {
      clientId: `litepaseo-${host.id}`,
      clientType: "cli",
      connectTimeoutMs: 5000,
      reconnect: { enabled: true },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    this.labels.set(host.id, host.label);
    this.attach(host.id, driver, createPaseoApi(driver));
    void driver.connect().catch(error => {
      if (this.clients.get(host.id)?.driver !== driver) return;
      this.noteFailure(host.id, error);
      this.emit(this.hostListeners);
    });
  }

  /** Wires a connected-or-connecting driver; separate from `add` so tests can inject doubles. */
  attach(hostId: string, driver: Driver, api: Api) {
    this.assertDetached(hostId);
    const agentsByWorkspace = new Map<string, Map<string, AgentSummary>>();
    const workspaceAgentState = (workspaceId: string): AgentState | null => {
      const bucket = agentsByWorkspace.get(workspaceId);
      return bucket ? deriveWorkspaceAgentState(bucket) : null;
    };
    const workspaces = new HostWorkspaces(
      hostId,
      driver as unknown as DirectoryDriver,
      this.workspaces,
      () => this.emit(this.agentListeners),
      this.emptyProjects,
      workspaceAgentState,
    );
    const directory = new HostDirectory(
      hostId,
      driver as unknown as DirectoryDriver,
      this.agents,
      () => this.emit(this.agentListeners),
      (previous, next) => {
        const touchedWorkspaces = new Set<string>();
        const workspaceChanged = !previous || !next || previous.workspaceId !== next.workspaceId;
        const stateChanged =
          workspaceChanged ||
          previous.parentAgentId !== next.parentAgentId ||
          previous.state !== next.state ||
          previous.unread !== next.unread ||
          previous.turnActive !== next.turnActive ||
          previous.status !== next.status;
        if (workspaceChanged && previous?.workspaceId) {
          const bucket = agentsByWorkspace.get(previous.workspaceId);
          if (bucket) {
            bucket.delete(previous.id);
            if (!bucket.size) agentsByWorkspace.delete(previous.workspaceId);
          }
          touchedWorkspaces.add(previous.workspaceId);
        }
        if (next?.workspaceId) {
          let bucket = agentsByWorkspace.get(next.workspaceId);
          if (!bucket) agentsByWorkspace.set(next.workspaceId, (bucket = new Map()));
          bucket.set(next.id, next);
          if (stateChanged) touchedWorkspaces.add(next.workspaceId);
        }
        for (const workspaceId of touchedWorkspaces) workspaces.reconcile(workspaceId);
        if (next) {
          const view = this.timelines.get(next.key)?.view;
          if (view) {
            const running = next.turnActive === true || next.state === "running" || next.status === "running" || next.status === "initializing";
            view.setActive(running);
            if (!running && previous && (previous.activityAt !== next.activityAt || previous.state !== next.state)) {
              view.wake();
            }
          }
        }
        notifyListeners(this.transitionListeners, previous, next);
      },
      () => this.emit(this.hostListeners),
    );
    const update = (state: ReturnType<Driver["getConnectionState"]>) => {
      const previous = this.diagnostics.get(hostId) ?? {};
      if (state.status === "connected") {
        if (previous.error) logEvent("host_reconnected", { hostId, after: previous.error.code });
        this.diagnostics.set(hostId, { lastConnectedAt: new Date().toISOString() });
        this.clients.get(hostId)?.backgroundWork.reconnect();
        for (const entry of this.timelines.values()) {
          if (entry.hostId === hostId && entry.view.watcherCount > 0) entry.view.wake();
        }
      }
      else if (state.status === "connecting") this.diagnostics.set(hostId, { ...previous, nextRetryAt: undefined, attempt: state.attempt });
      else if (state.status === "disconnected") {
        this.noteFailure(hostId, state);
        const retry = state.nextRetryAt && Date.parse(state.nextRetryAt);
        this.diagnostics.set(hostId, { ...this.diagnostics.get(hostId), nextRetryAt: retry && Number.isFinite(retry) ? new Date(retry).toISOString() : undefined });
      }
      this.emit(this.hostListeners);
    };
    const stopStatus = driver.subscribeConnectionStatus(update);
    update(driver.getConnectionState());
    const subagents = new HostSubagents(driver as unknown as SubagentDriver);
    const backgroundWork = new HostBackgroundWork(driver as unknown as BackgroundWorkDriver);
    const liveness = typeof (driver as unknown as Partial<LivenessDriver>).ping === "function"
      ? new HostLiveness(driver as unknown as LivenessDriver, hostId, () => forceReconnect(driver))
      : undefined;
    const stopProjects = typeof api.projects?.subscribe === "function"
      ? api.projects.subscribe((payload) => workspaces.onProjectUpdate(payload as ProjectUpdatePayload))
      : undefined;
    this.clients.set(hostId, { driver, api, directory, workspaces, subagents, backgroundWork, liveness, stopStatus, stopProjects });
    directory.start();
    // Daemons that predate workspaces simply have none; agents still list.
    if ((driver as unknown as DirectoryDriver).observeWorkspaces) workspaces.start();
    this.emit(this.hostListeners);
  }

  /**
   * A host is wired once: attaching over a live client would leak its connection, directory
   * subscriptions and status listener. Replacing one means `await remove(id)` first.
   */
  private assertDetached(hostId: string) {
    if (this.clients.has(hostId)) throw new Error(`Host ${hostId} is already attached; remove it first`);
  }

  get(id: string) {
    const c = this.clients.get(id);
    if (!c) throw new UnknownHostError();
    return c;
  }

  diagnostic(id: string) { return this.diagnostics.get(id); }

  private noteFailure(id: string, failure: unknown) {
    const error = connectionProblem(failure);
    const previous = this.diagnostics.get(id) ?? {};
    if (previous.error?.code !== error.code) logEvent("host_connection_failed", { hostId: id, code: error.code });
    this.diagnostics.set(id, { ...previous, error });
  }

  state(id: string) {
    return this.clients.get(id)?.driver.getConnectionState().status ?? "offline";
  }

  async remove(id: string) {
    const c = this.clients.get(id);
    this.clients.delete(id);
    const releases: Promise<void>[] = [];
    for (const [key, entry] of this.timelines)
      if (entry.hostId === id) {
        clearTimeout(entry.idle);
        releases.push(entry.view.dispose());
        this.timelines.delete(key);
      }
    try {
      if (c) {
        // No status change may reconnect or report on a host that is going away.
        c.stopStatus();
        c.stopProjects?.();
        const settled = [
          ...(await Promise.allSettled([...releases, c.directory.dispose(), c.workspaces.dispose(), c.subagents.dispose(), c.backgroundWork?.dispose()])),
          ...(await Promise.allSettled([c.api.dispose()])),
          ...(await Promise.allSettled([c.driver.close()])),
        ];
        for (const result of settled)
          if (result.status === "rejected") logEvent("host_dispose_failed", { hostId: id, message: (result.reason as Error)?.message });
      } else await Promise.allSettled(releases);
    } finally {
      this.diagnostics.delete(id);
      this.labels.delete(id);
      this.emit(this.hostListeners);
    }
  }

  async close() {
    await Promise.allSettled([...this.clients.keys()].map((id) => this.remove(id)));
  }

  onAgentsChanged(listener: () => void) {
    this.agentListeners.add(listener);
    return () => this.agentListeners.delete(listener);
  }

  /** Per-agent summary changes, for event detection (notifications). */
  onTransition(listener: Transition<AgentSummary>) {
    this.transitionListeners.add(listener);
    return () => this.transitionListeners.delete(listener);
  }

  /** Whether some browser is looking at this conversation right now. */
  isViewing(key: string) {
    return (this.timelines.get(key)?.view.watcherCount ?? 0) > 0;
  }

  label(hostId: string) {
    return this.labels.get(hostId) ?? "";
  }

  setLabel(hostId: string, label: string) {
    this.labels.set(hostId, label);
  }

  onHostsChanged(listener: () => void) {
    this.hostListeners.add(listener);
    return () => this.hostListeners.delete(listener);
  }

  /** Wakes a watched timeline view immediately (e.g. after sending a message or rewinding). */
  wakeTimeline(hostId: string, agentId: string, followUp = false) {
    const view = this.timelines.get(`${hostId}:${agentId}`)?.view;
    if (!view) return;
    view.wake(followUp);
  }

  /** The provider subagents of one agent, as they change. */
  watchSubagents(hostId: string, agentId: string, listener: (subagents: ProviderSubagent[]) => void) {
    let seen = new Set<string>();
    return this.get(hostId).subagents.watch(agentId, (subagents) => {
      const current = new Set<string>();
      for (const s of subagents) {
        current.add(s.id);
        const subView = this.timelines.get(`${hostId}:${agentId}:subagent:${s.id}`)?.view;
        if (subView) subView.setActive(s.status === "running");
      }
      for (const id of seen) {
        if (!current.has(id)) {
          const removedView = this.timelines.get(`${hostId}:${agentId}:subagent:${id}`)?.view;
          if (removedView) removedView.setActive(false);
        }
      }
      seen = current;
      listener(subagents);
    });
  }

  /** Background tasks and heartbeats of one agent, as they change. */
  watchBackgroundWork(hostId: string, agentId: string, listener: (items: AgentBackgroundWorkItem[]) => void) {
    return this.get(hostId).backgroundWork.watch(agentId, listener);
  }

  stopBackgroundWork(hostId: string, agentId: string, item: AgentBackgroundWorkItem) {
    return this.get(hostId).backgroundWork.stop(agentId, item);
  }

  /**
   * Shares one live timeline per agent across all watching browsers. With `subagentId`, the
   * conversation of one of the agent's provider subagents. With `since`, a browser that holds
   * the conversation resumes with what changed (see TimelineView.watch).
   */
  watchTimeline(hostId: string, agentId: string, watcher: Parameters<TimelineView["watch"]>[0], subagentId?: string, since?: TimelineResume) {
    const client = this.get(hostId);
    const key = subagentId ? `${hostId}:${agentId}:subagent:${subagentId}` : `${hostId}:${agentId}`;
    let entry = this.timelines.get(key);
    if (!entry) {
      const connection = client.driver.getConnectionState().status;
      const driver = subagentId
        ? client.subagents.timelineDriver(agentId, subagentId)
        : (client.driver as unknown as TimelineDriver);
      const view = new TimelineView(driver, agentId, (report) => {
        if (report.totalMs < SLOW_TIMELINE_MS) return;
        // Which layer a slow open spent its time in; no conversation content.
        logEvent("timeline_slow", { hostId, agentId, ...(subagentId ? { subagentId } : {}), connectionAtStart: connection ?? null, ...report });
      });
      const agent = subagentId ? undefined : this.agents.get(key);
      const running = subagentId
        ? client.subagents.statusOf(agentId, subagentId) === "running"
        : !!(agent && (agent.turnActive === true || agent.state === "running" || agent.status === "running" || agent.status === "initializing"));
      view.setActive(running);
      entry = { view, hostId, fresh: true };
      this.timelines.set(key, entry);
      view.start();
    }
    clearTimeout(entry.idle);
    entry.idle = undefined;
    // How long this viewer waits for rows, whatever the view was doing when it joined (the
    // view's own report covers fresh views only). A viewer that gives up waiting is logged too.
    const joinedAt = performance.now();
    const joined = { state: entry.view.status, fresh: entry.fresh, others: entry.view.watcherCount };
    entry.fresh = false;
    let waiting = true;
    const finishWait = (left: boolean) => {
      if (!waiting) return;
      waiting = false;
      clearTimeout(check);
      const waitMs = Math.round(performance.now() - joinedAt);
      if (waitMs < SLOW_TIMELINE_MS) return;
      logEvent("timeline_wait", {
        hostId, agentId, ...(subagentId ? { subagentId } : {}), waitMs, left,
        joinedState: joined.state, freshView: joined.fresh, otherViewers: joined.others,
        connection: client.driver.getConnectionState().status,
      });
    };
    const check = setTimeout(() => void client.liveness?.check("timeline_wait"), LIVENESS_CHECK_MS);
    check.unref?.();
    const stop = entry.view.watch((ops) => {
      if (waiting && ops.some((op) => op.type === "reset")) finishWait(false);
      watcher(ops);
    }, since);
    // A live view answers at once, possibly with nothing (a resume with no changes).
    if (joined.state === "live") finishWait(false);
    const current = entry;
    return () => {
      finishWait(true);
      stop();
      if (current.view.watcherCount || this.timelines.get(key) !== current) return;
      current.idle = setTimeout(() => {
        if (current.view.watcherCount || this.timelines.get(key) !== current) return;
        current.view.dispose();
        this.timelines.delete(key);
      }, TIMELINE_GRACE_MS);
      current.idle.unref?.();
    };
  }

  /**
   * The conversation as it is now, for a plain request that opens it: the shared view's reset
   * (loaded first if nobody watched it). Its seq lets the browser's stream resume from there.
   */
  timelineSnapshot(hostId: string, agentId: string, timeoutMs = SNAPSHOT_TIMEOUT_MS, signal?: AbortSignal) {
    return new Promise<Extract<TimelineOp, { type: "reset" }>>((resolve, reject) => {
      if (signal?.aborted) return reject(new TimelineTimeoutError());
      let stop: (() => void) | null = null, done = false, released = false;
      // Leaving starts the view's idle grace, so the stream that follows finds it live.
      const release = () => {
        if (released || !stop) return;
        released = true;
        stop();
      };
      const onAbort = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        release();
        reject(new TimelineTimeoutError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        release();
        reject(new TimelineTimeoutError());
      }, timeoutMs);
      timer.unref?.();
      try {
        stop = this.watchTimeline(hostId, agentId, (ops) => {
          // Errors are the view retrying; keep waiting for its rows.
          const reset = ops.find((op) => op.type === "reset");
          if (done || !reset) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(reset);
          queueMicrotask(release);
        });
      } catch (error) {
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        return reject(error);
      }
      // A live view answered before `stop` was known.
      if (done) release();
    });
  }

  private emit(listeners: Set<() => void>) {
    notifyListeners(listeners);
  }
}
