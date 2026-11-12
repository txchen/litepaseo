import { VERSION } from "./version.ts";
import { eventStream } from "./sse.ts";
import { registerWorkspaceRoutes } from "./workspace-routes.ts";
import { Attachments, MAX_FILE_BYTES } from "./attachments.ts";
import { confirmedMessages } from "./message-status.ts";
import { IconCache, MAX_IMAGE_BYTES, imageMime, isLocalConnection, isMaterializedImagePath, readMaterializedImage } from "./media.ts";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import { z } from "zod";
import { AgentPermissionResponseSchema } from "@getpaseo/protocol/messages";
import { parseHostTarget } from "@getpaseo/client/node";
import { Store, type LoginSession } from "./store.ts";
import { Auth, SESSION_TTL_MS } from "./auth.ts";
import { Notifier, vapidKeys, webPushSender, type PushSender } from "./notifier.ts";
import { UsageService } from "./usage.ts";
import { MAX_DICTATION_BYTES, DictationError, clearDictation, dictationConfig, dictationSettings, saveDictation, transcribe } from "./dictation.ts";
import { DictationStreams } from "./dictation-stream.ts";
import { Hosts, UnknownHostError } from "./hosts.ts";
import { rewindModes } from "./host-directory.ts";
import type {
  CreateSessionRequest,
  DirectoryMessage,
  HostState,
  ProjectOption,
  ProviderOption,
  TimelineItem,
  TimelineMessage,
  TimelinePage,
  PromptIndex,
  AgentConfigChange,
  AgentConfigOptions,
  AgentFeatureOption,
} from "../shared/wire.ts";

const AGENT_FLUSH_MS = 100;
const HOST_FLUSH_MS = 100;

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return null;
  }
}

export const CARD_DESCRIPTION_MAX = 20_000, CARD_COMMENT_MAX = 5_000, CARD_COMMENTS_MAX = 200;
const cardComment = z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(CARD_COMMENT_MAX), at: z.number().int().nonnegative() });
const card = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(300),
    column: z.enum(["Todo", "Doing", "Done"]),
    hostId: z.string().nullable(),
    agentId: z.string().nullable(),
    description: z.string().max(CARD_DESCRIPTION_MAX).optional(),
    comments: z.array(cardComment).max(CARD_COMMENTS_MAX).optional(),
    createdAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative().optional(),
  })
  .refine((c) => (c.hostId === null) === (c.agentId === null));
/** One card's editable fields; omitted fields are left as they are. */
const cardPatch = z
  .object({
    title: z.string().trim().min(1).max(300),
    column: z.enum(["Todo", "Doing", "Done"]),
    description: z.string().max(CARD_DESCRIPTION_MAX),
    link: z.object({ hostId: z.string(), agentId: z.string() }).nullable(),
  })
  .partial();
const SESSION_COOKIE = "lp_session";
/** Cookie-authenticated writes must carry this header; a cross-site form or image cannot. */
const CSRF_HEADER = "x-litepaseo";
const PUBLIC_API = new Set(["/api/auth", "/api/login"]);

export interface AppOptions {
  pushSender?: PushSender;
  /** VAPID subject; Apple's push service requires a mailto: or https: URL. */
  pushSubject?: string;
  /** Outbound requests to the transcription service; replaced in tests. */
  fetch?: typeof fetch;
}

/** `session` for a browser, or `bearer` (the accepted token) for a script on a direct connection. */
type Env = { Variables: { session: LoginSession | null; bearer: string | null } };

/**
 * Requests that arrived through a tunnel or reverse proxy. A bearer token is never accepted from
 * them: over the network, only the browser sign-in (with its rate limits and optional
 * authenticator code) admits anyone.
 */
const proxied = (c: { req: { header: (name: string) => string | undefined } }) =>
  ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "forwarded"].some((name) => c.req.header(name) !== undefined);

/** `token` is the access token, or a function returning the current one (it can be rotated). */
export function createApp(store: Store, hosts: Hosts, token: string | (() => string), webRoot: string, options: AppOptions = {}) {
  const app = new Hono<Env>();
  const auth = new Auth(store, token);
  const dictationStreams = new DictationStreams(options.fetch, (metrics) => console.info(JSON.stringify({ event: "dictation_complete", ...metrics })));
  const attachments = new Attachments();
  const projectIcons = new IconCache();
  const viewers = new Map<string, Map<string, number>>();
  const notifier = new Notifier({
    store,
    sender: options.pushSender ?? webPushSender(store, options.pushSubject ?? "mailto:litepaseo@example.com"),
    isViewing: (key, sessionId) => (viewers.get(key)?.get(sessionId) ?? 0) > 0,
    hostLabel: (id) => hosts.label(id) || store.hosts().find((h) => h.id === id)?.label || "",
  });
  hosts.onTransition((previous, next) => notifier.transition(previous, next));
  const usage = new UsageService(hosts);
  store.pruneSessions(Date.now());
  const secure = (c: { req: { url: string; header: (name: string) => string | undefined } }) =>
    c.req.header("x-forwarded-proto") === "https" || c.req.url.startsWith("https:");
  const clientId = (c: { req: { header: (name: string) => string | undefined } }) =>
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "direct";
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'",
    );
  });
  app.use("/api/*", (c, next) => bodyLimit({
    maxSize: c.req.method !== "POST" ? 1024 * 1024
      : c.req.path.endsWith("/attachments") ? MAX_FILE_BYTES
      : c.req.path === "/api/dictation/transcribe" ? MAX_DICTATION_BYTES
      : 1024 * 1024,
  })(c, next));
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.set("bearer", null);
    const bearer = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (bearer && !PUBLIC_API.has(c.req.path) && !auth.totpEnabled() && !proxied(c)) {
      const result = auth.bearer(bearer, clientId(c));
      if (!result.ok) {
        if (result.retryAfter) c.header("Retry-After", String(result.retryAfter));
        return c.json({ error: result.status === 429 ? "Too many attempts. Try again later." : "Sign in required" }, result.status);
      }
      c.set("session", null);
      c.set("bearer", bearer);
      return next();
    }
    // One session lookup per request. The cookie is reissued only when the sliding expiry
    // actually moved (at most hourly), and never on login/logout, which set their own cookie.
    const secret = getCookie(c, SESSION_COOKIE);
    const found = auth.authenticate(secret);
    const session = found?.session ?? null;
    if (found?.renewed && secret && c.req.path !== "/api/login" && c.req.path !== "/api/logout")
      setCookie(c, SESSION_COOKIE, secret, {
        httpOnly: true, secure: secure(c), sameSite: "Strict", path: "/",
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      });
    if (PUBLIC_API.has(c.req.path)) {
      c.set("session", session);
      return next();
    }
    if (!session) return c.json({ error: "Sign in required" }, 401);
    if (!["GET", "HEAD"].includes(c.req.method) && c.req.header(CSRF_HEADER) !== "1")
      return c.json({ error: "Missing request header" }, 403);
    c.set("session", session);
    await next();
  });

  // ---- Sign-in, sessions and two-factor ------------------------------------------------------
  app.get("/api/auth", (c) => c.json({ authenticated: !!c.get("session"), totp: auth.totpEnabled() }));
  app.post("/api/login", async (c) => {
    const input = z
      .object({ token: z.string().min(1).max(200).optional(), code: z.string().regex(/^\d{6}$/).optional() })
      .refine((x) => !!x.token || !!x.code)
      .parse(await c.req.json());
    const userAgent = c.req.header("user-agent") ?? "";
    const label =
      (/iPhone|iPad/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : /Mac OS/.test(userAgent) ? "macOS" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : "Browser") +
      (/Edg\//.test(userAgent) ? " · Edge" : /Chrome\//.test(userAgent) ? " · Chrome" : /Firefox\//.test(userAgent) ? " · Firefox" : /Safari\//.test(userAgent) ? " · Safari" : "");
    const result = auth.login(input, clientId(c), label);
    if (!result.ok) {
      if (result.retryAfter) c.header("Retry-After", String(result.retryAfter));
      return c.json(
        { error: result.status === 429 ? "Too many attempts. Try again later." : "That did not match." },
        result.status,
      );
    }
    setCookie(c, SESSION_COOKIE, result.secret, {
      httpOnly: true,
      secure: secure(c),
      sameSite: "Strict",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.json({ ok: true });
  });
  app.post("/api/logout", (c) => {
    const session = c.get("session");
    if (session) { auth.revoke(session.id); attachments.clearOwner(session.id); }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  app.get("/api/sessions", (c) =>
    c.json(
      store.sessions().map((s) => ({
        id: s.id,
        label: s.label,
        created: s.created,
        lastSeen: s.lastSeen,
        current: s.id === c.get("session")?.id,
      })),
    ),
  );
  app.delete("/api/sessions/:id", (c) => {
    auth.revoke(c.req.param("id"));
    if (c.req.param("id") === c.get("session")?.id) deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  app.post("/api/sessions/revoke-all", (c) => {
    auth.revoke();
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  const requireSession = (session: LoginSession | null) => {
    if (!session) throw new z.ZodError([{ code: "custom", path: [], message: "A browser session is required", input: null }]);
    return session;
  };
  app.post("/api/totp/setup", async (c) => {
    const session = requireSession(c.get("session"));
    if (auth.totpEnabled()) return c.json({ error: "Disable the current authenticator before replacing it." }, 409);
    const { secret, uri } = auth.beginTotp(session.id);
    const qr = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return c.json({ secret, uri, qr: "data:image/svg+xml;base64," + Buffer.from(qr).toString("base64") });
  });
  app.post("/api/totp/confirm", async (c) => {
    const session = requireSession(c.get("session"));
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(await c.req.json());
    if (!auth.confirmTotp(session.id, code)) return c.json({ error: "That code did not match. Try the next one." }, 400);
    return c.json({ ok: true });
  });
  app.post("/api/totp/disable", async (c) => {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(await c.req.json());
    if (!auth.disableTotp(code)) return c.json({ error: "That code did not match." }, 400);
    return c.json({ ok: true });
  });

  // ---- Push notifications --------------------------------------------------------------------
  const prefsSchema = z.object({ attention: z.boolean(), turns: z.boolean() });
  app.get("/api/push/key", (c) => c.json({ publicKey: vapidKeys(store).publicKey }));
  app.post("/api/push/subscribe", async (c) => {
    const session = requireSession(c.get("session"));
    const input = z
      .object({
        subscription: z.object({
          endpoint: z.string().url().max(2000).refine((u) => u.startsWith("https://")),
          keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
        }),
        prefs: prefsSchema,
      })
      .parse(await c.req.json());
    store.savePushSubscription({
      endpoint: input.subscription.endpoint,
      sessionId: session.id,
      p256dh: input.subscription.keys.p256dh,
      auth: input.subscription.keys.auth,
      prefs: input.prefs,
      created: Date.now(),
    });
    return c.json({ ok: true });
  });
  app.post("/api/push/status", async (c) => {
    const { endpoint } = z.object({ endpoint: z.string().max(2000) }).parse(await c.req.json());
    const found = store.pushSubscriptions().find((s) => s.endpoint === endpoint);
    return c.json(found ? { subscribed: true, prefs: found.prefs } : { subscribed: false });
  });
  app.post("/api/push/unsubscribe", async (c) => {
    const { endpoint } = z.object({ endpoint: z.string().max(2000) }).parse(await c.req.json());
    store.removePushSubscription(endpoint);
    return c.json({ ok: true });
  });
  app.post("/api/push/test", async (c) => {
    const session = requireSession(c.get("session"));
    return c.json({ sent: await notifier.test(session.id) });
  });
  app.onError((error, c) => {
    if (error instanceof UnknownHostError) return c.json({ error: "Unknown host" }, 404);
    if (error instanceof z.ZodError) return c.json({ error: "Invalid request", detail: error.issues }, 400);
    const requestId = randomUUID();
    // Enough to diagnose from the private service log: where it failed and what failed. The
    // query string is left out (it can carry cursors and filters), and messages are bounded.
    const failure = error as Error & { code?: unknown; cause?: unknown };
    const cause = failure.cause instanceof Error ? failure.cause : null;
    console.error(JSON.stringify({
      event: "api_operation_failed", requestId, method: c.req.method, path: c.req.path, route: c.req.routePath,
      error: failure.name, ...(typeof failure.code === "string" ? { code: failure.code } : {}),
      message: String(failure.message ?? "").slice(0, 500),
      ...(cause ? { cause: `${cause.name}: ${cause.message}`.slice(0, 300) } : {}),
      at: failure.stack?.split("\n").slice(1, 4).map((line) => line.trim()),
    }));
    return c.json({ error: "Operation failed; refresh state before retrying", requestId }, 502);
  });
  app.get("/api/health", (c) => c.json({ ok: true, version: VERSION, waiting: notifier.waitingCount }));
  const hostStates = (): HostState[] =>
    store.hosts().map((h) => ({ id: h.id, label: h.label, state: hosts.state(h.id), diagnostic: hosts.diagnostic(h.id) }));
  app.get("/api/hosts", (c) => c.json(hostStates()));

  // Directory streams. Each remembers the last collection seq it delivered, so a flush sends
  // only entries changed since then: O(changes) per flush, independent of directory size.
  type DirectoryStream = { last: number; lastWorkspaces: number; send: (message: DirectoryMessage) => void };
  const directoryStreams = new Set<DirectoryStream>();
  let agentFlush: ReturnType<typeof setTimeout> | undefined;
  let hostFlush: ReturnType<typeof setTimeout> | undefined;
  /** Set on shutdown: closing the hosts still reports changes, but the store is about to close. */
  let disposed = false;
  const deliverAgents = (stream: DirectoryStream) => {
    deliverWorkspaces(stream);
    const { agents } = hosts;
    const changes = agents.changesSince(stream.last);
    if (changes === null)
      stream.send({
        type: "snapshot",
        generation: agents.generation,
        seq: agents.seq,
        agents: agents.snapshot(),
      });
    else if (changes.length)
      stream.send({ type: "changes", generation: agents.generation, seq: agents.seq, changes });
    stream.last = agents.seq;
  };
  const deliverWorkspaces = (stream: DirectoryStream) => {
    const { workspaces } = hosts;
    const changes = workspaces.changesSince(stream.lastWorkspaces);
    if (changes === null)
      stream.send({
        type: "workspaces-snapshot",
        generation: workspaces.generation,
        seq: workspaces.seq,
        workspaces: workspaces.snapshot(),
      });
    else if (changes.length)
      stream.send({ type: "workspaces-changes", generation: workspaces.generation, seq: workspaces.seq, changes });
    stream.lastWorkspaces = workspaces.seq;
  };
  hosts.onAgentsChanged(() => {
    if (disposed || agentFlush || !directoryStreams.size) return;
    agentFlush = setTimeout(() => {
      agentFlush = undefined;
      for (const stream of directoryStreams) deliverAgents(stream);
    }, AGENT_FLUSH_MS);
  });
  hosts.onHostsChanged(() => {
    if (disposed || hostFlush || !directoryStreams.size) return;
    hostFlush = setTimeout(() => {
      hostFlush = undefined;
      const message: DirectoryMessage = { type: "hosts", hosts: hostStates() };
      for (const stream of directoryStreams) stream.send(message);
    }, HOST_FLUSH_MS);
  });
  /** Re-checked on heartbeat: a revoked session, or a rotated token, loses its open streams. */
  const streamValidity = (c: { get: <K extends keyof Env["Variables"]>(key: K) => Env["Variables"][K] }) => {
    const session = c.get("session"), bearer = c.get("bearer");
    if (session) return () => auth.stillValid(session.id);
    return () => !!bearer && !auth.totpEnabled() && auth.checkToken(bearer);
  };
  app.get("/api/stream", (c) => {
    const since = Number(c.req.query("since"));
    const resumable =
      c.req.query("generation") === hosts.agents.generation && Number.isInteger(since);
    const wsince = Number(c.req.query("wsince"));
    const wresumable =
      c.req.query("wgeneration") === hosts.workspaces.generation && Number.isInteger(wsince);
    return eventStream(c.req.raw.signal, (send) => {
      const stream: DirectoryStream = { last: resumable ? since : -1, lastWorkspaces: wresumable ? wsince : -1, send };
      send({ type: "hosts", hosts: hostStates() });
      deliverAgents(stream);
      directoryStreams.add(stream);
      return () => directoryStreams.delete(stream);
    }, streamValidity(c));
  });
  app.post("/api/hosts", async (c) => {
    const input = z
      .object({
        label: z.string().trim().min(1).max(80),
        connection: z.string().trim().min(1).max(16000),
      })
      .parse(await c.req.json());
    parseHostTarget(input.connection);
    const host = store.addHost(input.label, input.connection);
    try {
      hosts.add(host);
    } catch (e) {
      store.removeHost(host.id);
      throw e;
    }
    return c.json({ id: host.id, label: host.label }, 201);
  });
  app.delete("/api/hosts/:host", async (c) => {
    await hosts.remove(c.req.param("host"));
    store.removeHost(c.req.param("host"));
    return c.json({ ok: true });
  });
  // ---- New sessions ---------------------------------------------------------------------------
  /** Providers the host can start right now, read from the daemon's provider snapshot. */
  app.get("/api/hosts/:host/providers", async (c) => {
    const snapshot = await hosts.get(c.req.param("host")).api.providers.snapshot();
    const providers: ProviderOption[] = snapshot.entries
      .filter((entry) => entry.enabled !== false && entry.status !== "unavailable")
      .map((entry) => ({
        id: entry.provider,
        label: entry.label ?? entry.provider,
        status: entry.status,
        ...(entry.error ? { error: entry.error } : {}),
        defaultModeId: entry.defaultModeId ?? null,
        modes: (entry.modes ?? []).map((m) => ({
          id: m.id,
          label: m.label,
          ...(m.description ? { description: m.description } : {}),
        })),
        models: (entry.models ?? [])
          .filter((m) => m.isSelectable !== false)
          .map((m) => ({
            id: m.id,
            label: m.label,
            ...(m.description ? { description: m.description } : {}),
            isDefault: m.isDefault === true,
            thinking: (m.thinkingOptions ?? []).map((t) => ({ id: t.id, label: t.label })),
            defaultThinkingId: m.defaultThinkingOptionId ?? null,
          })),
      }));
    return c.json(providers);
  });
  /** Projects the daemon knows, as starting points for a new session. */
  app.get("/api/hosts/:host/projects", async (c) => {
    const result = await hosts.get(c.req.param("host")).api.projects.list();
    const projects: ProjectOption[] = result.projects.map((p) => ({
      key: p.projectKey ?? p.projectId,
      name: p.projectCustomName || p.projectDisplayName,
      rootPath: p.projectRootPath,
      kind: p.projectKind,
    }));
    return c.json(projects);
  });
  /**
   * Starts a session. The browser's idempotency key travels to the daemon, so retrying after an
   * unknown outcome cannot create a second session.
   */
  app.post("/api/hosts/:host/agents", async (c) => {
    const input = z
      .object({
        idempotencyKey: z.string().uuid(),
        cwd: z.string().trim().min(1).max(4096),
        provider: z.string().trim().min(1).max(200).regex(/^[^/]+$/),
        model: z.string().trim().min(1).max(300).optional(),
        modeId: z.string().trim().min(1).max(200).optional(),
        thinkingOptionId: z.string().trim().min(1).max(200).optional(),
        prompt: z.string().max(100000).optional(),
        worktreeBranch: z.string().trim().min(1).max(200).optional(),
      })
      .parse(await c.req.json()) satisfies CreateSessionRequest;
    const hostId = c.req.param("host");
    const { api } = hosts.get(hostId);
    try {
      let model = input.model;
      if (!model) {
        const snapshot = await api.providers.snapshot();
        const provider = snapshot.entries.find(p => p.provider === input.provider && p.enabled !== false && p.status !== "unavailable");
        const models = provider?.models?.filter(m => m.isSelectable !== false) ?? [];
        model = models.find(m => m.isDefault)?.id ?? models[0]?.id;
        if (!model) return c.json({ error: "No selectable model is available for this provider. Refresh providers and select a model." }, 400);
      }
      const agent = await api.agents.create({
        idempotencyKey: input.idempotencyKey,
        cwd: input.cwd,
        config: {
          provider: `${input.provider}/${model}`,
          ...(input.modeId ? { modeId: input.modeId } : {}),
          ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
        },
        ...(input.prompt?.trim() ? { prompt: input.prompt } : {}),
        ...(input.worktreeBranch
          ? { worktree: { mode: "branch-off" as const, newBranch: input.worktreeBranch } }
          : {}),
      });
      return c.json({ id: agent.id, key: `${hostId}:${agent.id}` }, 201);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error && error.message
              ? `Could not start the session: ${error.message}`
              : "Creation outcome unknown. Check the session list before retrying.",
        },
        502,
      );
    }
  });

  app.get("/api/hosts/:host/agents/:agent/timeline/stream", (c) => {
    hosts.get(c.req.param("host"));
    return eventStream(c.req.raw.signal, (send) => {
      const sessionId = c.get("session")?.id;
      const key = `${c.req.param("host")}:${c.req.param("agent")}`;
      const stop = hosts.watchTimeline(c.req.param("host"), c.req.param("agent"), (ops) =>
        send({ type: "ops", ops } satisfies TimelineMessage));
      if (sessionId) {
        let devices = viewers.get(key);
        if (!devices) viewers.set(key, devices = new Map());
        devices.set(sessionId, (devices.get(sessionId) ?? 0) + 1);
      }
      return () => {
        stop();
        const devices = viewers.get(key);
        if (sessionId && devices) {
          const count = (devices.get(sessionId) ?? 1) - 1;
          if (count) devices.set(sessionId, count);
          else devices.delete(sessionId);
          if (!devices.size) viewers.delete(key);
        }
      };
    }, streamValidity(c));
  });
  /** Bounded history pages; the browser bookmarks boundaries for forward navigation. */
  app.get("/api/hosts/:host/agents/:agent/timeline", async (c) => {
    const cursor = z
      .object({ epoch: z.string().min(1), seq: z.number().int().nonnegative() })
      .parse(parseJson(c.req.query("cursor")));
    const page = await hosts.get(c.req.param("host")).driver.fetchAgentTimeline(c.req.param("agent"), {
      direction: "before",
      cursor,
      limit: 100,
      projection: "projected",
      wholeTurns: false,
    });
    return c.json({
      epoch: page.epoch,
      hasOlder: page.hasOlder,
      startCursor: page.startCursor,
      rows: page.entries.map((e) => ({
        seqStart: e.seqStart,
        seqEnd: e.seqEnd,
        timestamp: e.timestamp,
        provider: e.provider,
        ...(e.turnId ? { turnId: e.turnId } : {}),
        item: e.item as TimelineItem,
      })),
    } satisfies TimelinePage);
  });
  /** The conversation's user prompts (seq + short preview), for the outline rail. */
  app.get("/api/hosts/:host/agents/:agent/timeline/prompts", async (c) => {
    const client = hosts.get(c.req.param("host"));
    try {
      const page = await client.driver.listAgentTimelinePrompts(c.req.param("agent"), { timeout: 15_000 });
      return c.json({
        epoch: page.epoch,
        prompts: page.prompts.map((p) => ({ seq: p.seq, preview: p.preview.replace(/\s+/g, " ").trim().slice(0, 240) })),
      } satisfies PromptIndex);
    } catch (error) {
      // Older daemons have no prompt index; the rail simply does not appear.
      return c.json({ error: (error as Error).message || "Prompt index unavailable" }, 501);
    }
  });
  /**
   * Rewinds to just before a user message: the conversation, the tracked files, or both, as
   * the provider supports. Cannot be undone; the timeline is replaced (new epoch) on success.
   */
  app.post("/api/hosts/:host/agents/:agent/rewind", async (c) => {
    const { messageId, mode } = z
      .object({ messageId: z.string().min(1).max(500), mode: z.enum(["conversation", "files", "both"]) })
      .parse(await c.req.json());
    const client = hosts.get(c.req.param("host"));
    const facts = client.directory.facts(c.req.param("agent"));
    if (!facts) return c.json({ error: "Unknown agent" }, 404);
    if (!rewindModes(facts.capabilities).includes(mode))
      return c.json({ error: "This agent cannot rewind that way." }, 400);
    try {
      await client.driver.rewindAgent(c.req.param("agent"), messageId, mode);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: (error as Error).message || "Rewind failed" }, 502);
    }
  });
  /**
   * An image an agent referenced in a message (`![](file:///…)`, an absolute or workspace path).
   * Workspace files go through the daemon's file API; images the daemon materialized from
   * provider output live outside the workspace and are read from disk when the daemon is local.
   */
  app.get("/api/hosts/:host/agents/:agent/image", async (c) => {
    const hostId = c.req.param("host");
    const path = z.string().min(1).max(4096).refine((p) => !p.includes("\0")).parse(c.req.query("path"));
    const mime = imageMime(path);
    if (!mime) return c.json({ error: "Not an image" }, 415);
    const { driver } = hosts.get(hostId);
    const cwd = hosts.agents.get(`${hostId}:${c.req.param("agent")}`)?.cwd;
    let bytes: Uint8Array | null = null;
    if (isMaterializedImagePath(path)) {
      const host = store.hosts().find((h) => h.id === hostId);
      if (host && isLocalConnection(host.connection)) bytes = await readMaterializedImage(path);
    } else if (cwd) {
      try {
        const file = await driver.readFile(cwd, path, undefined, MAX_IMAGE_BYTES);
        if (file.size <= MAX_IMAGE_BYTES) bytes = file.bytes;
      } catch {
        bytes = null;
      }
    }
    if (!bytes) return c.json({ error: "Image unavailable from this host" }, 404);
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": mime,
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": "inline",
    });
  });
  /** A project's icon (favicon/logo the daemon found in its root), cached briefly per host. */
  app.get("/api/hosts/:host/project-icon", async (c) => {
    const hostId = c.req.param("host");
    const cwd = z.string().min(1).max(4096).parse(c.req.query("cwd"));
    const key = `${hostId}\n${cwd}`;
    let icon = projectIcons.get(key);
    if (icon === undefined) {
      try {
        const result = await hosts.get(hostId).driver.requestProjectIcon(cwd);
        icon = result.icon && /^image\/(png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon)$/.test(result.icon.mimeType)
          ? { data: Buffer.from(result.icon.data, "base64"), mimeType: result.icon.mimeType }
          : null;
      } catch (error) {
        if (error instanceof UnknownHostError) throw error;
        return c.json({ error: "Icon unavailable" }, 502);
      }
      projectIcons.set(key, icon);
    }
    if (!icon) return c.body(null, 204, { "Cache-Control": "private, max-age=600" });
    return c.body(icon.data as Uint8Array<ArrayBuffer>, 200, { "Content-Type": icon.mimeType, "Cache-Control": "private, max-age=600" });
  });
  // ---- Composer: model, thinking, mode and provider features ---------------------------------
  /** What the open agent can switch to. Modes/features come from the live directory (no round trip). */
  app.get("/api/hosts/:host/agents/:agent/config", async (c) => {
    const hostId = c.req.param("host");
    const client = hosts.get(hostId);
    const facts = client.directory.facts(c.req.param("agent"));
    if (!facts) return c.json({ error: "Unknown agent" }, 404);
    const snapshot = await client.api.providers.snapshot();
    const entry = snapshot.entries.find((p) => p.provider === facts.provider);
    const options: AgentConfigOptions = {
      models: (entry?.models ?? [])
        .filter((m) => m.isSelectable !== false)
        .map((m) => ({
          id: m.id,
          label: m.label,
          thinking: (m.thinkingOptions ?? []).map((t) => ({ id: t.id, label: t.label })),
          defaultThinkingId: m.defaultThinkingOptionId ?? null,
        })),
      modes: facts.availableModes.map((m) => ({ id: m.id, label: m.label, ...(m.description ? { description: m.description } : {}) })),
      features: facts.features.map((f): AgentFeatureOption =>
        f.type === "toggle"
          ? { type: "toggle", id: f.id, label: f.label, ...(f.tooltip ? { tooltip: f.tooltip } : {}), value: f.value }
          : {
              type: "select",
              id: f.id,
              label: f.label,
              ...(f.tooltip ? { tooltip: f.tooltip } : {}),
              value: f.value,
              options: f.options.map((o) => ({ id: o.id, label: o.label })),
            },
      ),
    };
    return c.json(options);
  });
  app.post("/api/hosts/:host/agents/:agent/config", async (c) => {
    const change = z
      .object({
        model: z.string().min(1).max(300).optional(),
        thinkingOptionId: z.string().min(1).max(200).optional(),
        modeId: z.string().min(1).max(200).optional(),
        feature: z.object({ id: z.string().min(1).max(200), value: z.union([z.string().max(200), z.boolean()]) }).optional(),
      })
      .refine((v) => Object.values(v).filter((x) => x !== undefined).length === 1)
      .parse(await c.req.json()) satisfies AgentConfigChange;
    const { driver } = hosts.get(c.req.param("host"));
    const agent = c.req.param("agent");
    let notice: unknown = null;
    if (change.model) await driver.setAgentModel(agent, change.model);
    else if (change.thinkingOptionId) notice = await driver.setAgentThinkingOption(agent, change.thinkingOptionId);
    else if (change.modeId) notice = await driver.setAgentMode(agent, change.modeId);
    else if (change.feature) await driver.setAgentFeature(agent, change.feature.id, change.feature.value);
    return c.json({ ok: true, notice });
  });

  // ---- Dictation ------------------------------------------------------------------------------
  /**
   * Speech to text through the transcription service configured here, once for every host. The
   * browser streams PCM over a short-lived socket. The file endpoint remains for older
   * clients. The API key never leaves the server.
   */
  app.get("/api/dictation", (c) => c.json(dictationSettings(store)));
  app.post("/api/dictation/session", (c) => {
    const config = dictationConfig(store);
    if (!config) return c.json({ error: "Voice input is not set up. Add a transcription service in Settings." }, 409);
    try {
      return c.json(dictationStreams.issue(config, streamValidity(c)));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 429);
    }
  });
  app.put("/api/dictation", async (c) => {
    try {
      return c.json(saveDictation(store, await c.req.json()));
    } catch (error) {
      const message = error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid settings" : (error as Error).message;
      return c.json({ error: message }, 400);
    }
  });
  app.delete("/api/dictation", (c) => {
    clearDictation(store);
    return c.json(dictationSettings(store));
  });
  app.post("/api/dictation/transcribe", async (c) => {
    const config = dictationConfig(store);
    if (!config) return c.json({ error: "Voice input is not set up. Add a transcription service in Settings." }, 409);
    const format = /^audio\/pcm;rate=(\d{4,6});bits=16$/.exec(c.req.header("x-audio-format") ?? "");
    if (!format) return c.json({ error: "Unsupported audio format" }, 415);
    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.length < 3200 || audio.length % 2) return c.json({ error: "Recording too short" }, 400);
    try {
      return c.json({ text: await transcribe(config, audio, Number(format[1]), options.fetch) });
    } catch (error) {
      if (error instanceof DictationError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });
  const attachmentOwner = (c: { get: (key: "session") => LoginSession | null }) => c.get("session")?.id ?? "bearer";
  app.get("/api/hosts/:host/agents/:agent/attachments/capabilities", async c =>
    c.json(await attachments.capabilities(hosts, c.req.param("host"), c.req.param("agent"))));
  app.post("/api/hosts/:host/agents/:agent/attachments", async c => {
    hosts.get(c.req.param("host"));
    try {
      const name = decodeURIComponent(c.req.header("x-file-name") ?? "");
      const mime = c.req.header("content-type")?.split(";")[0] ?? "application/octet-stream";
      return c.json(attachments.put(attachmentOwner(c), c.req.param("host"), c.req.param("agent"), name, mime, Buffer.from(await c.req.arrayBuffer())), 201);
    } catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });
  app.delete("/api/hosts/:host/agents/:agent/attachments/:id", c => {
    try { attachments.remove(c.req.param("id"), attachmentOwner(c), c.req.param("host"), c.req.param("agent")); }
    catch { return c.json({ error: "Attachment already expired or unavailable" }, 404); }
    return c.json({ ok: true });
  });
  app.post("/api/hosts/:host/agents/:agent/messages/status", async c => {
    const { messageIds } = z.object({ messageIds: z.array(z.string().uuid()).min(1).max(20) }).parse(await c.req.json());
    const { driver } = hosts.get(c.req.param("host"));
    return c.json({ confirmed: await confirmedMessages(driver, c.req.param("agent"), messageIds) });
  });
  app.post("/api/hosts/:host/agents/:agent/messages", async (c) => {
    const input = z
      .object({
        text: z.string().trim().max(100000),
        attachmentIds: z.array(z.string().uuid()).max(4).refine(ids => new Set(ids).size === ids.length).default([]),
        messageId: z.string().uuid(),
        behavior: z.enum(["steer", "interrupt"]),
      })
      .refine(input => !!input.text || input.attachmentIds.length > 0)
      .parse(await c.req.json());
    let prepared;
    try { prepared = await attachments.prepare(hosts, attachmentOwner(c), c.req.param("host"), c.req.param("agent"), input.attachmentIds); }
    catch (error) { return c.json({ error: (error as Error).message, delivery: "not-sent" }, 400); }
    try {
      await hosts
        .get(c.req.param("host"))
        .api.agents.ref(c.req.param("agent"))
        .send(input.text, { messageId: input.messageId, activeTurnBehavior: input.behavior,
          ...(prepared.images.length ? { images: prepared.images } : {}),
          ...(prepared.attachments.length ? { attachments: prepared.attachments } : {}),
        });
      attachments.consumed(input.attachmentIds);
      return c.json({ status: "acknowledged", messageId: input.messageId });
    } catch {
      return c.json(
        {
          error: "Delivery outcome unknown. Refresh the conversation before retrying.",
          messageId: input.messageId,
        },
        502,
      );
    }
  });
  app.post("/api/hosts/:host/agents/:agent/stop", async (c) => {
    await hosts.get(c.req.param("host")).driver.cancelAgent(c.req.param("agent"));
    return c.json({ status: "acknowledged" });
  });
  app.post("/api/hosts/:host/agents/:agent/permissions/:permission", async (c) => {
    const response = AgentPermissionResponseSchema.parse(await c.req.json());
    const agent = hosts.get(c.req.param("host")).api.agents.ref(c.req.param("agent"));
    await agent.refresh();
    if (!agent.pendingPermissions?.some((p) => p.id === c.req.param("permission")))
      return c.json({ error: "Permission no longer pending. Refresh the conversation." }, 409);
    await agent.respondToPermission({ requestId: c.req.param("permission"), response });
    return c.json({ status: "acknowledged" });
  });
  // ---- Task board actions ----------------------------------------------------------------------
  /** Marks a settled turn as seen (Paseo's attention flag), moving it out of "review". */
  app.post("/api/hosts/:host/agents/:agent/read", async (c) => {
    await hosts.get(c.req.param("host")).driver.clearAgentAttention(c.req.param("agent"));
    return c.json({ ok: true });
  });
  app.post("/api/hosts/:host/agents/:agent/archive", async (c) => {
    await hosts.get(c.req.param("host")).api.agents.ref(c.req.param("agent")).archive();
    return c.json({ ok: true });
  });

  // ---- Workspace (thread) actions: the same daemon operations Paseo's sidebar uses ------------------
  const workspace = (c: { req: { param: (name: string) => string } }) => ({
    driver: hosts.get(c.req.param("host")).driver,
    id: c.req.param("workspace"),
  });
  /** Rename; null resets to the name derived from the branch or directory. */
  app.post("/api/hosts/:host/workspaces/:workspace/title", async (c) => {
    const { title } = z
      .object({ title: z.string().trim().max(200).nullable() })
      .parse(await c.req.json());
    const { driver, id } = workspace(c);
    await driver.setWorkspaceTitle(id, title ? title : null);
    return c.json({ ok: true });
  });
  app.post("/api/hosts/:host/workspaces/:workspace/pin", async (c) => {
    const { pinned } = z.object({ pinned: z.boolean() }).parse(await c.req.json());
    const { driver, id } = workspace(c);
    await driver.setWorkspacePinned(id, pinned);
    return c.json({ ok: true });
  });
  app.post("/api/hosts/:host/workspaces/:workspace/unread", async (c) => {
    const { driver, id } = workspace(c);
    await driver.markWorkspaceUnread(id);
    return c.json({ ok: true });
  });
  app.post("/api/hosts/:host/workspaces/:workspace/read", async (c) => {
    const { driver, id } = workspace(c);
    await driver.clearWorkspaceAttention(id);
    return c.json({ ok: true });
  });
  app.post("/api/hosts/:host/workspaces/:workspace/archive", async (c) => {
    const { driver, id } = workspace(c);
    await driver.archiveWorkspace(id);
    return c.json({ ok: true });
  });

  // ---- Plugins whose daemon side LitePaseo drives ------------------------------------------------
  /**
   * next-input: the daemon appends a placeholder row after a completed turn; prediction runs only
   * when a client that shows the row asks. Only this one plugin method is reachable from here.
   */
  app.post("/api/hosts/:host/agents/:agent/suggestion", async (c) => {
    const { token } = z.object({ token: z.string().min(1).max(200) }).parse(await c.req.json());
    try {
      const output = (await hosts
        .get(c.req.param("host"))
        .driver.invokePluginRpc("next-input", "suggestions.predict", { agentId: c.req.param("agent"), token })) as {
        status?: string;
        text?: string;
      };
      return c.json({ status: String(output?.status ?? "error"), text: String(output?.text ?? "") });
    } catch (error) {
      if (error instanceof UnknownHostError) throw error;
      return c.json({ status: "unavailable", text: "" });
    }
  });

  // ---- Usage across hosts ------------------------------------------------------------------------
  registerWorkspaceRoutes(app, hosts, store, (c) => streamValidity(c));
  app.get("/api/usage", async (c) => c.json(await usage.report(c.req.query("refresh") === "1")));

  app.get("/api/board", (c) => c.json(store.board()));
  app.put("/api/board", async (c) => {
    const b = z
      .object({ revision: z.number().int().nonnegative(), cards: z.array(card).max(1000) })
      .parse(await c.req.json());
    if (new Set(b.cards.map((c) => c.id)).size !== b.cards.length)
      return c.json({ error: "Duplicate card ID" }, 400);
    if (!store.saveBoard(b.revision, b.cards))
      return c.json({ error: "Board changed. Reload before editing." }, 409);
    return c.json(store.board());
  });
  // Per-card edits apply to the board as it is now, so two tabs editing different fields
  // (or adding comments) never overwrite each other. Each returns the whole board.
  const cardEdit = (id: string, change: Parameters<Store["updateCard"]>[1]) =>
    store.updateCard(id, change) ? store.board() : null;
  app.patch("/api/board/cards/:id", async (c) => {
    const p = cardPatch.parse(await c.req.json());
    const board = cardEdit(c.req.param("id"), (card) => ({
      ...card,
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.column !== undefined ? { column: p.column } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.link !== undefined ? { hostId: p.link?.hostId ?? null, agentId: p.link?.agentId ?? null } : {}),
      updatedAt: Date.now(),
    }));
    return board ? c.json(board) : c.json({ error: "Task not found" }, 404);
  });
  app.post("/api/board/cards/:id/comments", async (c) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(CARD_COMMENT_MAX) }).parse(await c.req.json());
    let full = false;
    const board = cardEdit(c.req.param("id"), (card) => {
      const comments = card.comments ?? [];
      if (comments.length >= CARD_COMMENTS_MAX) return (full = true), null;
      return { ...card, comments: [...comments, { id: randomUUID(), text, at: Date.now() }], updatedAt: Date.now() };
    });
    if (full) return c.json({ error: `A task holds up to ${CARD_COMMENTS_MAX} comments.` }, 400);
    return board ? c.json(board, 201) : c.json({ error: "Task not found" }, 404);
  });
  app.delete("/api/board/cards/:id/comments/:comment", (c) => {
    const board = cardEdit(c.req.param("id"), (card) => ({
      ...card,
      comments: (card.comments ?? []).filter((m) => m.id !== c.req.param("comment")),
      updatedAt: Date.now(),
    }));
    return board ? c.json(board) : c.json({ error: "Task not found" }, 404);
  });
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
  // The service worker and manifest need exact types and must never be cached stale.
  for (const [file, type] of [
    ["sw.js", "text/javascript; charset=utf-8"],
    ["manifest.webmanifest", "application/manifest+json"],
  ] as const)
    app.get("/" + file, (c) => {
      try {
        return c.body(readFileSync(join(webRoot, file)), 200, { "Content-Type": type, "Cache-Control": "no-cache" });
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
    openStreams: () => directoryStreams.size,
    dispose: () => {
      disposed = true;
      clearTimeout(agentFlush);
      clearTimeout(hostFlush);
      agentFlush = hostFlush = undefined;
      attachments.close();
      dictationStreams.close();
    },
  });
}
