import { createHostClient } from "@getpaseo/client/node";
import { createPaseoApi } from "@getpaseo/client";
import type { Host } from "./store.ts";
import type { AgentSummary } from "../shared/wire.ts";
import { VersionedCollection } from "./versioned-collection.ts";
import { HostDirectory, type DirectoryDriver, type Transition } from "./host-directory.ts";
import { TimelineView, type TimelineDriver } from "./timeline-view.ts";

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
  stopStatus: () => void;
}

/** Idle grace before an unwatched timeline releases its daemon subscription. */
const TIMELINE_GRACE_MS = 30_000;

export class Hosts {
  readonly agents = new VersionedCollection<AgentSummary>();
  readonly clients = new Map<string, Client>();
  private readonly labels = new Map<string, string>();
  private readonly timelines = new Map<
    string,
    { view: TimelineView; hostId: string; idle?: ReturnType<typeof setTimeout> }
  >();
  private readonly agentListeners = new Set<() => void>();
  private readonly hostListeners = new Set<() => void>();
  private readonly transitionListeners = new Set<Transition>();

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
    void driver.connect().catch(() => {});
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
    const stopStatus = driver.subscribeConnectionStatus(() => this.emit(this.hostListeners));
    this.clients.set(hostId, { driver, api, directory, stopStatus });
    directory.start();
    this.emit(this.hostListeners);
  }

  get(id: string) {
    const c = this.clients.get(id);
    if (!c) throw new UnknownHostError();
    return c;
  }

  state(id: string) {
    return this.clients.get(id)?.driver.getConnectionState().status ?? "offline";
  }

  async remove(id: string) {
    const c = this.clients.get(id);
    this.clients.delete(id);
    for (const [key, entry] of this.timelines)
      if (entry.hostId === id) {
        clearTimeout(entry.idle);
        entry.view.dispose();
        this.timelines.delete(key);
      }
    if (c) {
      c.directory.dispose();
      c.stopStatus();
      await c.api.dispose();
      await c.driver.close();
    }
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
  onTransition(listener: Transition) {
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

  /** Shares one live timeline per agent across all watching browsers. */
  watchTimeline(hostId: string, agentId: string, watcher: Parameters<TimelineView["watch"]>[0]) {
    const client = this.get(hostId);
    const key = `${hostId}:${agentId}`;
    let entry = this.timelines.get(key);
    if (!entry) {
      const view = new TimelineView(client.driver as unknown as TimelineDriver, agentId);
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
