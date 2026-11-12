const HEARTBEAT_MS = 20_000;

/** Server-sent events over a plain fetch response, so the bearer header still authenticates. */
export function eventStream(
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
