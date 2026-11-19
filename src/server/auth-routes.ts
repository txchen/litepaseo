import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import QRCode from "qrcode";
import { z } from "zod";
import { SESSION_TTL_MS, type Auth } from "./auth.ts";
import { vapidKeys, type Notifier } from "./notifier.ts";
import type { ViewingPresence } from "./viewing-presence.ts";
import { requireSession, type App, type Ctx, type Env, type RouteContext } from "./route-context.ts";

const SESSION_COOKIE = "lp_session";
/** Cookie-authenticated writes must carry this header; a cross-site form or image cannot. */
const CSRF_HEADER = "x-litepaseo";
const PUBLIC_API = new Set(["/api/auth", "/api/login"]);

type Request = { req: { url: string; header: (name: string) => string | undefined } };

/**
 * Requests that arrived through a tunnel or reverse proxy. A bearer token is never accepted from
 * them: over the network, only the browser sign-in (with its rate limits and optional
 * authenticator code) admits anyone.
 */
const proxied = (c: Request) =>
  ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "forwarded"].some((name) => c.req.header(name) !== undefined);

/** The peer address of the TCP connection under @hono/node-server; absent elsewhere. */
const socketAddress = (c: { env: unknown }) =>
  (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
const isLoopback = (address: string) => /^(::ffff:)?127\./.test(address) || address === "::1";

const secure = (c: Request) => c.req.header("x-forwarded-proto") === "https" || c.req.url.startsWith("https:");

/**
 * Who failed a sign-in, for rate limits. Forwarding headers are believed only from a local
 * tunnel or proxy; anyone reaching the port directly is known by their address, so they cannot
 * mint a fresh limit per request by inventing headers. (`app.request` in tests has no socket.)
 */
const clientId = (c: Request & { env: unknown }) => {
  const remote = socketAddress(c);
  if (remote && !isLoopback(remote)) return remote;
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "direct";
};

const setSessionCookie = (c: Ctx, secret: string, maxAge: number) =>
  setCookie(c, SESSION_COOKIE, secret, { httpOnly: true, secure: secure(c), sameSite: "Strict", path: "/", maxAge });

/** A short device label from the user agent, such as "iOS · Safari". */
function deviceLabel(userAgent: string) {
  return (
    (/iPhone|iPad/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : /Mac OS/.test(userAgent) ? "macOS" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : "Browser") +
    (/Edg\//.test(userAgent) ? " · Edge" : /Chrome\//.test(userAgent) ? " · Chrome" : /Firefox\//.test(userAgent) ? " · Firefox" : /Safari\//.test(userAgent) ? " · Safari" : "")
  );
}

/**
 * Authenticates every API request: a bearer token from a direct (unproxied) connection while no
 * authenticator is enrolled, else the browser session cookie, with CSRF protection on writes.
 */
export function apiAuth(auth: Auth): MiddlewareHandler<Env> {
  return async (c, next) => {
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
      setSessionCookie(c, secret, Math.floor(SESSION_TTL_MS / 1000));
    if (PUBLIC_API.has(c.req.path)) {
      c.set("session", session);
      return next();
    }
    if (!session) return c.json({ error: "Sign in required" }, 401);
    if (!["GET", "HEAD"].includes(c.req.method) && c.req.header(CSRF_HEADER) !== "1")
      return c.json({ error: "Missing request header" }, 403);
    c.set("session", session);
    await next();
  };
}

/** Sign-in, browser sessions, two-factor, push subscriptions and viewing presence. */
export function registerAuthRoutes(
  app: App,
  { store, auth, attachments }: RouteContext,
  { notifier, presence, instanceName }: { notifier: Notifier; presence: ViewingPresence; instanceName: () => string },
) {
  // ---- Sign-in and sessions ------------------------------------------------------------------
  app.get("/api/auth", (c) => c.json({ authenticated: !!c.get("session"), totp: auth.totpEnabled(), ...(instanceName() ? { instanceName: instanceName() } : {}) }));
  app.post("/api/login", async (c) => {
    const input = z
      .object({ token: z.string().min(1).max(200).optional(), code: z.string().regex(/^\d{6}$/).optional() })
      .refine((x) => !!x.token || !!x.code)
      .parse(await c.req.json());
    const result = auth.login(input, clientId(c), deviceLabel(c.req.header("user-agent") ?? ""));
    if (!result.ok) {
      if (result.retryAfter) c.header("Retry-After", String(result.retryAfter));
      return c.json({ error: result.status === 429 ? "Too many attempts. Try again later." : "That did not match." }, result.status);
    }
    setSessionCookie(c, result.secret, SESSION_TTL_MS / 1000);
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
    const id = c.req.param("id");
    auth.revoke(id);
    attachments.clearOwner(id);
    if (id === c.get("session")?.id) deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  app.post("/api/sessions/revoke-all", (c) => {
    const revoked = store.sessions().map((s) => s.id);
    auth.revoke();
    for (const id of revoked) attachments.clearOwner(id);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // ---- Two-factor ----------------------------------------------------------------------------
  const code = z.object({ code: z.string().regex(/^\d{6}$/) });
  app.post("/api/totp/setup", async (c) => {
    const session = requireSession(c);
    if (auth.totpEnabled()) return c.json({ error: "Disable the current authenticator before replacing it." }, 409);
    const { secret, uri } = auth.beginTotp(session.id);
    const qr = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return c.json({ secret, uri, qr: "data:image/svg+xml;base64," + Buffer.from(qr).toString("base64") });
  });
  app.post("/api/totp/confirm", async (c) => {
    const session = requireSession(c);
    const input = code.parse(await c.req.json());
    if (!auth.confirmTotp(session.id, input.code)) return c.json({ error: "That code did not match. Try the next one." }, 400);
    return c.json({ ok: true });
  });
  app.post("/api/totp/disable", async (c) => {
    const input = code.parse(await c.req.json());
    if (!auth.disableTotp(input.code)) return c.json({ error: "That code did not match." }, 400);
    return c.json({ ok: true });
  });

  // ---- Push notifications --------------------------------------------------------------------
  const endpoint = z.object({ endpoint: z.string().max(2000) });
  app.get("/api/push/key", (c) => c.json({ publicKey: vapidKeys(store).publicKey }));
  app.post("/api/push/subscribe", async (c) => {
    const session = requireSession(c);
    const input = z
      .object({
        subscription: z.object({
          endpoint: z.string().url().max(2000).refine((u) => u.startsWith("https://")),
          keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
        }),
        prefs: z.object({ attention: z.boolean(), turns: z.boolean() }),
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
    const input = endpoint.parse(await c.req.json());
    const found = store.pushSubscriptions().find((s) => s.endpoint === input.endpoint);
    return c.json(found ? { subscribed: true, prefs: found.prefs } : { subscribed: false });
  });
  app.post("/api/push/unsubscribe", async (c) => {
    const input = endpoint.parse(await c.req.json());
    // A browser session can only drop its own subscription; another device keeps its pushes.
    store.removePushSubscription(input.endpoint, c.get("session")?.id);
    return c.json({ ok: true });
  });
  app.post("/api/push/test", async (c) => {
    const session = requireSession(c);
    return c.json({ sent: await notifier.test(session.id) });
  });

  // ---- Viewing presence: what each tab shows, so pushes skip a conversation being read --------
  app.put("/api/presence", async (c) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Browser sign-in required" }, 403);
    const input = z.object({ tab: z.string().uuid(), seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), key: z.string().min(1).max(1024).nullable(), active: z.boolean().optional() }).strict().parse(await c.req.json());
    presence.update(session.id, input.tab, input.seq, input.key, input.active);
    return c.json({ ok: true });
  });
}
