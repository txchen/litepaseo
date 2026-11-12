import { serve } from "@hono/node-server";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Store } from "./store.ts";
import { Hosts } from "./hosts.ts";
import { createApp } from "./app.ts";

export async function runWorker(directory: string, webRoot: string) {
  if (!process.send) throw new Error("worker is an internal supervised command");
  const tokenPath = join(directory, "token");
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  const store = new Store(directory), hosts = new Hosts();
  for (const host of store.hosts()) {
    try { hosts.add(host); } catch { console.error("Could not initialize host", host.id); }
  }
  const port = Number(process.env.LITEPASEO_PORT ?? 8787), hostname = process.env.LITEPASEO_BIND ?? "127.0.0.1";
  const app = createApp(store, hosts, readFileSync(tokenPath, "utf8").trim(), webRoot,
    { pushSubject: process.env.LITEPASEO_PUSH_SUBJECT });
  const server = serve({ fetch: app.fetch, port, hostname });
  app.dictationStreams.attach(server as import("node:http").Server);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => process.exit(1), 5000); timer.unref();
    app.dispose();
    await hosts.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    if (process.connected) process.disconnect();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("disconnect", () => void shutdown());
  server.once("error", (error: NodeJS.ErrnoException) => {
    const message = error.code === "EADDRINUSE" ? `Port ${port} on ${hostname} is already in use (set LITEPASEO_PORT to use another)`
      : error.code === "EACCES" ? `Not permitted to listen on ${hostname}:${port}` : error.message;
    console.error(message);
    process.send?.({ type: "fatal", error: message });
    process.exitCode = 1;
    void shutdown();
  });
  server.once("listening", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const url = `http://${hostname}:${actualPort}`;
    console.log(`LitePaseo ready at ${url}`);
    process.send?.({ type: "ready", url });
  });
}
