import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { Store } from "../src/server/store.ts";
import { backup, restore } from "../src/server/backup.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lp-backup-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("legacy migration backs up committed data and rolls back a failed migration", () => {
  const f = fixture();
  try {
    const path = join(f.root, "litepaseo.sqlite");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE hosts(id TEXT PRIMARY KEY,label TEXT,connection TEXT); INSERT INTO hosts VALUES('h','label','secret');");
    old.close();
    const migrated = new Store(f.root);
    assert.equal(migrated.hosts()[0].connection, "secret");
    assert.equal(migrated.db.prepare("PRAGMA user_version").get()!.user_version, 1);
    migrated.close();
    const backups = readdirSync(f.root).filter(n => n.startsWith("pre-migration"));
    assert.equal(backups.length, 1);
    const snapshot = new DatabaseSync(join(f.root, backups[0]));
    assert.equal(snapshot.prepare("PRAGMA user_version").get()!.user_version, 0);
    snapshot.close();
    new Store(f.root).close();
    assert.equal(readdirSync(f.root).filter(n => n.startsWith("pre-migration")).length, 1);

    const badDir = join(f.root, "bad"); mkdirSync(badDir);
    const bad = new DatabaseSync(join(badDir, "litepaseo.sqlite"));
    bad.exec("CREATE TABLE board(id INTEGER PRIMARY KEY,broken TEXT)"); bad.close();
    assert.throws(() => new Store(badDir));
    const check = new DatabaseSync(join(badDir, "litepaseo.sqlite"));
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 0);
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='hosts'").get(), undefined);
    check.close();
  } finally { f.cleanup(); }
});

test("newer schemas and interrupted restores are refused", () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(join(f.root, "litepaseo.sqlite"));
    db.exec("PRAGMA user_version=999"); db.close();
    assert.throws(() => new Store(f.root), /newer/);
    assert.equal(readdirSync(f.root).some(n => n.startsWith("pre-migration")), false);
    writeFileSync(join(f.root, ".restore-incomplete"), "interrupted");
    assert.throws(() => new Store(f.root), /interrupted restore/);
  } finally { f.cleanup(); }
});

test("live WAL backup restores all persisted data with private permissions; corruption and overwrite are rejected", async () => {
  const f = fixture();
  const home = join(f.root, "home"), archive = join(f.root, "backup"), target = join(f.root, "restored");
  const store = new Store(home);
  try {
    writeFileSync(join(home, "token"), "a".repeat(64));
    store.addHost("host", "secret-connection");
    store.setSetting("vapid", "private-push-key");
    store.setSetting("totp_secret", "private-totp-key");
    store.addSession({ id: "s", secretHash: "hash", label: "phone", created: 0, lastSeen: 0, expires: 1e15 });
    store.savePushSubscription({ endpoint: "https://push.example/1", sessionId: "s", p256dh: "key", auth: "auth", prefs: { attention: true, turns: true }, created: 0 });
    store.saveBoard(0, [{ id: "card", title: "Saved", column: "Todo", hostId: null, agentId: null }]);
    backup(home, archive);
    assert.throws(() => backup(home, archive), /exist/i);
    await restore(archive, target);
    const restored = new Store(target);
    assert.deepEqual(restored.hosts(), store.hosts());
    assert.deepEqual(restored.board(), store.board());
    assert.deepEqual(restored.sessions(), store.sessions());
    assert.deepEqual(restored.pushSubscriptions(), store.pushSubscriptions());
    assert.equal(restored.setting("totp_secret"), "private-totp-key");
    assert.equal(restored.setting("vapid"), "private-push-key");
    restored.close();
    assert.equal(readFileSync(join(target, "token"), "utf8"), "a".repeat(64));
    assert.equal(statSync(target).mode & 0o777, 0o700);
    for (const file of ["litepaseo.sqlite", "token"]) assert.equal(statSync(join(target, file)).mode & 0o777, 0o600);
    await assert.rejects(restore(archive, target), /empty/);
    writeFileSync(join(archive, "token"), "b".repeat(64));
    const invalid = join(f.root, "invalid");
    await assert.rejects(restore(archive, invalid), /checksum/);
    assert.deepEqual(readdirSync(invalid), ["service-lock.sqlite"]);
    const server = createServer();
    const locked = join(f.root, "locked"); mkdirSync(locked);
    await new Promise<void>(resolve => server.listen(join(locked, "control.sock"), resolve));
    try { await assert.rejects(restore(archive, locked), /EADDRINUSE/); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { store.close(); f.cleanup(); }
});
