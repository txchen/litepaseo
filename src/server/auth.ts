import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { LoginSession, Store } from "./store.ts";

/** Sliding session lifetime: a device that keeps using the console stays signed in. */
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
const TOUCH_INTERVAL_MS = 3600_000;
const TOTP_PERIOD_S = 30;
const TOTP_DIGITS = 6;
/** Only clients that know the access token can reach TOTP verification.
 * Code attempts have a persistent server-wide budget across IPs and restarts.
 * Exhausting it doubles the lockout from 15 minutes to at most 24 hours.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_CODE_FAILURES_PER_CLIENT = 5;
const MAX_CODE_FAILURES_GLOBAL = 20;
const MAX_LOCK_MS = 24 * 3600_000;
const MAX_TOKEN_FAILURES_PER_CLIENT = 10;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(bytes: Uint8Array) {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text: string) {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0,
    value = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits), the format every authenticator app supports. */
export function totp(secret: Buffer, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(code).padStart(TOTP_DIGITS, "0");
}

/** The time step a code matches within ±1 step of `now`, or null. */
export function matchTotp(secret: Buffer, code: string, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 1000 / TOTP_PERIOD_S);
  for (const step of [current, current - 1, current + 1]) {
    const expected = Buffer.from(totp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const equalSecret = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export type LoginResult =
  | { ok: true; session: LoginSession; secret: string }
  | { ok: false; status: 401 | 429; retryAfter?: number };

/**
 * Login and sessions. A browser signs in once, with the access token and, when enabled, an authenticator code,
 * and receives an opaque session secret (stored only as a hash). Sessions are listed and
 * revocable; revoking one also drops the push subscriptions it registered.
 */
export class Auth {
  private readonly store: Store;
  private readonly token: string;
  private readonly codeFailures = new Map<string, { count: number; reset: number }>();
  private readonly tokenFailures = new Map<string, { count: number; reset: number }>();
  private global = { count: 0, reset: 0, lockMs: WINDOW_MS };
  private pendingTotp: { secret: string; sessionId: string; expires: number } | null = null;

  constructor(store: Store, token: string) {
    this.store = store;
    this.token = token;
    const saved = store.setting("totp_login_limit");
    if (saved) this.global = JSON.parse(saved);
    // Old versions issued sessions for a code alone. Invalidate them once.
    if (store.setting("auth_policy") !== "token-plus-totp-v1") {
      store.db.exec("BEGIN IMMEDIATE");
      try {
        if (this.totpEnabled()) store.revokeSessions();
        store.setSetting("auth_policy", "token-plus-totp-v1");
        store.db.exec("COMMIT");
      } catch (error) { store.db.exec("ROLLBACK"); throw error; }
    }
  }

  totpEnabled() {
    return this.store.setting("totp_secret") !== null;
  }

  /** Validates a bearer token (CLI, tests) without creating a session. */
  checkToken(token: string) {
    return equalSecret(token, this.token);
  }

  login(input: { token?: string; code?: string }, client: string, label: string, now = Date.now()): LoginResult {
    const tokenLimit = this.limited(client, false, now);
    if (tokenLimit) return { ok: false, status: 429, retryAfter: tokenLimit };
    // Never test or consume a code until the primary credential is valid.
    if (!input.token || !this.checkToken(input.token)) {
      this.fail(client, false, now);
      return { ok: false, status: 401 };
    }
    const totpSecret = this.store.setting("totp_secret");
    if (totpSecret) {
      const codeLimit = this.limited(client, true, now);
      if (codeLimit) return { ok: false, status: 429, retryAfter: codeLimit };
      const step = matchTotp(base32Decode(totpSecret), input.code ?? "", now);
      if (step === null || !this.store.advanceSetting("totp_last_step", step)) {
        this.fail(client, true, now);
        return { ok: false, status: 401 };
      }
      this.codeFailures.delete(client);
      this.resetCodeLimit();
    }
    this.tokenFailures.delete(client);
    const secret = randomBytes(32).toString("base64url");
    const session: LoginSession = {
      id: randomUUID(),
      secretHash: sha256(secret),
      label: label.slice(0, 120) || "Browser",
      created: now,
      lastSeen: now,
      expires: now + SESSION_TTL_MS,
    };
    this.store.addSession(session);
    return { ok: true, session, secret };
  }

  /** Resolves a session secret; extends it (at most hourly) while it is in use. */
  verify(secret: string | undefined, now = Date.now()): LoginSession | null {
    return this.authenticate(secret, now)?.session ?? null;
  }
  /** Like verify; `renewed` says the expiry just moved, so the cookie must be reissued. */
  authenticate(secret: string | undefined, now = Date.now()): { session: LoginSession; renewed: boolean } | null {
    if (!secret || secret.length > 200) return null;
    const session = this.store.sessionBySecret(sha256(secret));
    if (!session || session.expires < now) return null;
    const renewed = now - session.lastSeen > TOUCH_INTERVAL_MS;
    if (renewed) {
      session.lastSeen = now;
      session.expires = now + SESSION_TTL_MS;
      this.store.touchSession(session.id, session.lastSeen, session.expires);
    }
    return { session, renewed };
  }

  /** Whether a session id is still valid; long-lived streams re-check this on heartbeat. */
  stillValid(sessionId: string, now = Date.now()) {
    const session = this.store.sessionById(sessionId);
    return !!session && session.expires >= now;
  }

  revoke(sessionId?: string) {
    this.store.revokeSessions(sessionId);
  }

  // ---- TOTP enrollment ------------------------------------------------------------------------

  beginTotp(sessionId: string, now = Date.now()) {
    if (this.totpEnabled()) throw new Error("Disable the current authenticator before replacing it");
    const secret = base32Encode(randomBytes(20));
    this.pendingTotp = { secret, sessionId, expires: now + 10 * 60_000 };
    return {
      secret,
      uri: `otpauth://totp/LitePaseo?secret=${secret}&issuer=LitePaseo&algorithm=SHA1&digits=6&period=30`,
    };
  }

  /** Enables the pending secret once the user proves their app produces matching codes. */
  confirmTotp(sessionId: string, code: string, now = Date.now()) {
    if (this.totpEnabled()) return false;
    const pending = this.pendingTotp;
    if (!pending || pending.sessionId !== sessionId || pending.expires < now) return false;
    const step = matchTotp(base32Decode(pending.secret), code, now);
    if (step === null) return false;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.setSetting("totp_secret", pending.secret);
      this.store.setSetting("totp_last_step", String(step));
      // The enrolling session has now proved both factors; other token-only sessions have not.
      this.store.db.prepare("DELETE FROM push_subscriptions WHERE session_id<>?").run(sessionId);
      this.store.db.prepare("DELETE FROM sessions WHERE id<>?").run(sessionId);
      this.resetCodeLimit();
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    this.pendingTotp = null;
    return true;
  }

  disableTotp(code: string, now = Date.now()) {
    if (this.limited("settings", true, now)) return false;
    const secret = this.store.setting("totp_secret");
    const step = secret ? matchTotp(base32Decode(secret), code, now) : null;
    if (step === null || !this.store.advanceSetting("totp_last_step", step)) {
      this.fail("settings", true, now);
      return false;
    }
    this.store.setSetting("totp_secret", null);
    this.resetCodeLimit();
    return true;
  }

  // ---- rate limiting --------------------------------------------------------------------------

  private resetCodeLimit() {
    this.global = { count: 0, reset: 0, lockMs: WINDOW_MS };
    this.store.setSetting("totp_login_limit", JSON.stringify(this.global));
  }

  private limited(client: string, usesCode: boolean, now: number) {
    if (usesCode && this.global.reset > now && this.global.count >= MAX_CODE_FAILURES_GLOBAL)
      return Math.ceil((this.global.reset - now) / 1000);
    const map = usesCode ? this.codeFailures : this.tokenFailures;
    if (!map.has(client) && map.size >= 10_000) client = "overflow";
    const entry = map.get(client);
    const max = usesCode ? MAX_CODE_FAILURES_PER_CLIENT : MAX_TOKEN_FAILURES_PER_CLIENT;
    if (entry && entry.reset > now && entry.count >= max) return Math.ceil((entry.reset - now) / 1000);
    return 0;
  }

  private fail(client: string, usesCode: boolean, now: number) {
    if (usesCode) {
      if (this.global.reset <= now) this.global.count = 0;
      this.global.count++;
      if (this.global.count === MAX_CODE_FAILURES_GLOBAL) {
        // Budget exhausted: lock, and make the next lock twice as long.
        this.global.reset = now + this.global.lockMs;
        this.global.lockMs = Math.min(this.global.lockMs * 2, MAX_LOCK_MS);
      } else if (this.global.reset <= now) this.global.reset = now + WINDOW_MS;
      this.store.setSetting("totp_login_limit", JSON.stringify(this.global));
    }
    const map = usesCode ? this.codeFailures : this.tokenFailures;
    if (!map.has(client) && map.size >= 10_000) client = "overflow";
    let entry = map.get(client);
    if (!entry || entry.reset <= now) map.set(client, (entry = { count: 0, reset: now + WINDOW_MS }));
    entry.count++;
  }
}
