import type { Store } from "./store.ts";
import type { Hosts } from "./hosts.ts";

import type { ServerQueuedMessage } from "../shared/wire.ts";
interface Entry extends ServerQueuedMessage {
  prepared: { images: { data: string; mimeType: string }[]; attachments: any[] };
}
/** Durable ownership transfers to the BFF before enqueue is acknowledged. */
export class ServerSendQueue {
  private entries: Entry[];
  private inflight = new Set<string>();
  private awaitingTurn = new Map<string, number>();
  private stops: (() => void)[];
  private closed = false;
  private store: Store;
  private hosts: Hosts;
  constructor(store: Store, hosts: Hosts) {
    this.store = store; this.hosts = hosts;
    this.entries = JSON.parse(store.setting("send-queue") ?? "[]");
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
  private save() { this.store.setSetting("send-queue", JSON.stringify(this.entries)); }
  list(host: string, agent: string): ServerQueuedMessage[] {
    return this.entries.filter(e => e.host === host && e.agent === agent).map(({ prepared, ...entry }) => ({ ...entry }));
  }
  accepted(host: string, agent: string, id: string) {
    return this.store.setting(`queued-message:${id}`) === JSON.stringify([host, agent]);
  }
  add(entry: Entry) {
    if (this.entries.some(e => e.id === entry.id)) throw new Error("Message ID already queued");
    if (this.entries.length >= 100 || JSON.stringify(this.entries).length + JSON.stringify(entry).length > 90 * 1024 * 1024)
      throw new Error("Queue is full. Remove queued messages first.");
    this.entries.push(entry);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.save();
      this.store.setSetting(`queued-message:${entry.id}`, JSON.stringify([entry.host, entry.agent]));
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK"); this.entries.pop(); throw error;
    }
    this.tick();
  }
  private get(host: string, agent: string, id: string) {
    const e = this.entries.find(e => e.host === host && e.agent === agent && e.id === id);
    if (!e) throw new Error("Queued message no longer available");
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
      if (e.error || e.sending || this.inflight.has(key) || this.awaitingTurn.has(key)) continue;
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
