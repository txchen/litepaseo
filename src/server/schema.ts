import type { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const SCHEMA_VERSION = 1;
export function schemaVersion(db: DatabaseSync) {
  return Number(db.prepare("PRAGMA user_version").get()!.user_version);
}
export function migrate(db: DatabaseSync, directory: string) {
  const version = schemaVersion(db);
  if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than supported version ${SCHEMA_VERSION}; upgrade LitePaseo.`);
  db.exec("PRAGMA busy_timeout=3000");
  if (version === SCHEMA_VERSION) return;
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if (existing.length) {
    const path = join(directory, `pre-migration-v${version}-${randomUUID()}.sqlite`);
    db.prepare("VACUUM INTO ?").run(path);
    chmodSync(path, 0o600);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hosts(id TEXT PRIMARY KEY,label TEXT NOT NULL,connection TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS board(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,cards TEXT NOT NULL);
      INSERT OR IGNORE INTO board VALUES(1,0,'[]');
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,secret_hash TEXT NOT NULL UNIQUE,label TEXT NOT NULL,
        created INTEGER NOT NULL,last_seen INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint TEXT PRIMARY KEY,session_id TEXT NOT NULL,
        p256dh TEXT NOT NULL,auth TEXT NOT NULL,prefs TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS push_by_session ON push_subscriptions(session_id);
      PRAGMA user_version=1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
