import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, normalize } from "node:path";
import { parseHostTarget } from "@getpaseo/client/node";

/** Raster images only: an SVG opened directly could run script on this origin. */
export const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  avif: "image/avif",
};
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

const extension = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
export const imageMime = (path: string) => IMAGE_MIME[extension(path)] ?? null;

/** True when the daemon runs on this machine (loopback TCP/WebSocket or a local socket). */
export function isLocalConnection(connection: string) {
  try {
    const target = parseHostTarget(connection) as { kind: string; url?: string; socketPath?: string };
    if (target.kind !== "socket") return false;
    if (target.socketPath) return true;
    const host = new URL(target.url ?? "").hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * Images a provider returned inline (screenshots, `read` of a PNG) are written by the daemon to
 * `<tmp>/paseo-attachments-XXXXXX/<sha256>.<ext>` and referenced from the message as file:// URLs.
 * The daemon's file API is confined to the workspace, so these are read from disk, and only when
 * the daemon shares this machine. The name pattern admits nothing but those materialized files.
 */
export function isMaterializedImagePath(path: string) {
  if (!isAbsolute(path) || normalize(path) !== path || !imageMime(path)) return false;
  const directory = dirname(path);
  return (
    /^[a-f0-9]{64}\.[a-z0-9]+$/.test(basename(path)) &&
    /^paseo-attachments-[A-Za-z0-9_-]{1,32}$/.test(basename(directory)) &&
    [tmpdir(), "/tmp"].includes(dirname(directory))
  );
}

export async function readMaterializedImage(path: string) {
  if (!isMaterializedImagePath(path)) return null;
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES) return null;
    // The directory must not be a symlink to somewhere else either.
    if (!isMaterializedImagePath(await realpath(path))) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/** Small LRU for project icons: a sidebar asks for each project once per page load. */
export class IconCache {
  private readonly entries = new Map<string, { at: number; icon: { data: Buffer; mimeType: string } | null }>();
  private readonly limit: number;
  private readonly ttlMs: number;
  constructor(limit = 256, ttlMs = 10 * 60_000) {
    this.limit = limit;
    this.ttlMs = ttlMs;
  }
  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.icon;
  }
  set(key: string, icon: { data: Buffer; mimeType: string } | null) {
    this.entries.delete(key);
    this.entries.set(key, { at: Date.now(), icon });
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
}
