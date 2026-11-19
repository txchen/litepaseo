import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Auth } from "./auth.ts";
import type { Attachments } from "./attachments.ts";
import type { Hosts } from "./hosts.ts";
import type { ServerSendQueue } from "./send-queue.ts";
import type { StreamEncoding } from "./sse.ts";
import type { LoginSession, Store } from "./store.ts";

/** `session` for a browser, or `bearer` (the accepted token) for a script on a direct connection. */
export type Env = { Variables: { session: LoginSession | null; bearer: string | null } };
export type App = Hono<Env>;
export type Ctx = Context<Env>;

/** What the route modules share; each module receives anything else it alone needs explicitly. */
export interface RouteContext {
  store: Store;
  hosts: Hosts;
  auth: Auth;
  attachments: Attachments;
  sendQueue: ServerSendQueue;
  /** Outbound requests (transcription service, project icon import); replaced in tests. */
  fetch?: typeof fetch;
  /** Re-checked on heartbeat: a revoked session, or a rotated token, loses its open streams. */
  streamValidity: (c: Ctx) => () => boolean;
  /** How a live stream to this request is compressed. */
  encodingOf: (c: Ctx) => StreamEncoding;
}

/** A path on a host (a cwd, a workspace file, a repository root): bounded, without NUL bytes. */
export const hostPath = z.string().min(1).max(4096).refine((p) => !p.includes("\0"));

/** An error with its own HTTP status and message, answered as `{ error }` by the app's error handler. */
export class HttpError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** The signed-in browser session; script (bearer) access is refused with 403. */
export function requireSession(c: Ctx): LoginSession {
  const session = c.get("session");
  if (!session) throw new HttpError(403, "A browser session is required");
  return session;
}

/** Who owns staged attachments: the browser session, or the one bearer identity. */
export const attachmentOwner = (c: Ctx) => c.get("session")?.id ?? "bearer";

/** The message of a caught error, for routes that answer failures with it. */
export const errorMessage = (error: unknown, fallback = "") => (error as Error | undefined)?.message || fallback;

/** The daemon stores custom project icons (Paseo's projectCustomIcon feature). */
export const customIcons = (hosts: Hosts, hostId: string) =>
  (hosts.clients.get(hostId)?.driver.getLastServerInfoMessage() as { features?: { projectCustomIcon?: boolean } } | null)?.features
    ?.projectCustomIcon === true;
