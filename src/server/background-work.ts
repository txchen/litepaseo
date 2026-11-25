import { notifyListeners } from "./listeners.ts";
import type { AgentBackgroundWorkItem } from "../shared/wire.ts";

const UPDATE = "agent.background_work.update";

interface UpdatePayload {
  agentId: string;
  items: AgentBackgroundWorkItem[];
}

/** Narrow DaemonClient surface for agent background work & heartbeats. */
export interface BackgroundWorkDriver {
  observeEvents?(events: string[]): {
    ready: Promise<unknown>;
    subscribe(observer: { snapshot(payload: unknown): void; update(message: unknown): void; error?(error: unknown): void }): () => void;
    release(): Promise<void>;
  };
  on?(type: string, handler: (message: { payload: unknown }) => void): () => void;
  listAgentBackgroundWork?(
    agentId: string,
    options?: { timeout?: number },
  ): Promise<{ items: AgentBackgroundWorkItem[]; error: string | null }>;
  stopAgentBackgroundWork?(
    agentId: string,
    item: AgentBackgroundWorkItem,
    options?: { timeout?: number },
  ): Promise<{ error: string | null }>;
}

type Listener = (items: AgentBackgroundWorkItem[]) => void;

interface Watched {
  items: AgentBackgroundWorkItem[];
  listeners: Set<Listener>;
  token: number;
  timer?: ReturnType<typeof setTimeout>;
  loaded: boolean;
}

const GRACE_MS = 30_000;
const FLUSH_MS = 500;
const LIST_TIMEOUT_MS = 10_000;

const sanitize = (raw: unknown): AgentBackgroundWorkItem[] => {
  if (!Array.isArray(raw)) return [];
  const out: AgentBackgroundWorkItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.kind !== "string" || typeof r.startedAt !== "string") continue;
    out.push({
      id: r.id,
      kind: r.kind,
      description: typeof r.description === "string" ? r.description : null,
      ...(typeof r.command === "string" ? { command: r.command } : {}),
      startedAt: r.startedAt,
      ...(typeof r.canStop === "boolean" ? { canStop: r.canStop } : {}),
      ...(typeof r.stopToken === "string" ? { stopToken: r.stopToken } : {}),
    });
  }
  return out;
};

/**
 * Background tasks and heartbeats for agents of one host. Subscribes only while at least one
 * conversation on this host is watched, and releases after a short grace window.
 */
export class HostBackgroundWork {
  private readonly driver: BackgroundWorkDriver;
  private readonly watched = new Map<string, Watched>();
  private readonly dirty = new Set<string>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private releaseTimer?: ReturnType<typeof setTimeout>;
  private sub?: { release(): Promise<void> };
  private stopSub?: () => void;
  private stopOn?: () => void;
  private disposed = false;

  constructor(driver: BackgroundWorkDriver) {
    this.driver = driver;
  }

  watch(agentId: string, listener: Listener): () => void {
    if (this.disposed) return () => {};
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = undefined;
    }
    let entry = this.watched.get(agentId);
    if (!entry) {
      entry = { items: [], listeners: new Set(), token: 0, loaded: false };
      this.watched.set(agentId, entry);
      this.ensureSubscription();
      void this.refresh(agentId, entry);
    } else if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.listeners.add(listener);
    if (entry.loaded) listener(entry.items);
    return () => {
      const current = this.watched.get(agentId);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size) return;
      current.timer = setTimeout(() => {
        if (current.listeners.size) return;
        this.watched.delete(agentId);
        this.dirty.delete(agentId);
        if (!this.watched.size) this.scheduleRelease();
      }, GRACE_MS);
    };
  }

  async stop(agentId: string, item: AgentBackgroundWorkItem): Promise<void> {
    if (!this.driver.stopAgentBackgroundWork) throw new Error("This host does not support stopping background work.");
    const res = await this.driver.stopAgentBackgroundWork(agentId, item, { timeout: LIST_TIMEOUT_MS });
    if (res?.error) throw new Error(res.error);
    const entry = this.watched.get(agentId);
    if (entry) void this.refresh(agentId, entry);
  }

  reconnect() {
    if (this.disposed || !this.watched.size) return;
    for (const [agentId, entry] of this.watched) void this.refresh(agentId, entry);
  }

  async dispose() {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    for (const entry of this.watched.values()) if (entry.timer) clearTimeout(entry.timer);
    this.watched.clear();
    this.dirty.clear();
    await this.releaseSubscription();
  }

  private ensureSubscription() {
    if (this.sub || this.disposed) return;
    if (!this.driver.observeEvents || !this.driver.on) return;
    try {
      const sub = this.driver.observeEvents([UPDATE]);
      this.sub = sub;
      this.stopSub = sub.subscribe({
        snapshot: () => {},
        update: () => {},
        error: () => {},
      });
      this.stopOn = this.driver.on(UPDATE, (msg) => this.onUpdate(msg.payload));
      void sub.ready.catch(() => {
        if (this.sub === sub) void this.releaseSubscription();
      });
    } catch {
      void this.releaseSubscription();
    }
  }

  private scheduleRelease() {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined;
      if (!this.watched.size) void this.releaseSubscription();
    }, GRACE_MS);
  }

  private async releaseSubscription() {
    this.stopOn?.();
    this.stopSub?.();
    const sub = this.sub;
    this.stopOn = undefined;
    this.stopSub = undefined;
    this.sub = undefined;
    if (sub) await sub.release().catch(() => {});
  }

  private async refresh(agentId: string, entry: Watched) {
    if (!this.driver.listAgentBackgroundWork) {
      entry.loaded = true;
      entry.items = [];
      notifyListeners(entry.listeners, entry.items);
      return;
    }
    const token = ++entry.token;
    try {
      const res = await this.driver.listAgentBackgroundWork(agentId, { timeout: LIST_TIMEOUT_MS });
      if (this.disposed || this.watched.get(agentId) !== entry || entry.token !== token) return;
      entry.items = res.error ? [] : sanitize(res.items);
      entry.loaded = true;
      notifyListeners(entry.listeners, entry.items);
    } catch {
      if (this.disposed || this.watched.get(agentId) !== entry || entry.token !== token) return;
      entry.loaded = true;
      notifyListeners(entry.listeners, entry.items);
    }
  }

  private onUpdate(raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    const payload = raw as Partial<UpdatePayload>;
    if (typeof payload.agentId !== "string") return;
    const entry = this.watched.get(payload.agentId);
    if (!entry) return;
    entry.token++;
    entry.items = sanitize(payload.items);
    entry.loaded = true;
    this.dirty.add(payload.agentId);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        const agents = [...this.dirty];
        this.dirty.clear();
        for (const id of agents) {
          const e = this.watched.get(id);
          if (e) notifyListeners(e.listeners, e.items);
        }
      }, FLUSH_MS);
    }
  }
}
