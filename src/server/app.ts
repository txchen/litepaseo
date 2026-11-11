import { Attachments, MAX_FILE_BYTES } from "./attachments.ts";
import { confirmedMessages } from "./message-status.ts";
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
import { Hosts, UnknownHostError } from "./hosts.ts";
import type {
  CreateSessionRequest,
  DirectoryMessage,
  HostState,
  ProjectOption,
  ProviderOption,
  TimelineItem,
  TimelineMessage,
  TimelinePage,
} from "../shared/wire.ts";

const AGENT_FLUSH_MS = 100;
const HOST_FLUSH_MS = 100;
const HEARTBEAT_MS = 20_000;

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return null;
  }
}

/** Server-sent events over a plain fetch response, so the bearer header still authenticates. */
function eventStream(
  signal: AbortSignal,
  open: (send: (data: unknown) => void) => () => void,
  /** Re-checked on every heartbeat: a revoked session loses its open streams. */
  valid: () => boolean = () => true,
) {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;
  const stop = () => {
    cleanup?.();
    cleanup = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const heartbeat = setInterval(() => {
        if (valid()) return write(": ping\n\n");
        stop();
        try {
          controller.close();
        } catch {}
      }, HEARTBEAT_MS);
      const close = open((data) => write(`data: ${JSON.stringify(data)}\n\n`));
      cleanup = () => {
        clearInterval(heartbeat);
        close();
      };
      signal.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel: stop,
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
const card = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(300),
    column: z.enum(["Todo", "Doing", "Done"]),
    hostId: z.string().nullable(),
    agentId: z.string().nullable(),
  })
  .refine((c) => (c.hostId === null) === (c.agentId === null));
const SESSION_COOKIE = "lp_session";
/** Cookie-authenticated writes must carry this header; a cross-site form or image cannot. */
const CSRF_HEADER = "x-litepaseo";
const PUBLIC_API = new Set(["/api/auth", "/api/login"]);

export interface AppOptions {
  pushSender?: PushSender;
  /** VAPID subject; Apple's push service requires a mailto: or https: URL. */
  pushSubject?: string;
}

type Env = { Variables: { session: LoginSession | null } };

export function createApp(store: Store, hosts: Hosts, token: string, webRoot: string, options: AppOptions = {}) {
  const app = new Hono<Env>();
  const auth = new Auth(store, token);
  const attachments = new Attachments();
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
  app.use("/api/*", (c, next) => bodyLimit({ maxSize: c.req.method === "POST" && c.req.path.endsWith("/attachments") ? MAX_FILE_BYTES : 1024 * 1024 })(c, next));
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const bearer = c.req.header("authorization")?.replace(/^Bearer /, "");
    if (bearer && !PUBLIC_API.has(c.req.path) && auth.checkToken(bearer)) {
      c.set("session", null);
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
      .refine((x) => !!x.token !== !!x.code)
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
    console.error(JSON.stringify({ event: "api_operation_failed", requestId, method: c.req.method }));
    return c.json({ error: "Operation failed; refresh state before retrying", requestId }, 502);
  });
  app.get("/api/health", (c) => c.json({ ok: true, version: "0.0.1", waiting: notifier.waitingCount }));
  const hostStates = (): HostState[] =>
    store.hosts().map((h) => ({ id: h.id, label: h.label, state: hosts.state(h.id), diagnostic: hosts.diagnostic(h.id) }));
  app.get("/api/hosts", (c) => c.json(hostStates()));

  // Directory streams. Each remembers the last collection seq it delivered, so a flush sends
  // only entries changed since then: O(changes) per flush, independent of directory size.
  type DirectoryStream = { last: number; lastWorkspaces: number; send: (message: DirectoryMessage) => void };
  const directoryStreams = new Set<DirectoryStream>();
  let agentFlush: ReturnType<typeof setTimeout> | undefined;
  let hostFlush: ReturnType<typeof setTimeout> | undefined;
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
    if (agentFlush || !directoryStreams.size) return;
    agentFlush = setTimeout(() => {
      agentFlush = undefined;
      for (const stream of directoryStreams) deliverAgents(stream);
    }, AGENT_FLUSH_MS);
  });
  hosts.onHostsChanged(() => {
    if (hostFlush || !directoryStreams.size) return;
    hostFlush = setTimeout(() => {
      hostFlush = undefined;
      const message: DirectoryMessage = { type: "hosts", hosts: hostStates() };
      for (const stream of directoryStreams) stream.send(message);
    }, HOST_FLUSH_MS);
  });
  const streamValidity = (session: LoginSession | null) =>
    session ? () => auth.stillValid(session.id) : () => true;
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
    }, streamValidity(c.get("session")));
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
    }, streamValidity(c.get("session")));
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
    /** Open directory streams; lets tests prove that disconnects release them. */
    openStreams: () => directoryStreams.size,
    dispose: () => attachments.close(),
  });
}
