#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { backup, restore } from "./backup.ts";
import { Store } from "./store.ts";
import { Hosts } from "./hosts.ts";
import { createApp } from "./app.ts";
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
let cleanupOnFailure = () => {};
async function main() {
  if (command === "help" || command === "--help") {
    console.log(
      [
        "LitePaseo: start | serve | status | stop | restart | logs | token | totp-reset | signout-all | backup <directory> | restore <directory>",
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
    for (let i = 0; i < 50 && existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));
    if (existsSync(socket)) throw new Error("Previous instance has not stopped");
  }
  if (command === "start" || command === "restart") {
    const running = await control("status").catch(() => null);
    if (running) {
      console.log(running);
      return;
    }
    const fd = openSync(log, "a", 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    child.on("error", () => {});
    child.unref();
    closeSync(fd);
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const ready = await control("status").catch(() => null);
      if (ready && JSON.parse(ready).ready) {
        console.log(ready);
        console.log("Retrieve your browser access token with: litepaseo token");
        return;
      }
    }
    throw new Error(
      "Startup failed. Run litepaseo logs. A stale control.sock requires manual inspection; no process will be killed automatically.",
    );
  }
  if (command !== "serve") throw new Error("Unknown command. Run litepaseo --help");
  // Exclusive socket binding is the instance lock. Never unlink an unverified stale socket.
  const controlServer = createServer({ allowHalfOpen: true }, (s) => {
    s.setTimeout(2000, () => s.destroy());
    let input = "";
    s.on("error", () => {});
    s.on("data", (b) => {
      input += b;
      if (input.length > 64) s.destroy();
    });
    s.on("end", () => {
      if (input === "status") s.end(JSON.stringify({ ready, url, pid: process.pid }) + "\n");
      else if (input === "stop") {
        s.end("Stopping\n");
        void shutdown();
      } else s.end("Unknown command\n");
    });
  });
  let ready = false,
    url = "",
    shutdown = async () => {};
  await new Promise<void>((resolve, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(socket, resolve);
  });
  cleanupOnFailure = () => {
    controlServer.close();
    if (existsSync(socket)) unlinkSync(socket);
  };
  if (!existsSync(tokenPath))
    writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  const store = new Store(directory),
    hosts = new Hosts();
  for (const host of store.hosts()) {
    try {
      hosts.add(host);
    } catch {
      console.error("Could not initialize host", host.id);
    }
  }
  const port = Number(process.env.LITEPASEO_PORT ?? 8787),
    hostname = process.env.LITEPASEO_BIND ?? "127.0.0.1";
  const app = createApp(
    store,
    hosts,
    readFileSync(tokenPath, "utf8").trim(),
    fileURLToPath(new URL("../web/", import.meta.url)),
    { pushSubject: process.env.LITEPASEO_PUSH_SUBJECT },
  );
  const server = serve({ fetch: app.fetch, port, hostname });
  let stopping = false;
  shutdown = async () => {
    if (stopping) return;
    stopping = true;
    ready = false;
    const timer = setTimeout(() => process.exit(1), 5000);
    timer.unref();
    await hosts.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    controlServer.close();
    if (existsSync(socket)) unlinkSync(socket);
    clearTimeout(timer);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  server.once("error", async (error) => {
    console.error(error.message);
    await shutdown();
    process.exitCode = 1;
  });
  server.once("listening", () => {
    ready = true;
    url = `http://${hostname}:${port}`;
    console.log(`LitePaseo ready at ${url}`);
  });
}
main().catch((error) => {
  console.error(error.message);
  cleanupOnFailure();
  process.exitCode = 1;
});
