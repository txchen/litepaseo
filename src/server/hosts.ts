import { connectionProblem } from "./diagnostics.ts";
import { createHostClient } from "@getpaseo/client/node";
import { createPaseoApi } from "@getpaseo/client";
import type { Host } from "./store.ts";
import type { AgentSummary, WorkspaceSummary, HostDiagnostic, TimelineOp } from "../shared/wire.ts";
import { VersionedCollection } from "./versioned-collection.ts";
import { HostDirectory, HostWorkspaces, type DirectoryDriver, type Transition } from "./host-directory.ts";
import { TimelineView, type TimelineDriver, type TimelineResume } from "./timeline-view.ts";
import { HostSubagents, type SubagentDriver } from "./subagents.ts";
import type { ProviderSubagent } from "../shared/wire.ts";
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
  liveness?: HostLiveness;
  stopStatus: () => void;
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
    const directory = new HostDirectory(
      hostId,
      driver as unknown as DirectoryDriver,
      this.agents,
      () => this.emit(this.agentListeners),
      (previous, next) => {
        for (const listener of this.transitionListeners) listener(previous, next);
      },
    );
    const workspaces = new HostWorkspaces(hostId, driver as unknown as DirectoryDriver, this.workspaces, () =>
      this.emit(this.agentListeners),
    );
    const update = (state: ReturnType<Driver["getConnectionState"]>) => {
      const previous = this.diagnostics.get(hostId) ?? {};
      if (state.status === "connected") {
        if (previous.error) logEvent("host_reconnected", { hostId, after: previous.error.code });
        this.diagnostics.set(hostId, { lastConnectedAt: new Date().toISOString() });
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
    const liveness = typeof (driver as unknown as Partial<LivenessDriver>).ping === "function"
      ? new HostLiveness(driver as unknown as LivenessDriver, hostId, () => forceReconnect(driver))
      : undefined;
    this.clients.set(hostId, { driver, api, directory, workspaces, subagents, liveness, stopStatus });
    directory.start();
    // Daemons that predate workspaces simply have none; agents still list.
    if ((driver as unknown as DirectoryDriver).observeWorkspaces) workspaces.start();
    this.emit(this.hostListeners);
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
    if (c) {
      await Promise.all([...releases, c.directory.dispose(), c.workspaces.dispose(), c.subagents.dispose()]);
      c.stopStatus();
      await c.api.dispose();
      await c.driver.close();
    }
    this.diagnostics.delete(id);
    this.labels.delete(id);
    this.emit(this.hostListeners);
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

  /** The provider subagents of one agent, as they change. */
  watchSubagents(hostId: string, agentId: string, listener: (subagents: ProviderSubagent[]) => void) {
    return this.get(hostId).subagents.watch(agentId, listener);
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
    if (joined.state === "live" || joined.state === "catching-up") finishWait(false);
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
  timelineSnapshot(hostId: string, agentId: string, timeoutMs = SNAPSHOT_TIMEOUT_MS) {
    return new Promise<Extract<TimelineOp, { type: "reset" }>>((resolve, reject) => {
      let stop: (() => void) | null = null, done = false, released = false;
      // Leaving starts the view's idle grace, so the stream that follows finds it live.
      const release = () => {
        if (released || !stop) return;
        released = true;
        stop();
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        release();
        reject(new TimelineTimeoutError());
      }, timeoutMs);
      timer.unref?.();
      stop = this.watchTimeline(hostId, agentId, (ops) => {
        // Errors are the view retrying; keep waiting for its rows.
        const reset = ops.find((op) => op.type === "reset");
        if (done || !reset) return;
        done = true;
        clearTimeout(timer);
        resolve(reset);
        queueMicrotask(release);
      });
      // A live view answered before `stop` was known.
      if (done) release();
    });
  }

  private emit(listeners: Set<() => void>) {
    for (const listener of listeners) listener();
  }
}
