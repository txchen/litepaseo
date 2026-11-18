import { connectionProblem } from "./diagnostics.ts";
import { createHostClient } from "@getpaseo/client/node";
import { createPaseoApi } from "@getpaseo/client";
import type { Host } from "./store.ts";
import type { AgentSummary, WorkspaceSummary, HostDiagnostic } from "../shared/wire.ts";
import { VersionedCollection } from "./versioned-collection.ts";
import { HostDirectory, HostWorkspaces, type DirectoryDriver, type Transition } from "./host-directory.ts";
import { TimelineView, type TimelineDriver } from "./timeline-view.ts";
import { HostSubagents, type SubagentDriver } from "./subagents.ts";
import type { ProviderSubagent } from "../shared/wire.ts";

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
  stopStatus: () => void;
}

/** Idle grace before an unwatched timeline releases its daemon subscription. */
const TIMELINE_GRACE_MS = 30_000;
/** Conversation opens slower than this are logged with a per-layer breakdown. */
const SLOW_TIMELINE_MS = 3000;

export class Hosts {
  readonly agents = new VersionedCollection<AgentSummary>();
  readonly workspaces = new VersionedCollection<WorkspaceSummary>();
  readonly clients = new Map<string, Client>();
  private readonly diagnostics = new Map<string, HostDiagnostic>();
  private readonly labels = new Map<string, string>();
  private readonly timelines = new Map<
    string,
    { view: TimelineView; hostId: string; idle?: ReturnType<typeof setTimeout> }
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
      if (state.status === "connected") this.diagnostics.set(hostId, { lastConnectedAt: new Date().toISOString() });
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
    this.clients.set(hostId, { driver, api, directory, workspaces, subagents, stopStatus });
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
    if (previous.error?.code !== error.code) console.warn(JSON.stringify({ event: "host_connection_failed", hostId: id, code: error.code }));
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
   * conversation of one of the agent's provider subagents.
   */
  watchTimeline(hostId: string, agentId: string, watcher: Parameters<TimelineView["watch"]>[0], subagentId?: string) {
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
        console.warn(JSON.stringify({ event: "timeline_slow", hostId, agentId, ...(subagentId ? { subagentId } : {}), connectionAtStart: connection ?? null, ...report }));
      });
      entry = { view, hostId };
      this.timelines.set(key, entry);
      view.start();
    }
    clearTimeout(entry.idle);
    entry.idle = undefined;
    const stop = entry.view.watch(watcher);
    const current = entry;
    return () => {
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

  private emit(listeners: Set<() => void>) {
    for (const listener of listeners) listener();
  }
}
