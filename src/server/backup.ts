import { acquireRuntimeLock } from "./runtime-lock.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { Store } from "./store.ts";
import { schemaVersion, SCHEMA_VERSION } from "./schema.ts";

const FILES = ["litepaseo.sqlite", "token"] as const;
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A consistent SQLite snapshot includes committed WAL data; never copy a live database file. */
export function backup(directory: string, destination: string) {
  destination = resolve(destination);
  if (!existsSync(join(directory, FILES[0])) || !existsSync(join(directory, "token")))
    throw new Error("No initialized LitePaseo data to back up.");
  mkdirSync(destination, { mode: 0o700 }); // exclusive: never overwrite an existing backup
  let store: Store | undefined;
  try {
    store = new Store(directory);
    store.db.prepare("VACUUM INTO ?").run(join(destination, FILES[0]));
    copyFileSync(join(directory, "token"), join(destination, "token"), constants.COPYFILE_EXCL);
    for (const file of FILES) chmodSync(join(destination, file), 0o600);
    writeFileSync(join(destination, "manifest.json"), JSON.stringify({
      format: 1, schema: SCHEMA_VERSION, created: new Date().toISOString(),
      files: Object.fromEntries(FILES.map(file => [file, digest(join(destination, file))])),
    }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally { store?.close(); }
}

/** Restore only into an empty home; the same exclusive socket binding prevents concurrent startup. */
export async function restore(source: string, directory: string) {
  source = resolve(source);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const releaseRuntime = acquireRuntimeLock(directory);
  const lock = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    lock.once("error", reject);
    lock.listen(join(directory, "control.sock"), resolve);
  }).catch(error => { releaseRuntime(); throw error; });
  const stage = join(directory, ".restore-staging");
  let ownsStage = false;
  try {
    if (readdirSync(directory).some(file => file !== "control.sock" && file !== "service-lock.sqlite" && file !== "service-lock.sqlite-journal"))
      throw new Error("Restore requires an empty LITEPASEO_HOME. Restore to a new directory, then start it.");
    mkdirSync(stage, { mode: 0o700 });
    ownsStage = true;
    const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
    if (manifest.format !== 1 || manifest.schema !== SCHEMA_VERSION)
      throw new Error("Unsupported backup format or schema version.");
    for (const file of FILES) {
      copyFileSync(join(source, file), join(stage, file), constants.COPYFILE_EXCL);
      chmodSync(join(stage, file), 0o600);
      if (manifest.files?.[file] !== digest(join(stage, file))) throw new Error(`Backup checksum failed: ${file}`);
    }
    const db = new DatabaseSync(join(stage, FILES[0]), { readOnly: true });
    try {
      if (schemaVersion(db) !== SCHEMA_VERSION || db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
        throw new Error("Backup database failed validation.");
      for (const table of ["hosts", "board", "settings", "sessions", "push_subscriptions"])
        db.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
    } finally { db.close(); }
    if (!/^[a-f0-9]{64}\s*$/.test(readFileSync(join(stage, "token"), "utf8"))) throw new Error("Invalid backup access token.");
    // The marker prevents startup after interruption between publishing the two files.
    writeFileSync(join(directory, ".restore-incomplete"), "Restore interrupted: restore the backup to a fresh home.\n", { mode: 0o600, flag: "wx" });
    renameSync(join(stage, "token"), join(directory, "token"));
    renameSync(join(stage, FILES[0]), join(directory, FILES[0]));
    rmSync(join(directory, ".restore-incomplete"));
  } finally {
    if (ownsStage) rmSync(stage, { recursive: true, force: true });
    await new Promise<void>(resolve => lock.close(() => resolve()));
    releaseRuntime();
  }
}
