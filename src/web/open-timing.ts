import { nextTick } from "vue";
import type { TimelineMessage } from "../shared/wire.ts";
import type { StreamState } from "./event-stream.ts";
import { version as WEB_VERSION } from "../../package.json";

/** Opens slower than this are reported to the server log; the spinner then says what it waits for. */
export const SLOW_OPEN_MS = 3000;
/**
 * What a conversation still loading after SLOW_OPEN_MS waits for: the LitePaseo server (no
 * stream response yet), the network (headers but no bytes: a proxy holding data) or the host's
 * daemon (the stream is flowing, rows are not). "loading": the plain request that opens it is still
 * out; its headers only come with the whole snapshot, so which layer waits cannot be told.
 */
export type OpenWait = "server" | "network" | "host" | "loading" | null;

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

/** Which kind of browser this is, without its user agent string: slow opens may be one kind's. */
function clientKind() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  // Every browser on iOS is WebKit, whatever it is called.
  const engine = /Firefox\//.test(ua) && !ios ? "gecko" : /Chrome\/|Chromium\//.test(ua) && !ios ? "blink" : /AppleWebKit\//.test(ua) ? "webkit" : "other";
  const os = ios ? "ios" : /Android/.test(ua) ? "android" : /Macintosh|Mac OS X/.test(ua) ? "macos" : /Windows/.test(ua) ? "windows" : /Linux/.test(ua) ? "linux" : "other";
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return { engine, os, standalone };
}
/** The protocol (h2, h3) of the latest finished API request, which a stream to the same server shares. */
function apiProtocol() {
  const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i].name.includes("/api/") && entries[i].nextHopProtocol) return entries[i].nextHopProtocol.slice(0, 20);
  return null;
}
/** Chunks of a stream whose arrival times are reported; the last one and the longest gap always are. */
const REPORTED_CHUNKS = 10;

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
  /** Which request brought the first rows: the plain one ("latest") or the stream. */
  let via: "latest" | "stream" = "stream";
  // How the body arrived: in pieces as sent, or held somewhere and delivered late in one go.
  let encoding: string | null = null, chunks = 0, characters = 0, lastChunkMs: number | null = null;
  let maxGapMs = 0, maxGapEndMs: number | null = null;
  const arrivals: [number, number][] = [];
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
    if (!done) setWait(via === "latest" && firstByteMs === null ? "loading" : connectedMs === null ? "server" : firstByteMs === null ? "network" : "host");
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
      via, ...clientKind(), protocol: apiProtocol(), encoding, chunks, characters, lastChunkMs, maxGapMs, maxGapEndMs, arrivals,
    });
  };
  return {
    /** Left before any rows arrived: reported with rowsMs null. */
    abandon() {
      if (done) return;
      finish();
      report(since());
    },
    /** Which request is bringing the first rows: the plain one, or the stream after it failed. */
    via(kind: "latest" | "stream") {
      via = kind;
    },
    /** Stream headers arrived. */
    response(response?: Response) {
      if (done) return;
      connectedMs ??= since();
      encoding = response?.headers.get("content-encoding")?.slice(0, 10) ?? null;
      if (wait === "server" || wait === "loading") setWait("network");
    },
    /** A piece of the body arrived (until the first rows). */
    chunk(size: number) {
      if (done) return;
      const at = since();
      if (lastChunkMs !== null && at - lastChunkMs > maxGapMs) {
        maxGapMs = at - lastChunkMs;
        maxGapEndMs = at;
      }
      lastChunkMs = at;
      chunks++;
      characters += size;
      if (arrivals.length < REPORTED_CHUNKS) arrivals.push([at, size]);
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
