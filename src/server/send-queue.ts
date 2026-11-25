import { notifyListeners } from "./listeners.ts";
import { saveMessageImages } from "./message-images.ts";
import type { Store } from "./store.ts";
import { confirmedMessages } from "./message-status.ts";
import type { Hosts } from "./hosts.ts";

import type { ServerQueuedMessage } from "../shared/wire.ts";
interface Entry extends ServerQueuedMessage {
  prepared: { images: { data: string; mimeType: string }[]; attachments: any[] };
}
/** The queue never holds more than this, in serialized bytes, across all entries. */
const MAX_QUEUE_BYTES = 90 * 1024 * 1024;
/**
 * How long a delivered message may wait to be seen starting a turn before the next one goes.
 * A turn can finish too fast to be observed running (a slash command, an instant error, a
 * reconnect in between) and leave nothing else to clear the wait.
 */
export const AWAIT_TURN_MS = 15_000;
/** An entry without its payload: what save() compares, so unchanged images are not re-serialized. */
const meta = (e: Entry) => JSON.stringify({ ...e, prepared: undefined });
/** Durable ownership transfers to the BFF before enqueue is acknowledged. */
export class ServerSendQueue {
  private entries: Entry[];
  private listeners = new Set<() => void>();
  /** What the store holds per entry, as meta(); cleared when the store may disagree. */
  private saved = new Map<string, string>();
  /** Serialized size per entry; the payload never changes after add(). */
  private sizes = new WeakMap<Entry, number>();
  private inflight = new Set<string>();
  private checking = new Set<string>();
  private awaitingTurn = new Map<string, { activityAt: number; timer?: ReturnType<typeof setTimeout> }>();
  private stops: (() => void)[];
  private closed = false;
  private prunedAt = 0;
  private store: Store;
  private hosts: Hosts;
  constructor(store: Store, hosts: Hosts) {
    this.store = store; this.hosts = hosts;
    const ids: string[] = JSON.parse(store.setting("send-queue-order") ?? "[]");
    this.entries = store.setting("send-queue") !== null ? JSON.parse(store.setting("send-queue")!)
      : ids.map(id => JSON.parse(store.setting(`send-queue-entry:${id}`)!)).filter(Boolean);
    for (const entry of this.entries) if (entry.sending) {
      entry.sending = false;
      entry.error = "Delivery outcome unknown after restart. Check the conversation before sending again.";
    }
    this.save();
    this.stops = [hosts.onAgentsChanged(() => this.tick()), hosts.onHostsChanged(() => this.tick()), hosts.onTransition((previous, next) => {
      if (!next) this.stopAwaiting(previous!.key);
      else if (next.turnActive === true || next.status === "running" || next.status === "initializing") this.stopAwaiting(next.key);
      this.tick();
    })];
    this.tick();
  }
  private key(e: Entry) { return `${e.host}:${e.agent}`; }
  private size(e: Entry) {
    let size = this.sizes.get(e);
    if (size === undefined) this.sizes.set(e, (size = JSON.stringify(e).length));
    return size;
  }
  /** Holds the agent's next message until its activity moves past `activityAt`. */
  private awaitTurn(key: string, activityAt: number) {
    this.stopAwaiting(key);
    this.awaitingTurn.set(key, { activityAt });
  }
  /** Bounds a wait once the message is delivered: an unobserved turn must not stall the queue. */
  private boundWait(key: string) {
    const wait = this.awaitingTurn.get(key);
    if (!wait || wait.timer) return;
    wait.timer = setTimeout(() => {
      if (this.awaitingTurn.get(key) !== wait) return;
      this.awaitingTurn.delete(key);
      this.tick();
    }, AWAIT_TURN_MS);
    wait.timer.unref?.();
  }
  private stopAwaiting(key: string) {
    clearTimeout(this.awaitingTurn.get(key)?.timer);
    this.awaitingTurn.delete(key);
  }
  summary() {
    const result: Record<string, { count: number; paused: boolean }> = {};
    for (const e of this.entries) {
      const a = this.hosts.agents.get(this.key(e));
      const key = a?.workspaceId ? `${e.host}:${a.workspaceId}` : this.key(e);
      const item = result[key] ??= { count: 0, paused: false };
      item.count++; item.paused ||= !!(e.paused || e.error);
    }
    return result;
  }
  onChange(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private save() {
    // On failure `saved` may describe rows that were rolled back: forget it, so the next save rewrites all.
    try {
      this.store.transaction(() => {
        const ids = new Set(this.entries.map(e => e.id));
        for (const id of this.saved.keys()) if (!ids.has(id)) { this.store.setSetting(`send-queue-entry:${id}`, null); this.saved.delete(id); }
        for (const e of this.entries) {
          const current = meta(e);
          if (this.saved.get(e.id) === current) continue;
          const json = JSON.stringify(e);
          this.sizes.set(e, json.length);
          this.store.setSetting(`send-queue-entry:${e.id}`, json);
          this.saved.set(e.id, current);
        }
        this.store.setSetting("send-queue-order", JSON.stringify([...ids]));
        this.store.setSetting("send-queue", null);
      });
    } catch (error) { this.saved.clear(); throw error; }
    queueMicrotask(() => { if (!this.closed) notifyListeners(this.listeners); });
  }
  async control(host: string, agent: string, id: string, action: "pause" | "resume" | "up" | "check") {
    const e = this.get(host, agent, id);
    if (action === "check") {
      if (!e.error) return;
      const key = this.key(e);
      this.checking.add(key);
      let confirmed: string[];
      try { confirmed = await confirmedMessages(this.hosts.get(host).driver, agent, [id]); }
      finally { this.checking.delete(key); }
      if (this.closed) return;
      if (!confirmed.includes(id)) throw new Error("Delivery remains unknown. Check the conversation before retrying.");
      if (!this.entries.includes(e) || e.sending) return;
      this.entries = this.entries.filter(item => item !== e);
      this.stopAwaiting(this.key(e));
    } else if (action === "up") {
      const i = this.entries.indexOf(e);
      const earlier = this.entries.slice(0, i).findLastIndex(item => this.key(item) === this.key(e));
      if (earlier >= 0 && this.entries[earlier].error) throw new Error("Resolve the uncertain delivery before moving messages ahead of it.");
      if (earlier >= 0) [this.entries[i], this.entries[earlier]] = [this.entries[earlier], e];
    } else e.paused = action === "pause";
    this.save(); this.tick();
  }
  list(host: string, agent: string): ServerQueuedMessage[] {
    return this.entries.filter(e => e.host === host && e.agent === agent).map(({ prepared: _prepared, ...entry }) => ({ ...entry }));
  }
  private pruneReceipts() {
    const now = Date.now();
    if (now - this.prunedAt < 3600_000) return;
    this.prunedAt = now;
    const pending = new Set(this.entries.map(e => e.id));
    for (const [key, json] of this.store.settingsWithPrefix("queued-message:")) {
      const value = JSON.parse(json);
      if (Array.isArray(value)) this.store.setSetting(key, JSON.stringify({ host: value[0], agent: value[1], at: now }));
      else if (now - value.at > 30 * 86400_000 && !pending.has(key.slice('queued-message:'.length))) this.store.setSetting(key, null);
    }
  }
  accepted(host: string, agent: string, id: string) {
    const value = JSON.parse(this.store.setting(`queued-message:${id}`) ?? 'null');
    return Array.isArray(value) ? value[0] === host && value[1] === agent : value?.host === host && value?.agent === agent;
  }
  add(entry: Entry) {
    this.pruneReceipts();
    if (this.accepted(entry.host, entry.agent, entry.id)) return;
    if (this.entries.some(e => e.id === entry.id)) throw new Error("Message ID already queued");
    if (this.entries.length >= 100 || this.entries.reduce((size, e) => size + this.size(e), 0) + this.size(entry) > MAX_QUEUE_BYTES)
      throw new Error("Queue is full. Remove queued messages first.");
    this.entries.push(entry);
    try {
      this.store.transaction(() => {
        this.save();
        this.store.setSetting(`queued-message:${entry.id}`, JSON.stringify({ host: entry.host, agent: entry.agent, at: Date.now() }));
      });
    } catch (error) {
      this.saved.clear(); this.entries.pop(); throw error;
    }
    this.tick();
  }
  private get(host: string, agent: string, id: string) {
    const e = this.entries.find(e => e.host === host && e.agent === agent && e.id === id);
    if (!e) throw new Error("Queued message no longer available");
    if (this.checking.has(this.key(e))) throw new Error("Delivery check in progress. Try again when it completes.");
    if (e.sending || this.inflight.has(this.key(e))) throw new Error("Message is being sent. Refresh the queue.");
    return e;
  }
  remove(host: string, agent: string, id: string) {
    const e = this.get(host, agent, id);
    this.entries = this.entries.filter(item => item !== e); this.save(); this.tick();
  }
  edit(host: string, agent: string, id: string, text: string) {
    const e = this.get(host, agent, id);
    if (!text.trim() && !e.attachmentNames.length) throw new Error("Message cannot be empty");
    e.text = text; this.save();
  }
  async interrupt(host: string, agent: string, id: string) {
    await this.dispatch(this.get(host, agent, id), "interrupt");
  }
  tick() {
    if (this.closed) return;
    const seen = new Set<string>();
    for (const e of this.entries) {
      const key = this.key(e);
      if (seen.has(key)) continue;
      seen.add(key);
      const a = this.hosts.agents.get(key);
      const client = this.hosts.clients.get(e.host);
      if (!a || client?.driver.getConnectionState().status !== "connected" || client.directory?.synced === false) continue;
      const idle = a.turnActive === false || (a.turnActive === undefined && a.status !== "running" && a.status !== "initializing");
      if (!idle) { this.stopAwaiting(key); continue; }
      const wait = this.awaitingTurn.get(key);
      if (wait && (a.activityAt ?? 0) !== wait.activityAt) this.stopAwaiting(key);
      if (this.checking.has(key) || e.paused || e.error || e.sending || this.inflight.has(key) || this.awaitingTurn.has(key)) continue;
      void this.dispatch(e, "steer");
    }
  }
  private async dispatch(e: Entry, behavior: "steer" | "interrupt") {
    const key = this.key(e);
    this.inflight.add(key); this.awaitTurn(key, this.hosts.agents.get(key)?.activityAt ?? 0);
    e.sending = true; delete e.error;
    try { this.save(); } catch (error) {
      // Without a durable "sending" mark a restart could send it twice: do not send at all.
      e.sending = false; this.inflight.delete(key); this.stopAwaiting(key);
      console.warn(JSON.stringify({ event: "send_queue_save_failed", message: (error as Error)?.message }));
      return;
    }
    try {
      // Local preparation: a failure here means nothing reached the agent, so the entry is
      // only paused, not marked as an uncertain delivery.
      let send: () => Promise<unknown>;
      try {
        saveMessageImages(this.store, e.host, e.agent, e.id, e.prepared.images);
        const agent = this.hosts.get(e.host).api.agents.ref(e.agent);
        send = () => agent.send(e.text, { messageId: e.id, activeTurnBehavior: behavior, ...e.prepared });
      } catch (error) {
        this.stopAwaiting(key);
        e.paused = true;
        console.warn(JSON.stringify({ event: "queued_send_failed", host: e.host, agent: e.agent, message: (error as Error)?.message }));
        return;
      }
      try {
        await send();
        this.entries = this.entries.filter(item => item !== e);
        this.boundWait(key);
      } catch {
        this.stopAwaiting(key);
        e.error = "Delivery outcome unknown. Check the conversation before sending again.";
      }
    } finally {
      e.sending = false;
      this.inflight.delete(key);
      if (!this.closed) {
        try { this.save(); } catch (error) {
          console.warn(JSON.stringify({ event: "send_queue_save_failed", message: (error as Error)?.message }));
        }
        this.tick();
      }
    }
  }
  /** A removed host's messages can never be delivered: drop them, so they stop counting against the quota. */
  removeHost(host: string) {
    if (!this.entries.some(e => e.host === host)) return;
    this.entries = this.entries.filter(e => e.host !== host);
    for (const key of [...this.awaitingTurn.keys()]) if (key.startsWith(`${host}:`)) this.stopAwaiting(key);
    this.save();
  }
  close() {
    this.closed = true;
    for (const stop of this.stops) stop();
    for (const wait of this.awaitingTurn.values()) clearTimeout(wait.timer);
    this.awaitingTurn.clear();
  }
}
