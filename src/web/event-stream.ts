export type StreamState = "connecting" | "live" | "paused" | "unauthorized" | "closed";

export interface StreamOptions {
  /** Evaluated on every (re)connect so resumable streams can carry their latest cursor. */
  url: () => string;
  onMessage: (data: unknown) => void;
  onState?: (state: StreamState) => void;
}

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/**
 * Reads a server-sent event stream over fetch (so the bearer header is sent), reconnecting
 * with backoff. While the tab is hidden the stream is closed: no bytes, parsing or rendering.
 * On return the server resumes from the cursor in `url()`.
 */
export function openStream(options: StreamOptions) {
  let closed = false,
    controller: AbortController | null = null,
    retry: ReturnType<typeof setTimeout> | undefined,
    delay = MIN_RETRY_MS;
  const setState = (state: StreamState) => options.onState?.(state);

  const run = async () => {
    if (closed || document.hidden || controller) return;
    clearTimeout(retry);
    retry = undefined;
    const current = (controller = new AbortController());
    setState("connecting");
    try {
      const response = await fetch(options.url(), {
        // The session cookie authenticates; no secret lives in page script.
        headers: { accept: "text/event-stream" },
        signal: current.signal,
      });
      if (response.status === 401) {
        closed = true;
        setState("unauthorized");
        return;
      }
      if (!response.ok || !response.body) throw new Error("Stream unavailable");
      setState("live");
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let data = "";
          for (const line of block.split("\n"))
            if (line.startsWith("data: ")) data += (data ? "\n" : "") + line.slice(6);
          if (!data) continue;
          delay = MIN_RETRY_MS;
          options.onMessage(JSON.parse(data));
        }
      }
    } catch {
      // Aborted, offline or malformed: handled by the reconnect below.
    } finally {
      if (controller === current) controller = null;
    }
    if (closed) return setState("closed");
    if (document.hidden) return setState("paused");
    setState("connecting");
    retry = setTimeout(() => void run(), delay);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  };

  const onVisibility = () => {
    if (document.hidden) {
      controller?.abort();
      clearTimeout(retry);
      setState("paused");
    } else {
      delay = MIN_RETRY_MS;
      void run();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  void run();
  return {
    close() {
      closed = true;
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", onVisibility);
      controller?.abort();
    },
  };
}
