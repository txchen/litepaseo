#!/usr/bin/env node
import { VERSION } from "./version.ts";
import { RotatingLog } from "./rotating-log.ts";
import { manageService } from "./autostart.ts";
import { FAILED_EVENT, StartupFailure, supervise } from "./supervisor.ts";
import { runWorker } from "./worker.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { backup, restore } from "./backup.ts";
import { Store } from "./store.ts";
import { resolveDataDirectory } from "./data-dir.ts";
import {
  COMMANDS, SERVICE_ACTIONS, UsageError, colorEnabled, commandHelp, findCommand, formatStatus, lastLines,
  mainHelp, makeStyle, parseArgs, suggest, versionNote, type Parsed, type Status,
} from "./cli-format.ts";

/** `status` exit code when nothing is running, as for `systemctl status`. */
const NOT_RUNNING = 3;
const out = makeStyle(colorEnabled(process.env, process.stdout.isTTY));
const err = makeStyle(colorEnabled(process.env, process.stderr.isTTY));
const argv = process.argv.slice(2);
const name = argv[0] ?? "help";

/** Where data lives, for help text only: resolving it for real may migrate a legacy directory. */
const displayDirectory = () =>
  resolve(process.env.LITEPASEO_HOME || process.env.LITEPASEO_DATA_DIR || join(homedir(), ".litepaseo"));

async function dataDirectory() {
  const { directory, notice } = await resolveDataDirectory(process.env, homedir(), process.platform);
  if (notice) console.error(notice);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  process.umask(0o077);
  return { directory, socket: join(directory, "control.sock"), token: join(directory, "token"), log: join(directory, "service.log") };
}
type Paths = Awaited<ReturnType<typeof dataDirectory>>;

function control(socket: string, action: string): Promise<string> {
  return new Promise((done, reject) => {
    const s = connect(socket);
    let text = "";
    s.setTimeout(2000, () => s.destroy(new Error("Control request timed out")));
    s.on("error", reject);
    s.on("connect", () => s.end(action));
    s.on("data", (chunk) => (text += chunk));
    s.on("end", () => done(text));
  });
}
async function status(paths: Paths): Promise<Status | null> {
  const text = await control(paths.socket, "status").catch(() => null);
  if (!text) return null;
  try {
    return JSON.parse(text) as Status;
  } catch {
    return null;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The reason recorded by the supervisor that just stopped, if any. */
function lastFailure(log: string, since: number) {
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

function printStarted(state: Status, already: boolean) {
  console.log(`${out.green("●")} LitePaseo ${state.version ?? ""} ${already ? "is already running" : "is running"} at ${out.cyan(state.url)}`.replace("  ", " "));
  const note = versionNote(state, VERSION, out);
  if (note) console.log(note);
  else if (!already) console.log(out.dim("  Sign in with the access token from: litepaseo token"));
}

async function start(paths: Paths, args: Parsed) {
  const running = await status(paths);
  if (running) {
    if (args.flags.json) console.log(JSON.stringify(running));
    else printStarted(running, true);
    return;
  }
  const logStart = existsSync(paths.log) ? statSync(paths.log).size : 0;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], { detached: true, stdio: "ignore", env: process.env });
  let exited = false;
  child.on("error", () => {});
  child.once("exit", () => { exited = true; });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (exited) throw new Error(lastFailure(paths.log, logStart) ?? "Startup failed. Run 'litepaseo logs' for details.");
    const ready = await status(paths);
    if (ready?.ready) {
      if (args.flags.json) console.log(JSON.stringify(ready));
      else printStarted(ready, false);
      return;
    }
  }
  throw new Error("Startup not ready after 10 s. Run 'litepaseo status' or 'litepaseo logs'.");
}

async function stop(paths: Paths, quiet = false) {
  const reply = await control(paths.socket, "stop").catch(() => null);
  if (!reply) {
    if (!quiet) console.log("LitePaseo is not running.");
    return;
  }
  for (let i = 0; i < 150 && existsSync(paths.socket); i++) await sleep(100);
  if (existsSync(paths.socket)) throw new Error("LitePaseo has not stopped after 15 s. Run 'litepaseo status'.");
  if (!quiet) console.log("LitePaseo stopped.");
}

async function showStatus(paths: Paths, args: Parsed) {
  const state = await status(paths);
  if (args.flags.json) console.log(JSON.stringify(state ?? { running: false }));
  else if (state) console.log(formatStatus(state, VERSION, paths.directory, out));
  else console.log(`${out.dim("○")} LitePaseo is not running\n  ${out.dim("Start it with: litepaseo start")}`);
  if (!state) process.exitCode = NOT_RUNNING;
}

async function logs(paths: Paths, args: Parsed) {
  const count = args.flags.lines === undefined ? 100 : Number(args.flags.lines);
  if (!Number.isInteger(count) || count < 0) throw new UsageError("--lines needs a whole number.");
  // Older lines come from the newest archive when the current file is short.
  let text = existsSync(paths.log) ? readFileSync(paths.log, "utf8") : "";
  if (text.split("\n").length <= count && existsSync(paths.log + ".1")) text = readFileSync(paths.log + ".1", "utf8") + text;
  const tail = lastLines(text, count);
  if (tail) process.stdout.write(tail.endsWith("\n") ? tail : tail + "\n");
  else if (!args.flags.follow) console.log(out.dim(`No logs yet in ${paths.log}`));
  if (!args.flags.follow) return;
  let position = existsSync(paths.log) ? statSync(paths.log).size : 0;
  let inode = existsSync(paths.log) ? statSync(paths.log).ino : 0;
  for (;;) {
    await sleep(500);
    if (!existsSync(paths.log)) continue;
    const info = statSync(paths.log);
    // Rotated or truncated: the current file starts over.
    if (info.ino !== inode || info.size < position) [position, inode] = [0, info.ino];
    if (info.size === position) continue;
    const fd = openSync(paths.log, "r");
    try {
      const chunk = Buffer.alloc(info.size - position);
      const read = readSync(fd, chunk, 0, chunk.length, position);
      process.stdout.write(chunk.subarray(0, read));
      position += read;
    } finally {
      closeSync(fd);
    }
  }
}

async function version(args: Parsed) {
  const paths = await dataDirectory();
  const state = await status(paths);
  const details = {
    version: VERSION, node: process.versions.node, platform: `${process.platform}-${process.arch}`,
    home: paths.directory, running: state ? (state.version ?? "unknown") : null,
  };
  if (args.flags.json) return console.log(JSON.stringify(details));
  const row = (label: string, value: string) => `  ${out.dim(label.padEnd(10))}${value}`;
  console.log([
    `${out.bold("LitePaseo")} ${VERSION}`,
    row("Node.js", details.node),
    row("Platform", details.platform),
    row("Data", details.home),
    row("Running", state ? `${details.running} at ${out.cyan(state.url)}` : out.dim("not running")),
  ].join("\n"));
  if (state) {
    const note = versionNote(state, VERSION, out);
    if (note) console.log("\n" + note);
  }
}

async function run(): Promise<void> {
  if (name === "--version" || name === "-v" || name === "-V") return console.log(VERSION);
  if (name === "--help" || name === "-h") return console.log(mainHelp(VERSION, displayDirectory(), out));
  // Internal: the supervisor forks this to run the server.
  if (name === "worker") {
    const paths = await dataDirectory();
    return runWorker(paths.directory, fileURLToPath(new URL("../web/", import.meta.url)));
  }
  const command = findCommand(name);
  if (!command) {
    const guess = suggest(name, COMMANDS.map((c) => c.name));
    throw new UsageError(`Unknown command '${name}'.${guess ? ` Did you mean '${guess}'?` : ""}`);
  }
  const args = parseArgs(command, argv.slice(1));
  if (args.help) return console.log(commandHelp(command, out));

  switch (command.name) {
    case "help": {
      const topic = args.positional[0];
      if (!topic) return console.log(mainHelp(VERSION, displayDirectory(), out));
      const target = findCommand(topic);
      if (!target) {
        const guess = suggest(topic, COMMANDS.map((c) => c.name));
        throw new UsageError(`No help for '${topic}'.${guess ? ` Did you mean '${guess}'?` : ""}`);
      }
      return console.log(commandHelp(target, out));
    }
    case "version":
      return version(args);
  }

  const paths = await dataDirectory();
  switch (command.name) {
    case "start":
      return start(paths, args);
    case "stop":
      return stop(paths);
    case "restart":
      await stop(paths, true);
      return start(paths, args);
    case "status":
      return showStatus(paths, args);
    case "logs":
      return logs(paths, args);
    case "serve":
      return supervise(paths.directory, fileURLToPath(import.meta.url));
    case "token":
      if (!existsSync(paths.token)) throw new Error("No access token yet: it is created on first start. Run 'litepaseo start'.");
      return console.log(readFileSync(paths.token, "utf8").trim());
    case "totp-reset":
    case "signout-all": {
      const store = new Store(paths.directory);
      try {
        if (command.name === "totp-reset") {
          store.setSetting("totp_secret", null);
          console.log("Authenticator sign-in is off. Sign in with the token from: litepaseo token");
        } else {
          store.revokeSessions();
          console.log("Every browser is signed out; their notifications stop.");
        }
      } finally {
        store.close();
      }
      return;
    }
    case "backup":
      backup(paths.directory, args.positional[0]!);
      return console.log("Backup complete. Keep this directory private: it contains credentials.");
    case "restore":
      await restore(args.positional[0]!, paths.directory);
      return console.log(`Restore complete into ${paths.directory}. Start it with: litepaseo start`);
    case "service": {
      const action = args.positional[0] ?? "print";
      if (!(SERVICE_ACTIONS as readonly string[]).includes(action)) {
        const guess = suggest(action, SERVICE_ACTIONS);
        throw new UsageError(`Unknown service action '${action}'.${guess ? ` Did you mean '${guess}'?` : ""} Actions: ${SERVICE_ACTIONS.join(", ")}.`);
      }
      return console.log(manageService(action, {
        platform: process.platform, home: homedir(), directory: paths.directory, node: process.execPath,
        cli: fileURLToPath(import.meta.url), env: process.env, uid: process.getuid?.() ?? 0,
      }));
    }
  }
}

run().catch(async (error) => {
  if (error instanceof UsageError) {
    console.error(`${err.red("error:")} ${error.message}`);
    const command = findCommand(name);
    console.error(err.dim(command && name !== "help" ? `Run 'litepaseo ${name} --help' for usage.` : "Run 'litepaseo --help' for the list of commands."));
    process.exitCode = 2;
    return;
  }
  console.error(`${err.red("error:")} ${error.message}`);
  if (name === "serve" && !(error instanceof StartupFailure)) {
    try {
      const paths = await dataDirectory();
      new RotatingLog(paths.log).write(JSON.stringify({ event: "supervisor_start_failed", error: error.message }) + "\n");
    } catch {}
  }
  process.exitCode = 1;
});
