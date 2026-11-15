import { randomUUID } from "node:crypto";
import type { Hosts } from "./hosts.ts";
export type LifecycleJob = {
  action: "restart" | "update";
  state: "running" | "complete" | "failed";
  phase: string;
  version?: string;
  error?: string;
};
export function replacementReady(
  previous: { serverId: string; pid: number; startedAt?: string | null },
  current: { serverId: string; pid: number; startedAt?: string | null; version?: string | null },
  expected?: string,
) {
  if (current.serverId !== previous.serverId)
    throw new Error("Daemon identity changed; verify the host connection.");
  if (
    current.pid === previous.pid &&
    (!previous.startedAt || !current.startedAt || previous.startedAt === current.startedAt)
  )
    return false;
  if (expected && current.version !== expected)
    throw new Error(
      `Installed ${expected}, but the running daemon reports ${current.version ?? "unknown"}.`,
    );
  return true;
}
const reconnectFailure = (e: unknown) =>
  ["DAEMON_CONNECTION_LOST", "DAEMON_REQUEST_TIMEOUT", "DAEMON_NOT_CONNECTED"].includes(
    String((e as { code?: unknown })?.code),
  );
export async function runLifecycle(hosts: Hosts, host: string, job: LifecycleJob) {
  const driver = hosts.get(host).driver;
  let unsubscribe = () => {};
  try {
    const previous = await driver.getDaemonStatus();
    let expected: string | undefined;
    if (job.action === "update") {
      const requestId = randomUUID();
      unsubscribe = driver.on("daemon.update.progress", (event) => {
        if (event.payload.requestId === requestId) job.phase = event.payload.phase;
      });
      const result = await driver.updateDaemon(requestId);
      if (!result.success) throw new Error(result.error ?? "Package installation failed.");
      if (!result.newVersion)
        throw new Error(
          "Package installation reported no version; verify the host before retrying.",
        );
      expected = result.newVersion;
    } else {
      try {
        await driver.restartServer("Requested from LitePaseo host settings");
      } catch (e) {
        if (!reconnectFailure(e)) throw e;
      }
    }
    job.phase = "Waiting for the replacement daemon";
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      if (!hosts.clients.has(host)) throw new Error("Host removed while waiting for restart.");
      if (driver.getConnectionState().status === "connected") {
        try {
          const status = await driver.getDaemonStatus();
          const current = { ...status, version: status.version ?? driver.getLastServerInfoMessage()?.version };
          if (replacementReady(previous, current, expected)) {
            job.version = current.version ?? undefined;
            job.state = "complete";
            job.phase = "Replacement daemon verified";
            return;
          }
        } catch (e) {
          if (!reconnectFailure(e)) throw e;
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        timer.unref();
      });
    }
    throw new Error(
      "Replacement daemon could not be verified within ten minutes. Check host status and logs before retrying.",
    );
  } catch (e) {
    job.state = "failed";
    job.error = (e as Error).message;
    job.phase = "Not confirmed";
  } finally {
    unsubscribe();
  }
}
