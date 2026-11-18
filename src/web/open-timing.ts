import { nextTick } from "vue";
import type { TimelineMessage } from "../shared/wire.ts";
import type { StreamState } from "./event-stream.ts";
import { version as WEB_VERSION } from "../../package.json";

/** Opens slower than this are reported to the server log; the spinner then says what it waits for. */
export const SLOW_OPEN_MS = 3000;
/**
 * What a conversation still loading after SLOW_OPEN_MS waits for: the LitePaseo server (no
 * stream response yet), the network (headers but no bytes: a proxy holding data) or the host's
 * daemon (the stream is flowing, rows are not).
 */
export type OpenWait = "server" | "network" | "host" | null;

/** Page lifetime and the last time it was in the background, for slow-open reports. */
const pageStarted = performance.now();
let lastHidden: { at: number; ms: number } | null = null;
let hiddenSince: number | null = document.hidden ? performance.now() : null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenSince = performance.now();
  else if (hiddenSince !== null) {
    lastHidden = { at: performance.now(), ms: Math.round(performance.now() - hiddenSince) };
    hiddenSince = null;
  }
});

/**
 * Times one conversation open in this browser: connected (stream headers), first bytes (the
 * server's opening comment), first rows, and rows on screen. Slow opens are reported so a
 * stall can be placed: the server logs its own side as timeline_slow.
 */
export function trackTimelineOpen(
  agent: { hostId: string; id: string },
  send: (report: Record<string, unknown>) => void,
  onWait: (wait: OpenWait) => void,
) {
  const started = performance.now();
  const since = () => Math.round(performance.now() - started);
  let connectedMs: number | null = null, firstByteMs: number | null = null, rowsMs: number | null = null;
  let attempts = 0, hidden = document.hidden, done = false, wait: OpenWait = null;
  const setWait = (next: OpenWait) => {
    wait = next;
    onWait(next);
  };
  // Background time just before this open: a long one can leave a dead connection behind.
  const background = lastHidden && started - lastHidden.at < 60_000
    ? { backgroundMs: lastHidden.ms, visibleForMs: Math.round(started - lastHidden.at) }
    : { backgroundMs: null, visibleForMs: null };
  const pageAgeMs = Math.round(started - pageStarted);
  const onVisibility = () => (hidden ||= document.hidden);
  document.addEventListener("visibilitychange", onVisibility);
  setWait(null);
  const slow = setTimeout(() => {
    if (!done) setWait(connectedMs === null ? "server" : firstByteMs === null ? "network" : "host");
  }, SLOW_OPEN_MS);
  const finish = () => {
    done = true;
    clearTimeout(slow);
    setWait(null);
    document.removeEventListener("visibilitychange", onVisibility);
  };
  const report = (totalMs: number) => {
    if (totalMs < SLOW_OPEN_MS) return;
    send({
      hostId: agent.hostId, agentId: agent.id, totalMs, connectedMs, firstByteMs, rowsMs,
      renderMs: rowsMs === null ? null : totalMs - rowsMs, attempts, hidden,
      pageAgeMs, ...background, version: WEB_VERSION,
    });
  };
  return {
    /** Left before any rows arrived: reported with rowsMs null. */
    abandon() {
      if (done) return;
      finish();
      report(since());
    },
    /** Stream headers arrived. */
    response() {
      if (done) return;
      connectedMs ??= since();
      if (wait === "server") setWait("network");
    },
    state(state: StreamState) {
      if (done) return;
      if (state === "connecting") attempts++;
      if (state === "live") {
        connectedMs ??= since();
        firstByteMs ??= since();
        if (wait) setWait("host");
      }
      if (state === "closed" || state === "unauthorized") finish();
    },
    message(message: TimelineMessage) {
      if (done || !message.ops.some((op) => op.type === "reset")) return;
      rowsMs = since();
      finish();
      // On screen: after Vue renders the rows and the browser paints them.
      void nextTick(() => requestAnimationFrame(() => report(since())));
    },
  };
}
