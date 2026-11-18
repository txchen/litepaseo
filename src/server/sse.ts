import { constants, createBrotliCompress, createGzip, type BrotliCompress, type Gzip } from "node:zlib";

const HEARTBEAT_MS = 20_000;
/**
 * Some proxies hold a stream's latest bytes until more arrive, so every burst of writes is
 * followed by a tiny comment. It did not cure the 20 s waits seen on an iPhone behind a
 * Cloudflare Tunnel (rows arrived with the next heartbeat anyway); slow-open reports now carry
 * the browser's side of each stream to find out why.
 */
const NUDGE_MS = 50;

/** How a stream's body is compressed: brotli or gzip when the browser accepts it, else none. */
export type StreamEncoding = "br" | "gzip" | null;

/** The best encoding the request accepts, when compression is on. */
export function streamEncoding(acceptEncoding: string | undefined, enabled: boolean): StreamEncoding {
  if (!enabled || !acceptEncoding) return null;
  const accepted = new Set<string>();
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (!q || Number(q.slice(2)) > 0) accepted.add(name.trim());
  }
  return accepted.has("br") ? "br" : accepted.has("gzip") ? "gzip" : null;
}

/**
 * Server-sent events over a plain fetch response, so the bearer header still authenticates.
 * With an encoding, every write is compressed and flushed at once: compression never holds an
 * event back (a sync flush costs a few bytes per write).
 */
export function eventStream(
  signal: AbortSignal,
  open: (send: (data: unknown) => void) => () => void,
  /** Re-checked on every heartbeat: a revoked session loses its open streams. */
  valid: () => boolean = () => true,
  encoding: StreamEncoding = null,
) {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;
  let nudge: ReturnType<typeof setTimeout> | undefined;
  let compressor: BrotliCompress | Gzip | null = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(nudge);
    compressor?.destroy();
    cleanup?.();
    cleanup = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const output = (bytes: Uint8Array) => {
        if (stopped) return;
        try {
          controller.enqueue(bytes);
        } catch {
          stop();
        }
      };
      if (encoding) {
        compressor = encoding === "br"
          ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
          : createGzip({ level: 6 });
        compressor.on("data", (chunk: Buffer) => output(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
        compressor.on("error", stop);
      }
      const flushMode = encoding === "br" ? constants.BROTLI_OPERATION_FLUSH : constants.Z_SYNC_FLUSH;
      const enqueue = (text: string) => {
        if (stopped) return;
        if (!compressor) return output(encoder.encode(text));
        compressor.write(text);
        compressor.flush(flushMode);
      };
      const write = (text: string) => {
        enqueue(text);
        if (stopped || nudge) return;
        nudge = setTimeout(() => {
          nudge = undefined;
          enqueue(":\n\n");
        }, NUDGE_MS);
      };
      const heartbeat = setInterval(() => {
        // A heartbeat needs no nudge: it carries nothing anyone waits for.
        if (valid()) return enqueue(": ping\n\n");
        stop();
        try {
          controller.close();
        } catch {}
      }, HEARTBEAT_MS);
      // Sent at once, so the response starts even while the first data is still loading: the
      // browser can tell a slow server or proxy from a slow host.
      write(": open\n\n");
      const close = open((data) => write(`data: ${JSON.stringify(data)}\n\n`));
      cleanup = () => {
        clearInterval(heartbeat);
        close();
      };
      // Stopped while opening (the client already left): release what open() acquired.
      if (stopped) stop();
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
      ...(encoding ? { "Content-Encoding": encoding, Vary: "Accept-Encoding" } : {}),
    },
  });
}
