import { migrate } from "./schema.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export interface Host {
  id: string;
  label: string;
  connection: string;
}
export interface Card {
  id: string;
  title: string;
  column: string;
  hostId: string | null;
  agentId: string | null;
}
export interface LoginSession {
  id: string;
  secretHash: string;
  label: string;
  created: number;
  lastSeen: number;
  expires: number;
}
export interface PushPrefs {
  attention: boolean;
  turns: boolean;
}
export interface PushSubscriptionRecord {
  endpoint: string;
  sessionId: string;
  p256dh: string;
  auth: string;
  prefs: PushPrefs;
  created: number;
}
const toSession = (r: Record<string, unknown>): LoginSession => ({
  id: String(r.id),
  secretHash: String(r.secret_hash),
  label: String(r.label),
  created: Number(r.created),
  lastSeen: Number(r.last_seen),
  expires: Number(r.expires),
});
export class Store {
  db: DatabaseSync;
  constructor(directory: string) {
    if (existsSync(join(directory, ".restore-incomplete"))) throw new Error("An interrupted restore was found. Restore the backup to a fresh LITEPASEO_HOME.");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, "litepaseo.sqlite"));
    chmodSync(join(directory, "litepaseo.sqlite"), 0o600);
    try {
      migrate(this.db, directory);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  setting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key);
    return row ? String(row.value) : null;
  }
  setSetting(key: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM settings WHERE key=?").run(key);
    else this.db.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  /** Compare-and-set, for single-use values such as the last accepted TOTP step. */
  advanceSetting(key: string, value: number) {
    const current = Number(this.setting(key) ?? -1);
    if (value <= current) return false;
    this.setSetting(key, String(value));
    return true;
  }
  addSession(s: LoginSession) {
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)")
      .run(s.id, s.secretHash, s.label, s.created, s.lastSeen, s.expires);
  }
  sessionBySecret(secretHash: string): LoginSession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE secret_hash=?").get(secretHash);
    return row ? toSession(row) : null;
  }
  sessionById(id: string): LoginSession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
    return row ? toSession(row) : null;
  }
  sessions(): LoginSession[] {
    return this.db.prepare("SELECT * FROM sessions ORDER BY last_seen DESC").all().map(toSession);
  }
  touchSession(id: string, lastSeen: number, expires: number) {
    this.db.prepare("UPDATE sessions SET last_seen=?,expires=? WHERE id=?").run(lastSeen, expires, id);
  }
  /** Removes sessions (and the push subscriptions they registered). */
  revokeSessions(id?: string) {
    if (id) {
      this.db.prepare("DELETE FROM push_subscriptions WHERE session_id=?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    } else {
      this.db.exec("DELETE FROM push_subscriptions; DELETE FROM sessions;");
    }
  }
  pruneSessions(now: number) {
    this.db.prepare("DELETE FROM push_subscriptions WHERE session_id IN (SELECT id FROM sessions WHERE expires<?)").run(now);
    this.db.prepare("DELETE FROM sessions WHERE expires<?").run(now);
  }
  savePushSubscription(p: PushSubscriptionRecord) {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET
         session_id=excluded.session_id,p256dh=excluded.p256dh,auth=excluded.auth,prefs=excluded.prefs`,
      )
      .run(p.endpoint, p.sessionId, p.p256dh, p.auth, JSON.stringify(p.prefs), p.created);
  }
  pushSubscriptions(): PushSubscriptionRecord[] {
    return this.db
      .prepare("SELECT * FROM push_subscriptions")
      .all()
      .map((r) => ({
        endpoint: String(r.endpoint),
        sessionId: String(r.session_id),
        p256dh: String(r.p256dh),
        auth: String(r.auth),
        prefs: JSON.parse(String(r.prefs)) as PushPrefs,
        created: Number(r.created),
      }));
  }
  removePushSubscription(endpoint: string, sessionId?: string) {
    if (sessionId)
      return this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint=? AND session_id=?").run(endpoint, sessionId).changes > 0;
    return this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(endpoint).changes > 0;
  }
  hosts(): Host[] {
    return this.db.prepare("SELECT * FROM hosts").all() as unknown as Host[];
  }
  addHost(label: string, connection: string): Host {
    const h = { id: randomUUID(), label, connection };
    this.db.prepare("INSERT INTO hosts VALUES(?,?,?)").run(h.id, label, connection);
    return h;
  }
  removeHost(id: string) {
    this.db.prepare("DELETE FROM hosts WHERE id=?").run(id);
  }
  board(): { revision: number; cards: Card[] } {
    const row = this.db.prepare("SELECT revision,cards FROM board WHERE id=1").get()!;
    return { revision: Number(row.revision), cards: JSON.parse(String(row.cards)) };
  }
  saveBoard(revision: number, cards: Card[]) {
    return (
      this.db
        .prepare("UPDATE board SET revision=revision+1,cards=? WHERE id=1 AND revision=?")
        .run(JSON.stringify(cards), revision).changes === 1
    );
  }
  close() {
    this.db.close();
  }
}
