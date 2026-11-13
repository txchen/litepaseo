import type { Store } from "./store.ts";
import { confirmedMessages } from "./message-status.ts";
import type { Hosts } from "./hosts.ts";

import type { ServerQueuedMessage } from "../shared/wire.ts";
interface Entry extends ServerQueuedMessage {
  prepared: { images: { data: string; mimeType: string }[]; attachments: any[] };
}
/** Durable ownership transfers to the BFF before enqueue is acknowledged. */
export class ServerSendQueue {
  private entries: Entry[];
  private listeners = new Set<() => void>();
  private saved = new Map<string, string>();
  private inflight = new Set<string>();
  private checking = new Set<string>();
  private awaitingTurn = new Map<string, number>();
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
    this.stops = [hosts.onAgentsChanged(() => this.tick()), hosts.onHostsChanged(() => this.tick()), hosts.onTransition((_previous, next) => {
      if (next && (next.turnActive === true || next.status === "running" || next.status === "initializing")) this.awaitingTurn.delete(next.key);
      this.tick();
    })];
    this.tick();
  }
  private key(e: Entry) { return `${e.host}:${e.agent}`; }
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
    const ownTransaction = !this.store.db.isTransaction;
    if (ownTransaction) this.store.db.exec("BEGIN IMMEDIATE");
    try {
    const ids = new Set(this.entries.map(e => e.id));
    for (const id of this.saved.keys()) if (!ids.has(id)) { this.store.setSetting(`send-queue-entry:${id}`, null); this.saved.delete(id); }
    for (const e of this.entries) {
      const json = JSON.stringify(e);
      if (this.saved.get(e.id) !== json) { this.store.setSetting(`send-queue-entry:${e.id}`, json); this.saved.set(e.id, json); }
    }
    this.store.setSetting("send-queue-order", JSON.stringify([...ids]));
    this.store.setSetting("send-queue", null);
    if (ownTransaction) this.store.db.exec("COMMIT");
    } catch (error) { if (ownTransaction) this.store.db.exec("ROLLBACK"); this.saved.clear(); throw error; }
    queueMicrotask(() => { if (!this.closed) for (const fn of this.listeners) fn(); });
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
      this.awaitingTurn.delete(this.key(e));
    } else if (action === "up") {
      const i = this.entries.indexOf(e);
      const earlier = this.entries.slice(0, i).findLastIndex(item => this.key(item) === this.key(e));
      if (earlier >= 0 && this.entries[earlier].error) throw new Error("Resolve the uncertain delivery before moving messages ahead of it.");
      if (earlier >= 0) [this.entries[i], this.entries[earlier]] = [this.entries[earlier], e];
    } else e.paused = action === "pause";
    this.save(); this.tick();
  }
  list(host: string, agent: string): ServerQueuedMessage[] {
    return this.entries.filter(e => e.host === host && e.agent === agent).map(({ prepared, ...entry }) => ({ ...entry }));
  }
  private pruneReceipts() {
    const now = Date.now();
    if (now - this.prunedAt < 3600_000) return;
    this.prunedAt = now;
    const pending = new Set(this.entries.map(e => e.id));
    for (const row of this.store.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'queued-message:%'").all()) {
      const key = String(row.key), value = JSON.parse(String(row.value));
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
    if (this.entries.length >= 100 || [...this.saved.values()].reduce((size, json) => size + json.length, 0) + JSON.stringify(entry).length > 90 * 1024 * 1024)
      throw new Error("Queue is full. Remove queued messages first.");
    this.entries.push(entry);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.save();
      this.store.setSetting(`queued-message:${entry.id}`, JSON.stringify({ host: entry.host, agent: entry.agent, at: Date.now() }));
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK"); this.saved.clear(); this.entries.pop(); throw error;
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
      if (!a || client?.driver.getConnectionState().status !== "connected") continue;
      const idle = a.turnActive === false || (a.turnActive === undefined && a.status !== "running" && a.status !== "initializing");
      if (!idle) { this.awaitingTurn.delete(key); continue; }
      if (this.awaitingTurn.has(key) && (a.activityAt ?? 0) !== this.awaitingTurn.get(key)) this.awaitingTurn.delete(key);
      if (this.checking.has(key) || e.paused || e.error || e.sending || this.inflight.has(key) || this.awaitingTurn.has(key)) continue;
      void this.dispatch(e, "steer");
    }
  }
  private async dispatch(e: Entry, behavior: "steer" | "interrupt") {
    const key = this.key(e);
    this.inflight.add(key); this.awaitingTurn.set(key, this.hosts.agents.get(key)?.activityAt ?? 0);
    e.sending = true; delete e.error; this.save();
    try {
      await this.hosts.get(e.host).api.agents.ref(e.agent).send(e.text, {
        messageId: e.id, activeTurnBehavior: behavior, ...e.prepared,
      });
      this.entries = this.entries.filter(item => item !== e);
    } catch {
      this.awaitingTurn.delete(key);
      e.error = "Delivery outcome unknown. Check the conversation before sending again.";
    } finally {
      e.sending = false;
      this.inflight.delete(key);
      if (!this.closed) { this.save(); this.tick(); }
    }
  }
  close() { this.closed = true; for (const stop of this.stops) stop(); }
}
