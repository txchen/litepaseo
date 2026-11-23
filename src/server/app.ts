import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import { Attachments, MAX_FILE_BYTES } from "./attachments.ts";
import { Auth } from "./auth.ts";
import { compressJson } from "./compression.ts";
import { MAX_DICTATION_BYTES } from "./dictation.ts";
import { DictationStreams } from "./dictation-stream.ts";
import { registerHostSettings } from "./host-settings.ts";
import { UnknownHostError, type Hosts } from "./hosts.ts";
import { notificationPreview } from "./notification-preview.ts";
import { Notifier, webPushSender, type PushSender } from "./notifier.ts";
import { ServerSendQueue } from "./send-queue.ts";
import { streamEncoding } from "./sse.ts";
import type { Store } from "./store.ts";
import { UsageService } from "./usage.ts";
import { VERSION } from "./version.ts";
import { ViewingPresence } from "./viewing-presence.ts";
import { HttpError, type Env, type RouteContext } from "./route-context.ts";
import { apiAuth, registerAuthRoutes } from "./auth-routes.ts";
import { instanceName, registerDirectoryRoutes } from "./directory-routes.ts";
import { registerAgentRoutes } from "./agent-routes.ts";
import { registerTimelineRoutes } from "./timeline-routes.ts";
import { registerMessageRoutes } from "./message-routes.ts";
import { registerProjectRoutes } from "./project-routes.ts";
import { registerDictationRoutes } from "./dictation-routes.ts";
import { registerSuggestionRoutes } from "./suggestion-routes.ts";
import { registerBoardRoutes } from "./board-routes.ts";
import { registerWorkspaceRoutes } from "./workspace-routes.ts";

export interface AppOptions {
  pushSender?: PushSender;
  /** VAPID subject; Apple's push service requires a mailto: or https: URL. */
  pushSubject?: string;
  /** Outbound requests (transcription service, project icon import); replaced in tests. */
  fetch?: typeof fetch;
  /** Compress API responses and live streams for browsers that accept it (default on). */
  compression?: boolean;
}

/**
 * CSP sources for index.html's inline scripts (the theme is pinned before first paint), by hash:
 * exactly the shipped script runs, an injected one does not.
 */
export function inlineScriptHashes(webRoot: string): string[] {
  let html: string;
  try {
    html = readFileSync(join(webRoot, "index.html"), "utf8");
  } catch {
    return [];
  }
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
}

/**
 * The composition root: shared services, middleware, error handling, the route modules and the
 * web app itself. `token` is the access token, or a function returning the current one (it can
 * be rotated).
 */
export function createApp(store: Store, hosts: Hosts, token: string | (() => string), webRoot: string, options: AppOptions = {}) {
  const app = new Hono<Env>();
  const auth = new Auth(store, token);
  const dictationStreams = new DictationStreams(options.fetch, (metrics) => console.info(JSON.stringify({ event: "dictation_complete", ...metrics })));
  const attachments = new Attachments();
  const sendQueue = new ServerSendQueue(store, hosts);
  const presence = new ViewingPresence((id) => (store.sessionById(id)?.expires ?? 0) > Date.now());
  const notifier = new Notifier({
    store,
    sender: options.pushSender ?? webPushSender(store, options.pushSubject ?? "mailto:litepaseo@example.com"),
    isViewing: (key) => presence.isViewing(key),
    deviceActive: () => presence.anyActive(),
    viewedSince: (key, at) => presence.viewedSince(key, at),
    replyPreview: (agent, previous) => notificationPreview(hosts.get(agent.hostId).driver, agent.id, previous.turnStartedAt, agent.attention ? undefined : agent.activityAt),
    hostLabel: (id) => hosts.label(id) || store.hosts().find((h) => h.id === id)?.label || "",
  });
  const stopNotifying = hosts.onTransition((previous, next) => notifier.transition(previous, next));
  const usage = new UsageService(hosts);
  store.pruneSessions(Date.now());
  const compression = options.compression !== false;
  const ctx: RouteContext = {
    store, hosts, auth, attachments, sendQueue, fetch: options.fetch,
    streamValidity: (c) => {
      const session = c.get("session"), bearer = c.get("bearer");
      if (session) return () => auth.stillValid(session.id);
      return () => !!bearer && !auth.totpEnabled() && auth.checkToken(bearer);
    },
    encodingOf: (c) => streamEncoding(c.req.header("Accept-Encoding"), compression),
  };

  // ---- Middleware ---------------------------------------------------------------------------
  const scriptSrc = ["'self'", ...inlineScriptHashes(webRoot)].join(" ");
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'`,
    );
  });
  app.use("/api/*", compressJson(compression));
  app.use("/api/*", (c, next) => bodyLimit({
    maxSize: c.req.method !== "POST" ? 1024 * 1024
      : c.req.path.endsWith("/attachments") ? MAX_FILE_BYTES
      : c.req.path === "/api/dictation/transcribe" ? MAX_DICTATION_BYTES
      : 1024 * 1024,
  })(c, next));
  app.use("/api/*", apiAuth(auth));

  app.onError((error, c) => {
    if (error instanceof UnknownHostError) return c.json({ error: "Unknown host" }, 404);
    if (error instanceof z.ZodError) return c.json({ error: "Invalid request", detail: error.issues }, 400);
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    const requestId = randomUUID();
    // Enough to diagnose from the private service log: where it failed and what failed. The
    // query string is left out (it can carry cursors and filters), and messages are bounded.
    const failure = error as Error & { code?: unknown; cause?: unknown };
    const cause = failure.cause instanceof Error ? failure.cause : null;
    console.error(JSON.stringify({
      time: new Date().toISOString(), event: "api_operation_failed", requestId, method: c.req.method, path: c.req.path, route: c.req.routePath,
      error: failure.name, ...(typeof failure.code === "string" ? { code: failure.code } : {}),
      message: String(failure.message ?? "").slice(0, 500),
      ...(cause ? { cause: `${cause.name}: ${cause.message}`.slice(0, 300) } : {}),
      at: failure.stack?.split("\n").slice(1, 4).map((line) => line.trim()),
    }));
    return c.json({ error: "Operation failed; refresh state before retrying", requestId }, 502);
  });

  // ---- API ----------------------------------------------------------------------------------
  app.get("/api/health", (c) => c.json({ ok: true, version: VERSION, waiting: notifier.waitingCount }));
  registerAuthRoutes(app, ctx, { notifier, presence, instanceName: () => instanceName(store) });
  const directory = registerDirectoryRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerTimelineRoutes(app, ctx);
  registerMessageRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerDictationRoutes(app, ctx, dictationStreams);
  registerSuggestionRoutes(app, ctx);
  const stopHostSettings = registerHostSettings(app, hosts);
  registerWorkspaceRoutes(app, ctx);
  app.get("/api/usage", async (c) => c.json(await usage.report(c.req.query("refresh") === "1")));
  registerBoardRoutes(app, ctx);
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  // ---- The web app ----------------------------------------------------------------------------
  // The service worker and manifest need exact types and must never be cached stale. They are
  // read per request (asynchronously): a rebuilt web root is served at once, without a restart.
  for (const [file, type] of [
    ["sw.js", "text/javascript; charset=utf-8"],
    ["manifest.webmanifest", "application/manifest+json"],
  ] as const)
    app.get("/" + file, async (c) => {
      try {
        return c.body(await readFile(join(webRoot, file)), 200, { "Content-Type": type, "Cache-Control": "no-cache" });
      } catch {
        return c.notFound();
      }
    });
  // Hashed build assets never change under the same name: cache them for good.
  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable");
  });
  // The page names the current hashed assets, so it must always be revalidated.
  app.use("/*", async (c, next) => {
    await next();
    if (c.res.headers.get("Content-Type")?.startsWith("text/html")) c.header("Cache-Control", "no-cache");
  });
  app.use("/*", serveStatic({ root: webRoot, precompressed: true }));

  return Object.assign(app, {
    dictationStreams,
    /** Open directory streams; lets tests prove that disconnects release them. */
    openStreams: directory.openStreams,
    dispose: () => {
      directory.dispose();
      stopHostSettings();
      stopNotifying();
      notifier.dispose();
      sendQueue.close();
      attachments.close();
      dictationStreams.close();
    },
  });
}
