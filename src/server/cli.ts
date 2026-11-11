#!/usr/bin/env node
import { RotatingLog } from "./rotating-log.ts";
import { manageService } from "./autostart.ts";
import { FAILED_EVENT, StartupFailure, supervise } from "./supervisor.ts";
import { runWorker } from "./worker.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { backup, restore } from "./backup.ts";
import { Store } from "./store.ts";
import { resolveDataDirectory } from "./data-dir.ts";
const command = process.argv[2] ?? "help";
const { directory, notice } = await resolveDataDirectory(process.env, homedir(), process.platform);
if (notice) console.error(notice);
mkdirSync(directory, { recursive: true, mode: 0o700 });
process.umask(0o077);
const socket = join(directory, "control.sock"),
  tokenPath = join(directory, "token"),
  log = join(directory, "service.log");
async function control(action: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(socket);
    let out = "";
    s.setTimeout(2000, () => s.destroy(new Error("Control request timed out")));
    s.on("error", reject);
    s.on("connect", () => s.end(action));
    s.on("data", (chunk) => (out += chunk));
    s.on("end", () => resolve(out));
  });
}
/** The reason recorded by the supervisor that just stopped, if any. */
function lastFailure(since: number) {
  if (!existsSync(log)) return null;
  const bytes = readFileSync(log);
  // A rotation since the start attempt means everything in the file is new.
  const lines = bytes.subarray(bytes.length >= since ? since : 0).toString("utf8").trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry?.event === FAILED_EVENT || entry?.event === "supervisor_start_failed") return String(entry.error);
    } catch {}
  }
  return null;
}
async function main() {
  if (command === "help" || command === "--help") {
    console.log(
      [
        "LitePaseo: start | serve | status | stop | restart | logs | token | totp-reset | signout-all | backup <directory> | restore <directory> | service print|install|uninstall|status|start|stop|restart",
        "  token        print the access token (sign-in fallback)",
        "  totp-reset   turn off authenticator sign-in (lost phone)",
        "  signout-all  revoke every signed-in browser and its notifications",
        `Data: ${directory}`,
        "Environment: LITEPASEO_HOME (default ~/.litepaseo), LITEPASEO_PORT (8787), LITEPASEO_BIND (127.0.0.1),",
        "  LITEPASEO_PUSH_SUBJECT (mailto: or https: contact for push services)",
      ].join("\n"),
    );
    return;
  }
  if (command === "service") {
    console.log(manageService(process.argv[3] ?? "print", {
      platform: process.platform, home: homedir(), directory, node: process.execPath,
      cli: fileURLToPath(import.meta.url), env: process.env, uid: process.getuid?.() ?? 0,
    }));
    return;
  }
  if (command === "backup" || command === "restore") {
    const path = process.argv[3];
    if (!path) throw new Error(`Usage: litepaseo ${command} <backup-directory>`);
      if (command === "backup") backup(directory, path);
    else await restore(path, directory);
    console.log(command === "backup" ? "Backup complete. Keep this directory private: it contains credentials." : "Restore complete. Start LitePaseo with this LITEPASEO_HOME.");
    return;
  }
  if (command === "token") {
    console.log(readFileSync(tokenPath, "utf8"));
    return;
  }
  if (command === "totp-reset" || command === "signout-all") {
    const store = new Store(directory);
    if (command === "totp-reset") {
      store.setSetting("totp_secret", null);
      console.log("Authenticator sign-in is off. Sign in with: litepaseo token");
    } else {
      store.revokeSessions();
      console.log("Every browser is signed out; their notifications stop.");
    }
    store.close();
    return;
  }
  if (command === "logs") {
    console.log(existsSync(log) ? readFileSync(log, "utf8").slice(-64000) : "No logs");
    return;
  }
  if (command === "status") {
    console.log(await control("status").catch(() => "Not running or control endpoint unavailable"));
    return;
  }
  if (command === "stop" || command === "restart") {
    console.log(await control("stop").catch(() => "Not running"));
    if (command === "stop") return;
    for (let i = 0; i < 150 && existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));
    if (existsSync(socket)) throw new Error("Previous instance has not stopped");
  }
  if (command === "start" || command === "restart") {
    const running = await control("status").catch(() => null);
    if (running) {
      console.log(running);
      return;
    }
    const logStart = existsSync(log) ? statSync(log).size : 0;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    let exited = false;
    child.on("error", () => {});
    child.once("exit", () => { exited = true; });
    child.unref();
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (exited) throw new Error(lastFailure(logStart) ?? "Startup failed. Run litepaseo logs for details.");
      const ready = await control("status").catch(() => null);
      if (ready && JSON.parse(ready).ready) {
        console.log(ready);
        console.log("Retrieve your browser access token with: litepaseo token");
        return;
      }
    }
    throw new Error(
      "Startup not ready after 10 s. Run litepaseo status or litepaseo logs.",
    );
  }
  if (command === "worker") return runWorker(directory, fileURLToPath(new URL("../web/", import.meta.url)));
  if (command === "serve") return supervise(directory, fileURLToPath(import.meta.url));
  throw new Error("Unknown command. Run litepaseo --help");
}
main().catch((error) => {
  console.error(error.message);
  if (command === "serve" && !(error instanceof StartupFailure)) {
    try { new RotatingLog(log).write(JSON.stringify({ event: "supervisor_start_failed", error: error.message }) + "\n"); } catch {}
  }
  process.exitCode = 1;
});
