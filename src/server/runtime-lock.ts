import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Kernel-managed SQLite locking is released even by SIGKILL; the lock file is never deleted. */
export function acquireRuntimeLock(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "service-lock.sqlite");
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  try { db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
  catch { db.close(); throw new Error("Another LitePaseo process is using this home."); }
  return () => { db.exec("ROLLBACK"); db.close(); };
}
