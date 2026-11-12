import { createServer, connect } from "node:net";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { acquireRuntimeLock } from "./runtime-lock.ts";
import { RotatingLog } from "./rotating-log.ts";
import { VERSION } from "./version.ts";

/** Called only while holding the runtime lock; timeouts/permission errors are never proof of death. */
export async function recoverSocket(path: string) {
  if (!existsSync(path)) return;
  const before = lstatSync(path);
  if (!before.isSocket()) throw new Error("Control endpoint is not a socket; inspect it manually.");
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path);
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Control endpoint did not answer; refusing recovery.")); });
    socket.once("connect", () => { socket.destroy(); reject(new Error("A running instance owns the control socket.")); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(); else reject(error);
    });
  });
  if (!existsSync(path)) return;
  const after = lstatSync(path);
  if (before.ino !== after.ino || before.dev !== after.dev) throw new Error("Control socket changed during recovery.");
  unlinkSync(path);
}

/** Crashes of a worker that ran less than this long count toward giving up. */
const STABLE_MS = 60_000;
/** Consecutive quick crashes after which the supervisor stops instead of looping. */
export const MAX_QUICK_CRASHES = 5;
/** Recorded in service.log; `litepaseo start` reports it when startup fails. */
export const FAILED_EVENT = "supervisor_failed";

export class StartupFailure extends Error {}

/**
 * Runs the worker. A worker that fails before it is ready (port in use, unreadable data, bad
 * configuration) is not retried: the supervisor exits with the reason. A worker that crashes
 * after it served is restarted with backoff, but repeated quick crashes also end the supervisor.
 * Either way the exit is a deliberate failure, which the service unit does not restart.
 */
export async function supervise(directory: string, cliPath: string, options: { restartDelayMs?: number } = {}) {
  const baseDelay = options.restartDelayMs ?? 250;
  const release = acquireRuntimeLock(directory);
  const path = join(directory, "control.sock");
  let server: ReturnType<typeof createServer> | undefined;
  let bound = false;
  try {
    const log = new RotatingLog(join(directory, "service.log"), Number(process.env.LITEPASEO_LOG_BYTES ?? 5 * 1024 * 1024), Number(process.env.LITEPASEO_LOG_ARCHIVES ?? 3));
    await recoverSocket(path);
    let child: ChildProcess | null = null, stopping = false, ready = false, url = "", restarts = 0;
    let failure: string | null = null, lastError = "";
    const startedAt = new Date().toISOString();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const fail = (reason: string) => {
      failure = reason;
      log.write(JSON.stringify({ event: FAILED_EVENT, error: reason }) + "\n");
      finish();
    };
    const stop = () => {
      if (stopping) return;
      stopping = true; ready = false; clearTimeout(retry);
      if (!child) return finish();
      const current = child;
      current.kill("SIGTERM");
      killTimer = setTimeout(() => current.kill("SIGKILL"), 6000);
    };
    const launch = () => {
      if (stopping) return;
      const started = Date.now();
      let served = false, reason = "";
      const current = fork(cliPath, ["worker"], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, LITEPASEO_HOME: directory } });
      child = current;
      current.stdout?.on("data", data => log.write(data));
      current.stderr?.on("data", data => {
        log.write(data);
        const lines = String(data).trim().split("\n");
        reason = (lines[lines.length - 1] ?? "").slice(0, 300) || reason;
      });
      current.on("message", (message: any) => {
        if (child !== current || stopping) return;
        if (message?.type === "ready" && typeof message.url === "string") { ready = served = true; url = message.url; }
        if (message?.type === "fatal" && typeof message.error === "string") reason = message.error.slice(0, 300);
      });
      current.once("error", () => log.write("Worker process failed to start.\n"));
      current.once("close", (code, signal) => {
        child = null; ready = false; clearTimeout(killTimer);
        if (stopping) return finish();
        const detail = reason || `worker exited (${signal ?? code})`;
        lastError = detail;
        if (!served) return fail("Worker failed to start: " + detail);
        if (Date.now() - started > STABLE_MS) restarts = 0;
        if (restarts >= MAX_QUICK_CRASHES) return fail(`Worker crashed ${restarts + 1} times in a row: ${detail}`);
        const delay = Math.min(30_000, baseDelay * 2 ** restarts++);
        log.write(JSON.stringify({ event: "worker_restart", code, signal, delay, error: detail }) + "\n");
        retry = setTimeout(launch, delay);
      });
    };
    server = createServer({ allowHalfOpen: true }, socket => {
      let input = "";
      socket.setTimeout(2000, () => socket.destroy()); socket.on("error", () => {});
      socket.on("data", chunk => { input += chunk; if (input.length > 64) socket.destroy(); });
      socket.on("end", () => {
        if (input === "status") socket.end(JSON.stringify({ ready, url, version: VERSION, startedAt, pid: process.pid, workerPid: child?.pid ?? null, restarts, ...(lastError ? { lastError } : {}) }) + "\n");
        else if (input === "stop") { socket.end("Stopping\n"); stop(); }
        else socket.end("Unknown command\n");
      });
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(path, resolve); });
    bound = true;
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    launch();
    await done;
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    if (failure) throw new StartupFailure(failure);
  } finally {
    if (bound) await new Promise<void>(resolve => server!.close(() => resolve()));
    release();
  }
}
