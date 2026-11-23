<script setup lang="ts">
import { computed, inject, nextTick, onActivated, onDeactivated, onUnmounted, provide, ref, shallowRef, watch } from "vue";
import { SUGGESTIONS } from "./suggestions.ts";
import type { AgentBackgroundWorkItem, AgentSummary, PromptIndex, PromptMarker, ProviderSubagent, TimelineMessage, TimelinePage, TimelineRow, TimelineSnapshot, TimelineStreamMessage } from "../shared/wire.ts";
import { TimelineStore, type RowRef } from "./timeline-store.ts";
import { PAGE_STEP, pageHistory, RENDER_WINDOW } from "./timeline-window.ts";
import { openStream } from "./event-stream.ts";
import { TIMELINE_CONTEXT, turnFooters, type TimelineContext } from "./timeline-display.ts";
import { trackTimelineOpen, type OpenWait } from "./open-timing.ts";
import { formatElapsed } from "./elapsed.ts";
import TimelineRowView from "./TimelineRowView.vue";
import ChatOutline from "./ChatOutline.vue";
import ProviderIcon from "./ProviderIcon.vue";
import Icon from "./Icon.vue";
import { prefs } from "./preferences.ts";

/**
 * One agent's conversation: its live timeline stream, history paging in both directions, the
 * outline rail and jumps. One instance per conversation (keyed by the agent), so everything
 * here belongs to that conversation alone.
 *
 * The app keeps recently opened conversations alive (KeepAlive): switching back shows the
 * rendered rows at once. A conversation in the background is inert: no stream, no clock, no
 * reactive input. Back in view it reconnects, and the server's reset only re-renders rows
 * that changed meanwhile.
 */
const props = defineProps<{
  agent: AgentSummary;
  api: (path: string, method?: string, body?: unknown, timeoutMs?: number) => Promise<any>;
  /** Rows the timeline renders read file links, rewind and subagent links from here. */
  context: TimelineContext;
  hostLabel: string;
  /** The last row's Markdown is final: the turn ended and the streams are live. */
  settled: boolean;
  /** Model name for turn footers, as the composer chip names it. */
  footerModel: string;
  /** Native LitePaseo next-message suggestion service is configured. */
  suggestionsReady?: boolean;
}>();
const emit = defineEmits<{
  /** A failed history read or jump, for the app's error line. */
  error: [message: string];
  /** Both carry the agent key: a cached conversation's late event must not act for the open one. */
  subagents: [key: string, subagents: ProviderSubagent[]];
  backgroundWork: [key: string, items: AgentBackgroundWorkItem[]];
  /** The first rows arrived (read marking waits for them). */
  ready: [key: string];
  /** A click in the timeline (images open full size, local links open in the app). */
  timelineClick: [event: MouseEvent];
  unauthorized: [];
  /** A ready next-input suggestion in this conversation (the composer's Tab completion). */
  suggestion: [key: string, seqStart: number, text: string];
}>();

const base = () => `/hosts/${encodeURIComponent(props.agent.hostId)}/agents/${encodeURIComponent(props.agent.id)}`;

// Rows read this conversation's context, with its own subagents. Coming back to a cached
// conversation brings an equal but new context object: replacing it would re-render every row.
const subagents = shallowRef<ProviderSubagent[]>([]);
const backgroundWork = shallowRef<AgentBackgroundWorkItem[]>([]);
const context = shallowRef<TimelineContext>({ base: "", cwd: "" });
const contextKey = (c: TimelineContext) => JSON.stringify([c.base, c.cwd, c.session, c.workspace, c.localHost, c.rewindModes]);
watch(() => props.context, (value) => {
  if (contextKey(value) !== contextKey(context.value)) context.value = { ...value, subagents };
}, { immediate: true });
provide(TIMELINE_CONTEXT, context);
// Suggestion rows predict and offer for this conversation, even if another one opened while a
// prediction was on its way; using one acts on the open composer, as only a visible row can.
const suggestions = inject(SUGGESTIONS, null);
if (suggestions)
  provide(SUGGESTIONS, {
    predict: (token) => props.api(base() + "/suggestion", "POST", { token }, 65_000),
    use: (text) => suggestions.use(text),
    send: (text) => suggestions.send(text),
    offer: (seqStart, text) => emit("suggestion", props.agent.key, seqStart, text),
  });
/** False while the conversation is cached out of view. */
let inView = true;

const store = shallowRef(new TimelineStore());
const timelineNotice = ref("");
const timelineWait = ref<OpenWait>(null);
const historyRows = shallowRef<RowRef[] | null>(null);
const historyHasOlder = ref(false);
const historyNewer = ref<number[]>([]);
/** A history page being fetched while the reader scrolls; paging never blocks the composer. */
const paging = ref<"before" | "after" | null>(null);
const timelineElement = ref<HTMLElement | null>(null);
let disposed = false;

const visibleRows = computed(() => {
  if (historyRows.value) return historyRows.value;
  const s = store.value;
  s.membership.value;
  return s.rows.slice(-RENDER_WINDOW);
});
const turnsWithNativeMetrics = computed(() => {
  const set = new Set<string>();
  for (const r of visibleRows.value) {
    if (r.row.value.turnId && r.row.value.turnMetrics?.length) set.add(r.row.value.turnId);
  }
  return set;
});
const displayRows = computed(() => {
  const density = prefs.chatDensity;
  const nativeTurns = turnsWithNativeMetrics.value;
  return visibleRows.value.filter((r) => {
    const row = r.row.value;
    const item = row.item as Record<string, unknown>;
    // Avoid duplicating legacy turn-speed plugin rows when native turnMetrics exist.
    if (item.type === "plugin" && item.pluginId === "turn-speed" && row.turnId && nativeTurns.has(row.turnId)) return false;
    if (density === "full") return true;
    if (item.type === "user_message" || item.type === "assistant_message" || item.type === "error" || item.type === "notification" || item.type === "compaction") return true;
    if (item.type === "tool_call" && (item.status === "failed" || item.status === "running")) return true;
    if (density === "collapse-tools" && (item.type === "todo" || item.type === "plugin")) return true;
    return false;
  });
});
const openMetrics = ref<number | null>(null);
function turnMetricsSummary(metrics: { label: string; value: string }[]) {
  const skip = new Set(["model", "elapsed"]);
  const picked = metrics.filter((m) => !skip.has(m.label.toLowerCase()));
  const priority = ["speed", "tokens", "cost", "cache"];
  const ordered = [
    ...priority.flatMap((p) => picked.filter((m) => m.label.toLowerCase().startsWith(p))),
    ...picked.filter((m) => !priority.some((p) => m.label.toLowerCase().startsWith(p))),
  ];
  return (ordered.length ? ordered : metrics).slice(0, 3).map((m) => m.value).join(" · ");
}

// ---- Native next-message suggestion (no daemon plugin required) ------------------------------
const RISKY_SUGGESTION = /[`$|<>]|(^|\s)[.~]?\/[\w.-]|https?:|www\.|\b(rm|sudo|delete|drop|remove|reset|force|push|deploy|publish|release|merge|token|password|passwd|secret|credential|api[ _-]?key|ssh)\b|删除|推送|部署|发布|密码|密钥|令牌/i;
const nativeSuggestion = ref<{ seqEnd: number; status: "loading" | "ready"; text: string } | null>(null);
const nativeSuggestionRisky = computed(() => !!nativeSuggestion.value?.text && RISKY_SUGGESTION.test(nativeSuggestion.value.text));
let suggestionTimer: ReturnType<typeof setTimeout> | undefined;
let suggestionRequestedSeq = -1;

const suggestionTarget = computed(() => {
  if (!props.suggestionsReady || !props.settled || historyRows.value || !store.value.ready) return null;
  const rows = visibleRows.value.map((r) => r.row.value);
  if (!rows.length) return null;
  // Skip if the legacy next-input daemon plugin already appended a suggestion row at the tail.
  const tail = rows.slice(-3);
  if (tail.some((r) => r.item.type === "plugin" && (r.item as Record<string, unknown>).pluginId === "next-input")) return null;
  const lastMsg = [...rows].reverse().find((r) => r.item.type === "assistant_message" || r.item.type === "user_message");
  if (!lastMsg || lastMsg.item.type !== "assistant_message" || !String(lastMsg.item.text ?? "").trim()) return null;
  const messages: { role: "user" | "assistant"; text: string }[] = [];
  for (const r of rows) {
    if (r.item.type === "user_message" && String(r.item.text ?? "").trim()) messages.push({ role: "user", text: String(r.item.text) });
    else if (r.item.type === "assistant_message" && String(r.item.text ?? "").trim()) messages.push({ role: "assistant", text: String(r.item.text) });
  }
  if (!messages.some((m) => m.role === "user")) return null;
  return { seqEnd: lastMsg.seqEnd, seqStart: lastMsg.seqStart, messages: messages.slice(-12) };
});

watch(suggestionTarget, (target) => {
  clearTimeout(suggestionTimer);
  if (!target) {
    nativeSuggestion.value = null;
    return;
  }
  if (target.seqEnd === suggestionRequestedSeq) return;
  nativeSuggestion.value = null;
  const seqEnd = target.seqEnd;
  const seqStart = target.seqStart;
  const messages = target.messages;
  suggestionTimer = setTimeout(async () => {
    if (disposed || !inView || suggestionTarget.value?.seqEnd !== seqEnd) return;
    suggestionRequestedSeq = seqEnd;
    nativeSuggestion.value = { seqEnd, status: "loading", text: "" };
    try {
      const res = await props.api(base() + "/next-suggestion", "POST", { lastSeqEnd: seqEnd, messages }, 20_000);
      if (disposed || suggestionTarget.value?.seqEnd !== seqEnd) return;
      if (res?.status === "ready" && typeof res.text === "string" && res.text.trim()) {
        nativeSuggestion.value = { seqEnd, status: "ready", text: res.text.trim() };
        emit("suggestion", props.agent.key, seqStart, res.text.trim());
      } else {
        nativeSuggestion.value = null;
      }
    } catch {
      if (!disposed && nativeSuggestion.value?.seqEnd === seqEnd) nativeSuggestion.value = null;
    }
  }, 600);
}, { immediate: true });
// Finished turns get a footer (copy, completion time, duration), as in Paseo. Recomputed per
// timeline flush over the rendered window only (≤ RENDER_WINDOW rows).
const turnMeta = computed(() => {
  const rows = visibleRows.value.map((r) => r.row.value);
  const a = props.agent;
  const lastFinished = (!!historyRows.value && historyNewer.value.length > 0) || !(a.turnActive ?? a.state === "running");
  return turnFooters(rows, lastFinished);
});
const lastTimelineSeq = computed(() => {
  const s = store.value;
  s.membership.value;
  return s.rows.at(-1)?.seqStart;
});
const canShowOlder = computed(() => {
  if (historyRows.value) return historyHasOlder.value;
  const s = store.value;
  s.membership.value;
  return s.rows.length > RENDER_WINDOW || s.hasOlder;
});

const copiedTurn = ref<number | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyTurn(seqStart: number, messages: number[]) {
  const wanted = new Set(messages);
  const text = visibleRows.value
    .filter((r) => wanted.has(r.seqStart))
    .map((r) => String(r.row.value.item.text ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copiedTurn.value = seqStart;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copiedTurn.value = null), 1500);
  } catch {
    /* clipboard denied (insecure origin): nothing to do */
  }
}

// ---- Working indicator: a 1 s clock runs only while the agent works and the page is visible ----
const working = computed(() => !historyRows.value && props.agent.state === "running");
const clockNow = ref(Date.now());
const turnStartedAt = computed(() => (working.value ? props.agent.turnStartedAt ?? null : null));
const elapsed = computed(() => (turnStartedAt.value ? formatElapsed(clockNow.value - turnStartedAt.value) : ""));
/** Whole seconds into the turn: the timer text and the spinner's quarter turns move together. */
const turnSeconds = computed(() => (turnStartedAt.value ? Math.max(0, Math.floor((clockNow.value - turnStartedAt.value) / 1000)) : 0));
let elapsedTimer: ReturnType<typeof setTimeout> | undefined;
function syncElapsedClock() {
  clearTimeout(elapsedTimer);
  elapsedTimer = undefined;
  const start = turnStartedAt.value;
  if (!start || document.hidden || disposed || !inView) return;
  // Tick just after each whole second of the turn, so every tick changes the display once.
  const tick = () => {
    clockNow.value = Date.now();
    const into = (clockNow.value - start) % 1000;
    elapsedTimer = setTimeout(tick, (into < 0 ? -into : 1000 - into) + 10);
  };
  tick();
}
watch(turnStartedAt, syncElapsedClock, { immediate: true });
document.addEventListener("visibilitychange", syncElapsedClock);

// ---- Opening, then the live stream --------------------------------------------------------------
/** Times the first open only: a cached conversation coming back already shows its rows. */
const opening = trackTimelineOpen(
  props.agent,
  (report) => void props.api("/diagnostics/timeline-slow", "POST", report).catch(() => {}),
  (wait) => (timelineWait.value = wait),
);
let stream: { close(): void } | null = null;
/** The first rows are on their way through a plain request; the stream waits for them. */
let loadingLatest = true;
const latestAbort = new AbortController();
void open();
/**
 * The first rows come through a plain request, which has an end: no proxy holds its tail back
 * the way some held back a long-lived stream's first rows (seen on an iPhone web app behind a
 * Cloudflare Tunnel). The stream then resumes from those rows and only pushes what changes.
 * Should the request fail (an older server, say), the stream sends the rows itself, as before.
 */
async function open() {
  await loadLatest();
  loadingLatest = false;
  if (!disposed && inView && !stream) stream = connect();
}
async function loadLatest() {
  opening.via("latest");
  try {
    const response = await fetch("/api" + base() + "/timeline/latest", {
      // The custom header marks same-origin script (CSRF guard), as for every API call.
      headers: { "x-litepaseo": "1" },
      signal: AbortSignal.any([latestAbort.signal, AbortSignal.timeout(60_000)]),
    });
    if (response.status === 401) return emit("unauthorized");
    if (!response.ok || !response.body) return opening.via("stream");
    opening.response(response);
    // Read as it arrives, so a slow open can be told apart from a held-back one.
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!text) opening.state("live");
      opening.chunk(value.length);
      text += value;
    }
    if (!disposed) receive({ type: "ops", ops: [JSON.parse(text) as TimelineSnapshot] });
  } catch {
    // Aborted, offline or not understood: the stream carries the rows instead.
    opening.via("stream");
  }
}
function connect() {
  return openStream({
    // Evaluated on every (re)connect: holding the conversation, ask only for what changed since.
    url: () => {
      const at = store.value.resumePoint();
      const query = at ? `?epoch=${encodeURIComponent(at.epoch)}&seq=${at.seq}&from=${at.from}` : "";
      return "/api" + base() + "/timeline/stream" + query;
    },
    onResponse: (response) => opening.response(response),
    onChunk: (size) => opening.chunk(size),
    onState: (state) => {
      if (state === "unauthorized") emit("unauthorized");
      opening.state(state);
    },
    onMessage: receive,
  });
}
function receive(data: unknown) {
  const s = store.value;
  const message = data as TimelineStreamMessage;
  if (message.type === "subagents") {
    subagents.value = message.subagents;
    if (inView) emit("subagents", props.agent.key, message.subagents);
    return;
  }
  if (message.type === "background-work") {
    backgroundWork.value = message.items;
    if (inView) emit("backgroundWork", props.agent.key, message.items);
    return;
  }
  const ops = (data as TimelineMessage).ops;
  // Not understood (another server version, a proxy's message): ignore it rather than throw,
  // which would close the stream and reconnect into the same message over and over.
  if (!Array.isArray(ops)) return;
  opening.message(message);
  const stick = !historyRows.value && (nearBottom() || !s.ready);
  const failure = ops.find((op) => op.type === "error");
  timelineNotice.value = failure?.type === "error" ? failure.message : "";
  const epoch = s.epoch;
  const wasReady = s.ready;
  s.apply(ops);
  // Rows that land while cached out of view report ready when the conversation comes back.
  if (!wasReady && s.ready && inView) emit("ready", props.agent.key);
  if (s.epoch && s.epoch !== promptEpoch) void loadPrompts(s);
  if (epoch && epoch !== s.epoch) {
    historyRows.value = null;
    historyNewer.value = [];
    scrollToBottom();
  }
  if (stick) scrollToBottom();
}

// ---- Scrolling --------------------------------------------------------------------------------
// Async Markdown nodes can acquire height after the SSE update's nextTick.
// Follow that layout only while the reader remains at the live tail.
let followLatest = true;
/** Where the reader was, restored when a cached conversation comes back into view. */
let savedTop = 0;
watch(timelineElement, (element, _previous, cleanup) => {
  const inner = element?.querySelector(".timeline-inner");
  if (!element || !inner) return;
  // Only the reader scrolling up leaves the tail. A programmatic scroll can land short of the
  // bottom when content grows before its scroll event is dispatched; that must not unfollow.
  let lastTop = element.scrollTop;
  const onScroll = () => {
    if (!inView) return;
    const top = element.scrollTop;
    savedTop = top;
    if (nearBottom()) followLatest = true;
    else if (top < lastTop - 1) followLatest = false;
    // Pages load ahead of the reader in the direction they scroll; our own anchor
    // corrections after a page swap are not reader intent.
    scheduleActivePrompt();
    // The scroll event of our own correction lands where we put it: not reader intent.
    const ours = programmaticTop !== null && Math.abs(top - programmaticTop) < 2;
    if (ours) programmaticTop = null;
    if (!ours && performance.now() >= pagingQuietUntil) {
      if (top < lastTop - 1) pagingIntent = "up";
      else if (top > lastTop + 1) pagingIntent = "down";
      autoPage();
    }
    lastTop = top;
  };
  const observer = new ResizeObserver(() => {
    if (inView && !historyRows.value && followLatest) scrollToBottom();
  });
  // At either end of a window there is nothing left to scroll, so no scroll event: the wheel
  // still says which way the reader wants to go.
  const onWheel = (event: WheelEvent) => {
    if (performance.now() < pagingQuietUntil || !event.deltaY) return;
    pagingIntent = event.deltaY < 0 ? "up" : "down";
    autoPage();
  };
  // Touch browsers do not emit wheel events when a swipe reaches the scroll boundary.
  let touchY: number | null = null;
  let touchRetry: ReturnType<typeof setTimeout> | undefined;
  const onTouchStart = (event: TouchEvent) => { touchY = event.touches.length === 1 ? event.touches[0].clientY : null; };
  const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) { touchY = null; return; }
    const y = event.touches[0].clientY;
    if (touchY !== null && Math.abs(y - touchY) > 2) {
      pagingIntent = y > touchY ? "up" : "down";
      if (pagingIntent === "up") followLatest = false;
      if (performance.now() >= pagingQuietUntil) autoPage();
      else { clearTimeout(touchRetry); touchRetry = setTimeout(autoPage, 50); }
    }
    touchY = y;
  };
  const onTouchEnd = () => { touchY = null; };
  element.addEventListener("touchstart", onTouchStart, { passive: true });
  element.addEventListener("touchmove", onTouchMove, { passive: true });
  element.addEventListener("touchend", onTouchEnd, { passive: true });
  element.addEventListener("touchcancel", onTouchEnd, { passive: true });
  element.addEventListener("scroll", onScroll, { passive: true });
  element.addEventListener("wheel", onWheel, { passive: true });
  observer.observe(inner);
  // The viewport shrinks when the composer grows (attachments, multi-line drafts): keep the tail in view.
  observer.observe(element);
  cleanup(() => {
    clearTimeout(touchRetry);
    element.removeEventListener("touchstart", onTouchStart);
    element.removeEventListener("touchmove", onTouchMove);
    element.removeEventListener("touchend", onTouchEnd);
    element.removeEventListener("touchcancel", onTouchEnd);
    observer.disconnect();
    element.removeEventListener("scroll", onScroll);
    element.removeEventListener("wheel", onWheel);
  });
}, { flush: "post" });

/**
 * Infinite history in both directions. Scrolling up near the top fetches the previous page;
 * scrolling down near the bottom of a history window fetches the next one, and past the newest
 * page returns to the live tail. The window stays at RENDER_WINDOW rows: pages that scroll far
 * out of view are dropped, so a long read does not accumulate rows in memory.
 */
let pagingIntent: "up" | "down" | null = null,
  pagingQuietUntil = 0,
  /** Where our last own scroll correction put the timeline; its scroll event is skipped. */
  programmaticTop: number | null = null;
/** Moves the timeline ourselves. A brief quiet window covers browsers that settle a pixel off. */
function setScrollTop(el: HTMLElement, top: number) {
  el.scrollTop = top;
  programmaticTop = el.scrollTop;
  pagingQuietUntil = performance.now() + 40;
}
function autoPage() {
  const el = timelineElement.value;
  if (!el || !inView || paging.value || !pagingIntent || el.offsetParent === null) return;
  const ahead = Math.max(600, el.clientHeight);
  if (pagingIntent === "up" && el.scrollTop < ahead && canShowOlder.value) void moveHistory("before");
  else if (pagingIntent === "down" && historyRows.value && el.scrollHeight - el.scrollTop - el.clientHeight < ahead) {
    void moveHistory("after"); // continues from the server or the live store; returns to live at the tail
  }
}
/** The row at the top (or bottom) edge of the viewport, to hold in place across a window swap. */
function screenAnchor(edge: "first" | "last") {
  const el = timelineElement.value;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const onScreen = Array.from(el.querySelectorAll<HTMLElement>("[data-seq-start]")).filter((row) => {
    const r = row.getBoundingClientRect();
    return r.bottom > rect.top && r.top < rect.bottom;
  });
  const row = edge === "first" ? onScreen[0] : onScreen.at(-1);
  return row ? { seq: row.dataset.seqStart!, top: row.getBoundingClientRect().top } : null;
}
/** After the DOM updates: puts the anchor row back where it was. False when it is gone. */
function restoreAnchor(anchor: { seq: string; top: number } | null) {
  const el = timelineElement.value;
  const retained = anchor && el?.querySelector<HTMLElement>(`[data-seq-start="${anchor.seq}"]`);
  if (!el || !retained) return false;
  setScrollTop(el, el.scrollTop + retained.getBoundingClientRect().top - anchor!.top);
  return true;
}
/** Leaves a history window that reached the newest page, keeping the reader's position. */
async function returnToLive() {
  const anchor = screenAnchor("last");
  historyRows.value = null;
  historyNewer.value = [];
  await nextTick();
  if (!restoreAnchor(anchor)) scrollToBottom();
  else if (nearBottom()) followLatest = true;
}
function nearBottom() {
  const el = timelineElement.value;
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
function scrollToBottom() {
  followLatest = true;
  void nextTick(() => {
    const el = timelineElement.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}
function showLatest() {
  historyRows.value = null;
  historyNewer.value = [];
  scrollToBottom();
}

// ---- History pages ----------------------------------------------------------------------------
function fetchHistoryPage(epoch: string, seq: number): Promise<TimelinePage> {
  return props.api(base() + "/timeline?cursor=" + encodeURIComponent(JSON.stringify({ epoch, seq })));
}
/**
 * Forward cursors left by paging back are exact: the page before each one starts right after
 * the window. Cursors from a jump (later prompts, the live store's start) may be more than a
 * page ahead, so their pages are checked for a gap first.
 */
const exactCursors = new Set<number>();
/**
 * Jump cursors are one per prompt, and short turns would cost a request each: try a cursor
 * this many prompts further first. Its page covers the turns in between when it still
 * reaches back to the window; the reach doubles on success and halves on a miss.
 */
let skipAhead = 4;
/**
 * Up to a page of rows after `last`, for paging forward. `historyNewer` holds "before" cursors
 * (nearest on top). With none left the live store continues the window; a gap between the
 * window and the store is filled from the server. "stale": the conversation was replaced.
 */
async function newerRows(s: TimelineStore, epoch: string, last: number): Promise<RowRef[] | null | "stale"> {
  const found: RowRef[] = [];
  // Set once the server has nothing between the window and the live store's first row.
  let reachedStore = false;
  for (let request = 0; request < 8 && found.length < PAGE_STEP; ) {
    const after = found.at(-1)?.seqStart ?? last;
    const top = historyNewer.value.at(-1);
    if (top === undefined) {
      const rows = s.rows;
      if (!rows.length) break;
      if (rows[0].seqStart <= after || reachedStore) {
        // Live rows keep their own refs, so a history window that reaches them stays live.
        const i = rows.findIndex((r) => r.seqStart > after);
        if (i >= 0) found.push(...rows.slice(i, i + PAGE_STEP - found.length));
        break;
      }
      historyNewer.value.push(rows[0].seqStart);
      continue;
    }
    request++;
    const stack = historyNewer.value;
    const reaches = (p: TimelinePage) => !p.hasOlder || p.rows.some((r) => r.seqStart <= after);
    const reach = exactCursors.has(top) ? 0 : Math.min(skipAhead, stack.length - 1);
    if (reach > 0) {
      const index = stack.length - 1 - reach;
      const far = await fetchHistoryPage(epoch, stack[index]);
      if (far.epoch !== epoch) return "stale";
      if (reaches(far)) {
        const cursor = stack[index], newer = far.rows.filter((r) => r.seqStart > after), room = PAGE_STEP - found.length;
        stack.splice(index);
        // Rows beyond this page's share stay reachable through the same cursor.
        if (newer.length > room) stack.push(cursor);
        found.push(...newer.slice(0, room).map((row) => ({ seqStart: row.seqStart, row: shallowRef(row) })));
        skipAhead = Math.min(skipAhead * 2, 64);
        continue;
      }
      skipAhead = reach >> 1;
      continue;
    }
    let page = await fetchHistoryPage(epoch, top);
    if (page.epoch !== epoch) return "stale";
    let newer = page.rows.filter((r) => r.seqStart > after), consumed = true;
    // Not known to start right after the window: look below the page; anything found there
    // comes first, and this cursor stays on the stack for the rest.
    while (!exactCursors.has(top) && newer.length && page.hasOlder && !page.rows.some((r) => r.seqStart <= after) && request < 8) {
      request++;
      const near = newer[0].seqStart;
      const probe = await fetchHistoryPage(epoch, near);
      if (probe.epoch !== epoch) return "stale";
      const between = probe.rows.filter((r) => r.seqStart > after && r.seqStart < near);
      if (!between.length) break;
      page = probe;
      newer = between;
      consumed = false;
    }
    const room = PAGE_STEP - found.length;
    if (!newer.length && top === s.rows[0]?.seqStart) reachedStore = true;
    // The cursor is spent only when its page fits; otherwise the rest comes from it next time.
    if (consumed && newer.length <= room) historyNewer.value.pop();
    found.push(...newer.slice(0, room).map((row) => ({ seqStart: row.seqStart, row: shallowRef(row) })));
    if (!consumed) break;
  }
  return found.length ? found : null;
}
async function moveHistory(direction: "before" | "after") {
  const s = store.value;
  const el = timelineElement.value;
  const current = visibleRows.value.slice();
  // Rows paged back into history are a snapshot; rows continued from the live store stay live.
  if (direction === "before") current.forEach((r, i) => (current[i] = { seqStart: r.seqStart, row: shallowRef(r.row.value) }));
  const edge = direction === "before" ? current[0] : current.at(-1);
  if (!edge || paging.value) return;
  const epoch = s.epoch;
  paging.value = direction;
  try {
    const stillHere = () => !disposed && inView && store.value === s && s.epoch === epoch;
    if (direction === "before") {
      const page = await fetchHistoryPage(epoch, edge.seqStart);
      if (!stillHere()) return;
      if (page.epoch !== epoch) return showLatest();
      // The reader kept scrolling while the page loaded: anchor to where they are now.
      const anchor = screenAnchor("first");
      const window = pageHistory(current, page, "before");
      // Forward navigation uses this page's stable seqStart boundary. An `after` catch-up
      // read can include old tool rows whose seqEnd changed much later.
      if (window.added) {
        historyNewer.value.push(current.at(-1)!.seqStart + 1);
        exactCursors.add(current.at(-1)!.seqStart + 1);
      }
      historyRows.value = window.rows;
      historyHasOlder.value = window.hasOlder;
      await nextTick();
      if (!restoreAnchor(anchor) && el) el.scrollTop = 0;
    } else {
      const added = await newerRows(s, epoch, edge.seqStart);
      if (!stillHere()) return;
      if (added === "stale") return showLatest();
      const tail = s.rows.at(-1)?.seqStart;
      const combined = [...current, ...(added ?? [])].slice(-RENDER_WINDOW);
      // Caught up with the live tail: leave history, keeping the reader's place.
      if (!added || (tail !== undefined && combined.at(-1)!.seqStart >= tail)) {
        historyNewer.value = [];
        await returnToLive();
        return;
      }
      const anchor = screenAnchor("last");
      historyRows.value = combined;
      historyHasOlder.value = true;
      await nextTick();
      if (!restoreAnchor(anchor) && el) el.scrollTop = el.scrollHeight;
    }
  } catch (e) {
    emit("error", String((e as Error).message));
    pagingIntent = null; // no retry loop on failure; the next scroll tries again
  } finally {
    paging.value = null;
  }
  // Still near the edge (a fast fling, short rows): keep going in the same direction.
  void nextTick(autoPage);
}

// ---- Outline rail: the conversation's prompts, with hover previews and jump-to ---------------
const canHoverOutline = matchMedia("(hover: hover) and (pointer: fine)").matches;
/** The daemon's prompt index for this conversation (whole history, not just loaded rows). */
const promptIndex = shallowRef<PromptMarker[] | null>(null);
let promptEpoch = "";
async function loadPrompts(s: TimelineStore) {
  promptEpoch = s.epoch;
  try {
    const index: PromptIndex = await props.api(base() + "/timeline/prompts");
    if (store.value === s && index.epoch === s.epoch) promptIndex.value = index.prompts;
  } catch {
    // Older daemon: the rail falls back to the prompts already loaded.
    if (store.value === s) promptIndex.value = [];
  }
}
const previewOf = (row: TimelineRow) => String(row.item.text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
/** Indexed prompts plus any sent since the index was read (from the live store). */
const outlinePrompts = computed<PromptMarker[]>(() => {
  const s = store.value;
  s.membership.value;
  const index = promptIndex.value ?? [];
  const lastIndexed = index.at(-1)?.seq ?? -1;
  const live: PromptMarker[] = [];
  for (const r of s.rows)
    if (r.seqStart > lastIndexed && r.row.value.item.type === "user_message") live.push({ seq: r.seqStart, preview: previewOf(r.row.value) });
  return live.length ? [...index, ...live] : index;
});
/** The prompt whose turn is at the top of the viewport. */
const activePromptSeq = ref<number | null>(null);
let activeFrame = 0;
function scheduleActivePrompt() {
  if (activeFrame || outlinePrompts.value.length < 2 || !canHoverOutline) return;
  activeFrame = requestAnimationFrame(() => {
    activeFrame = 0;
    const top = screenAnchor("first");
    activePromptSeq.value = top ? Number(top.seq) : null;
  });
}
watch([outlinePrompts, historyRows], () => void nextTick(scheduleActivePrompt));
/** Brings a row to the top of the viewport (just below the edge, so it reads as the start). */
function revealRow(seq: number) {
  const el = timelineElement.value;
  const row = el?.querySelector<HTMLElement>(`[data-seq-start="${seq}"]`)
    ?? Array.from(el?.querySelectorAll<HTMLElement>("[data-seq-start]") ?? []).find((r) => Number(r.dataset.seqStart) >= seq || (r.classList.contains("row-assistant") && Number(r.dataset.seqEnd) >= seq));
  if (!el || !row) return;
  followLatest = false;
  setScrollTop(el, el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top - 12);
  scheduleActivePrompt();
}
/**
 * Jumps to a prompt: in place when rendered, from the live store when it holds the prompt, else
 * from the server (the prompt's turn, up to the next prompt). Later prompts become the forward
 * cursors, so scrolling down from there pages through the turns in order.
 */
async function jumpToPrompt(seq: number, exact = false) {
  const s = store.value;
  if (paging.value || !inView) return;
  if (timelineElement.value?.querySelector(`[data-seq-start="${seq}"]`)) return revealRow(seq);
  const rows = s.rows;
  const local = rows.length && rows[0].seqStart <= seq ? rows.findIndex((r) => r.seqStart >= seq || (r.row.value.item.type === "assistant_message" && r.row.value.seqEnd >= seq)) : -1;
  if (local >= 0) {
    const start = local;
    historyNewer.value = [];
    if (start >= rows.length - RENDER_WINDOW) historyRows.value = null;
    else {
      historyRows.value = rows.slice(start, start + RENDER_WINDOW);
      historyHasOlder.value = start > 0 || s.hasOlder;
    }
    await nextTick();
    return revealRow(seq);
  }
  const epoch = s.epoch;
  const later = outlinePrompts.value.map((p) => p.seq).filter((p) => p > seq && (!rows.length || p < rows[0].seqStart));
  paging.value = "before";
  try {
    let cursor = exact ? seq + 1 : later[0] ?? rows[0]?.seqStart ?? Number.MAX_SAFE_INTEGER;
    let collected: TimelineRow[] = [], hasOlder = false;
    // A turn longer than a page: keep reading back until the prompt itself is in hand.
    for (let request = 0; request < 8; request++) {
      const page = await fetchHistoryPage(epoch, cursor);
      if (disposed || !inView || store.value !== s) return;
      if (page.epoch !== epoch) return showLatest();
      collected = [...page.rows, ...collected];
      hasOlder = page.hasOlder;
      if (!page.rows.length || page.rows[0].seqStart <= seq || !page.hasOlder) break;
      cursor = page.rows[0].seqStart;
    }
    const at = Math.max(0, collected.findIndex((r) => r.seqStart >= seq || (r.item.type === "assistant_message" && r.seqEnd >= seq)));
    const start = at; // the prompt opens the window; earlier rows load as the reader scrolls up
    let jumped: RowRef[] = collected.slice(start, start + RENDER_WINDOW).map((row) => ({ seqStart: row.seqStart, row: shallowRef(row) }));
    historyNewer.value = [...later].reverse();
    exactCursors.clear();
    skipAhead = 4;
    // A short turn: fill the window from the following turns, so there is something to scroll.
    if (jumped.length && jumped.length <= RENDER_WINDOW - PAGE_STEP) {
      const more = await newerRows(s, epoch, jumped.at(-1)!.seqStart);
      if (disposed || !inView || store.value !== s) return;
      if (more === "stale") return showLatest();
      if (more) jumped = [...jumped, ...more];
    }
    historyRows.value = jumped;
    historyHasOlder.value = hasOlder || start > 0;
    await nextTick();
    revealRow(seq);
    // Read ahead: the next turns are where the reader goes from a jump.
    pagingIntent = "down";
    requestAnimationFrame(autoPage);
  } catch (e) {
    emit("error", String((e as Error).message));
  } finally {
    paging.value = null;
  }
}

// Out of view: inert until it comes back. In view again: the reader's place, then a fresh
// stream (its reset re-renders only rows that changed meanwhile).
onDeactivated(() => {
  inView = false;
  opening.abandon();
  stream?.close();
  stream = null;
  clearTimeout(elapsedTimer);
  clearTimeout(suggestionTimer);
  cancelAnimationFrame(activeFrame);
  activeFrame = 0;
  pagingIntent = null;
});
onActivated(() => {
  if (inView) return; // the first mount
  inView = true;
  const el = timelineElement.value;
  if (el) {
    setScrollTop(el, followLatest && !historyRows.value ? el.scrollHeight : savedTop);
  }
  if (store.value.ready) emit("ready", props.agent.key);
  if (subagents.value.length) emit("subagents", props.agent.key, subagents.value);
  emit("backgroundWork", props.agent.key, backgroundWork.value);
  // Still opening: the first rows connect the stream when they land.
  if (!loadingLatest) stream = connect();
  syncElapsedClock();
  scheduleActivePrompt();
});

onUnmounted(() => {
  disposed = true;
  opening.abandon();
  latestAbort.abort();
  stream?.close();
  clearTimeout(elapsedTimer);
  clearTimeout(copiedTimer);
  clearTimeout(suggestionTimer);
  cancelAnimationFrame(activeFrame);
  document.removeEventListener("visibilitychange", syncElapsedClock);
});

defineExpose({
  jumpToPrompt,
  showLatest,
  /** The conversation's epoch; a search result from another one cannot be jumped to. */
  epoch: () => store.value.epoch,
});
</script>

<template>
  <div class="timeline-wrap">
    <div ref="timelineElement" class="timeline" @click="emit('timelineClick', $event)">
      <div class="timeline-inner">
        <div v-if="canShowOlder" class="older">
          <span v-if="paging === 'before'" class="older-loading" role="status"><span class="spinner"></span>Loading earlier messages…</span>
          <!-- Scrolling up loads automatically; the button covers a window too short to scroll. -->
          <button v-else class="btn btn-ghost" @click="moveHistory('before')">Show earlier messages</button>
        </div>
        <p v-if="timelineNotice" class="notice"><Icon name="alert" :size="14" />{{ timelineNotice }}</p>
        <template v-for="r in displayRows" :key="`${store.epoch}:${r.seqStart}`">
          <TimelineRowView :entry="r.row" :final="r.seqStart !== lastTimelineSeq || settled" :data-seq-start="r.seqStart" />
          <div v-if="turnMeta.get(r.seqStart)" class="turn-footer">
            <button
              v-if="turnMeta.get(r.seqStart)!.messages.length"
              type="button"
              class="turn-item turn-copy"
              :aria-label="copiedTurn === r.seqStart ? 'Copied' : 'Copy turn'"
              :title="copiedTurn === r.seqStart ? 'Copied' : 'Copy turn'"
              @click="copyTurn(r.seqStart, turnMeta.get(r.seqStart)!.messages)"
            >
              <Icon :name="copiedTurn === r.seqStart ? 'check' : 'copy'" :size="14" />{{ copiedTurn === r.seqStart ? "Copied" : "Copy" }}
            </button>
            <span v-if="footerModel && r.row.value.provider === agent.provider" class="turn-item" :title="'Model: ' + footerModel">
              <ProviderIcon :provider="r.row.value.provider" />{{ footerModel }}
            </span>
            <span class="turn-item" :title="'Finished ' + turnMeta.get(r.seqStart)!.at"><Icon name="clock" :size="14" />{{ turnMeta.get(r.seqStart)!.at }}</span>
            <span v-if="turnMeta.get(r.seqStart)!.took" class="turn-item" :title="'Worked for ' + turnMeta.get(r.seqStart)!.took">
              <Icon name="hourglass" :size="14" />{{ turnMeta.get(r.seqStart)!.took }}
            </span>
            <button
              v-if="(turnMeta.get(r.seqStart)!.metrics ?? r.row.value.turnMetrics)?.length"
              type="button"
              class="turn-item turn-stats-btn"
              :aria-expanded="openMetrics === r.seqStart"
              :title="(turnMeta.get(r.seqStart)!.metrics ?? r.row.value.turnMetrics)!.map((m) => m.label + ': ' + m.value).join(' · ')"
              @click="openMetrics = openMetrics === r.seqStart ? null : r.seqStart"
            >
              <Icon name="gauge" :size="13" />{{ turnMetricsSummary((turnMeta.get(r.seqStart)!.metrics ?? r.row.value.turnMetrics)!) }}
            </button>
          </div>
          <div v-else-if="r.row.value.turnMetrics?.length" class="turn-footer">
            <button
              type="button"
              class="turn-item turn-stats-btn"
              :aria-expanded="openMetrics === r.seqStart"
              :title="r.row.value.turnMetrics.map((m) => m.label + ': ' + m.value).join(' · ')"
              @click="openMetrics = openMetrics === r.seqStart ? null : r.seqStart"
            >
              <Icon name="gauge" :size="13" />{{ turnMetricsSummary(r.row.value.turnMetrics) }}
            </button>
          </div>
          <div v-else-if="r.row.value.turnMetrics?.length" class="turn-footer">
            <button
              type="button"
              class="turn-item turn-stats-btn"
              :aria-expanded="openMetrics === r.seqStart"
              :title="r.row.value.turnMetrics.map((m) => m.label + ': ' + m.value).join(' · ')"
              @click="openMetrics = openMetrics === r.seqStart ? null : r.seqStart"
            >
              <Icon name="gauge" :size="13" />{{ turnMetricsSummary(r.row.value.turnMetrics) }}
            </button>
          </div>
          <div v-else-if="r.row.value.turnMetrics?.length" class="turn-footer">
            <button
              type="button"
              class="turn-item turn-stats-btn"
              :aria-expanded="openMetrics === r.seqStart"
              :title="r.row.value.turnMetrics.map((m) => m.label + ': ' + m.value).join(' · ')"
              @click="openMetrics = openMetrics === r.seqStart ? null : r.seqStart"
            >
              <Icon name="gauge" :size="13" />{{ turnMetricsSummary(r.row.value.turnMetrics) }}
            </button>
          </div>
          <div v-if="(turnMeta.get(r.seqStart)?.metrics ?? r.row.value.turnMetrics)?.length && openMetrics === r.seqStart" class="turn-metrics-card" role="region" aria-label="Turn stats">
            <div v-for="(m, mi) in (turnMeta.get(r.seqStart)?.metrics ?? r.row.value.turnMetrics)!" :key="mi" class="turn-metric" :class="m.tone && 'is-' + m.tone">
              <span class="turn-metric-label">{{ m.label }}</span>
              <span class="turn-metric-value">{{ m.value }}</span>
            </div>
          </div>
        </template>
        <div v-if="historyRows" class="older">
          <span v-if="paging === 'after'" class="older-loading" role="status"><span class="spinner"></span>Loading newer messages…</span>
          <button v-else class="btn btn-ghost" @click="showLatest">Back to latest</button>
        </div>
        <div v-if="nativeSuggestion && !working" class="row row-suggestion" :class="'is-' + nativeSuggestion.status">
          <template v-if="nativeSuggestion.status === 'loading'">
            <span class="spinner spinner-sm"></span><span class="suggestion-wait">Thinking of a next message…</span>
          </template>
          <template v-else>
            <button class="suggestion-text" title="Put in the message box to edit (or press Tab)" @click="suggestions?.use(nativeSuggestion.text)">{{ nativeSuggestion.text }}</button>
            <span class="suggestion-actions">
              <button class="icon-btn" title="Edit in the message box" aria-label="Edit suggestion" @click="suggestions?.use(nativeSuggestion.text)">
                <Icon name="edit" :size="14" />
              </button>
              <button v-if="!nativeSuggestionRisky" class="icon-btn" title="Send this message" aria-label="Send suggestion" @click="suggestions?.send(nativeSuggestion.text)">
                <Icon name="send" :size="14" />
              </button>
            </span>
          </template>
        </div>
        <div v-if="working" class="timeline-working" role="status" aria-label="Agent is working">
          <span
            class="spinner spinner-ticked"
            :style="elapsed ? { transform: `rotate(${turnSeconds * 90}deg)` } : undefined"
          ></span>
          <span v-if="elapsed" class="timeline-elapsed" aria-hidden="true">{{ elapsed }}</span>
          <span v-else>Working…</span>
        </div>
        <div v-if="!visibleRows.length" class="timeline-empty">
          <span v-if="!store.ready" class="spinner"></span>
          {{ store.ready ? "No messages yet." : timelineWait === "server" ? "Still connecting to LitePaseo…" : timelineWait === "network" ? "Connected, waiting for the network to deliver data…" : timelineWait === "loading" ? "Still loading this conversation…" : timelineWait === "host" ? `Waiting for ${hostLabel || "the host"} to load this conversation…` : "Loading conversation…" }}
        </div>
      </div>
    </div>
    <ChatOutline v-if="prefs.showChatOutline && outlinePrompts.length >= 2 && canHoverOutline" :prompts="outlinePrompts" :active-seq="activePromptSeq" @jump="jumpToPrompt" />
  </div>
</template>
