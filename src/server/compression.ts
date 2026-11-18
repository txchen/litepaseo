import type { MiddlewareHandler } from "hono";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { streamEncoding } from "./sse.ts";

const brotli = promisify(brotliCompress), gzipped = promisify(gzip);
/** Smaller JSON goes out as it is: compressing it would save little or nothing. */
export const MIN_COMPRESSED_BYTES = 1024;

/**
 * Compresses JSON API responses (history pages, prompt indexes, directory reads) with brotli
 * or gzip, as the browser accepts. Live streams compress themselves (see eventStream).
 */
export function compressJson(enabled: boolean): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (!enabled || c.req.method === "HEAD") return;
    const res = c.res;
    if (!res.body || res.headers.has("Content-Encoding") || !(res.headers.get("Content-Type") ?? "").startsWith("application/json")) return;
    const encoding = streamEncoding(c.req.header("Accept-Encoding"), true);
    if (!encoding) return;
    const body = new Uint8Array(await res.arrayBuffer());
    const compressed = body.byteLength < MIN_COMPRESSED_BYTES ? null
      : encoding === "br" ? await brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
      : await gzipped(body, { level: 6 });
    // The body was read: it goes out again either way.
    c.res = new Response(compressed ?? body, res);
    c.res.headers.delete("Content-Length");
    if (compressed) c.res.headers.set("Content-Encoding", encoding);
    const vary = c.res.headers.get("Vary");
    if (!vary || !/(?:^|,)\s*accept-encoding\s*(?:,|$)/i.test(vary)) c.res.headers.set("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
  };
}
