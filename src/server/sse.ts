const HEARTBEAT_MS = 20_000;
/**
 * Some proxies hold a stream's latest bytes until more arrive: behind a Cloudflare Tunnel, a
 * conversation's rows reached the browser only with the next heartbeat, 20 s later. So every
 * burst of writes is followed by a tiny comment, which pushes it through.
 */
const NUDGE_MS = 50;

/** Server-sent events over a plain fetch response, so the bearer header still authenticates. */
export function eventStream(
  signal: AbortSignal,
  open: (send: (data: unknown) => void) => () => void,
  /** Re-checked on every heartbeat: a revoked session loses its open streams. */
  valid: () => boolean = () => true,
) {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;
  let nudge: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(nudge);
    cleanup?.();
    cleanup = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (text: string) => {
        if (stopped) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
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
    },
  });
}
