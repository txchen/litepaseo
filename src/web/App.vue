<script setup lang="ts">
import { computed, nextTick, onUnmounted, provide, reactive, ref, shallowRef, watch } from "vue";
import type { DirectoryMessage, HostState, Permission, TimelineMessage, TimelinePage, WorkspaceSummary } from "../shared/wire.ts";
import { DirectoryStore, comparePinnedFirst } from "./directory-store.ts";
import ThreadMenu from "./ThreadMenu.vue";
import RenameThread from "./RenameThread.vue";
import { ComposerStore } from "./composer-store.ts";
import { TimelineStore, type RowRef } from "./timeline-store.ts";
import { pageHistory, RENDER_WINDOW } from "./timeline-window.ts";
import { openStream, type StreamState } from "./event-stream.ts";
import SessionList from "./SessionList.vue";
import TimelineRowView from "./TimelineRowView.vue";
import NewSession from "./NewSession.vue";
import type { ProjectGroup } from "./directory-store.ts";
import AttachmentPanel from "./AttachmentPanel.vue";
import { AttachmentStore } from "./attachment-store.ts";
import PermissionForm from "./PermissionForm.vue";
import Icon from "./Icon.vue";
import { cycleTheme, theme } from "./theme.ts";
import Settings from "./Settings.vue";
import AgentBoard from "./AgentBoard.vue";
import UsagePanel, { type UsageReport } from "./UsagePanel.vue";
import { SUGGESTIONS } from "./suggestions.ts";
import type { AgentSummary } from "../shared/wire.ts";
import { registerServiceWorker, setBadge, setFavicon } from "./pwa.ts";
import { preloadMarkstream } from "./markstream-loader.ts";
import { formatElapsed } from "./elapsed.ts";
import AgentControls from "./AgentControls.vue";
import SchedulesPage from "./SchedulesPage.vue";
import { defineAsyncComponent } from "vue";
// The side panel loads on first use: the file viewer and xterm.js stay out of the first page.
const FilesPanel = defineAsyncComponent(() => import("./FilesPanel.vue"));
const FileViewer = defineAsyncComponent(() => import("./FileViewer.vue"));
const TerminalPanel = defineAsyncComponent(() => import("./TerminalPanel.vue"));
import DictationButton from "./DictationButton.vue";
import { TIMELINE_CONTEXT, turnFooters, type TimelineContext } from "./timeline-display.ts";

type Card = {
  id: string;
  title: string;
  column: string;
  hostId: string | null;
  agentId: string | null;
};
type Tab = "chat" | "board" | "hosts" | "settings" | "schedules";
const COLUMNS = ["Todo", "Doing", "Done"] as const;
const coarsePointer = matchMedia("(pointer: coarse)").matches;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const viewMenu = ref(false);
// Workspace side panel (files / terminal), remembered per browser.
const panel = ref<"files" | "terminal" | null>((localStorage.getItem("litepaseo-panel") as "files" | "terminal" | null) || null);
watch(panel, (p) => (p ? localStorage.setItem("litepaseo-panel", p) : localStorage.removeItem("litepaseo-panel")));
const togglePanel = (p: "files" | "terminal") => (panel.value = panel.value === p ? null : p);
// Files opened as tabs, per thread (kept while the page lives; at most a dozen per thread).
const fileTabs = reactive(new Map<string, { paths: string[]; active: string | null }>());
const tabOwner = computed(() => selectedThread.value ?? selectedKey.value ?? "");
const openFiles = computed(() => fileTabs.get(tabOwner.value)?.paths ?? []);
const activeFile = computed({
  get: () => fileTabs.get(tabOwner.value)?.active ?? null,
  set: (path: string | null) => {
    const entry = fileTabs.get(tabOwner.value);
    if (entry) entry.active = path;
  },
});
function openFile(path: string) {
  const owner = tabOwner.value;
  if (!owner) return;
  const entry = fileTabs.get(owner) ?? { paths: [], active: null };
  if (!entry.paths.includes(path)) entry.paths = [...entry.paths, path].slice(-12);
  entry.active = path;
  fileTabs.set(owner, entry);
  if (compact.matches) panel.value = null; // phones: show the file, not the tree on top of it
}
function closeFile(path: string) {
  const entry = fileTabs.get(tabOwner.value);
  if (!entry) return;
  const index = entry.paths.indexOf(path);
  entry.paths = entry.paths.filter((p) => p !== path);
  if (entry.active === path) entry.active = entry.paths[Math.min(index, entry.paths.length - 1)] ?? null;
}
const PANEL_MIN = 280, PANEL_MAX = 900, PANEL_DEFAULT = 420;
const clampPanel = (w: number) => Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, w)));
const panelWidth = ref(clampPanel(Number(localStorage.getItem("litepaseo-panel-width")) || PANEL_DEFAULT));
function setPanelWidth(w: number) {
  panelWidth.value = clampPanel(w);
  localStorage.setItem("litepaseo-panel-width", String(panelWidth.value));
}
function startPanelResize(event: PointerEvent) {
  if (event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  const startX = event.clientX, startW = panelWidth.value;
  handle.setPointerCapture(event.pointerId);
  resizing.value = true;
  const move = (e: PointerEvent) => (panelWidth.value = clampPanel(startW - (e.clientX - startX)));
  const end = () => {
    resizing.value = false;
    setPanelWidth(panelWidth.value);
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}
// Resizable sidebar (desktop): width persists per browser.
const SIDEBAR_MIN = 220,
  SIDEBAR_MAX = 520,
  SIDEBAR_DEFAULT = 300;
const clampSidebar = (w: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));
const sidebarWidth = ref(clampSidebar(Number(localStorage.getItem("litepaseo-sidebar-width")) || SIDEBAR_DEFAULT));
const resizing = ref(false);
function setSidebarWidth(w: number) {
  sidebarWidth.value = clampSidebar(w);
  localStorage.setItem("litepaseo-sidebar-width", String(sidebarWidth.value));
}
function startResize(event: PointerEvent) {
  if (event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  const startX = event.clientX,
    startW = sidebarWidth.value;
  handle.setPointerCapture(event.pointerId);
  resizing.value = true;
  let frame = 0;
  const move = (e: PointerEvent) => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => (sidebarWidth.value = clampSidebar(startW + e.clientX - startX)));
  };
  const end = () => {
    cancelAnimationFrame(frame);
    resizing.value = false;
    setSidebarWidth(sidebarWidth.value);
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}
function readJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
}

const token = ref(""),
  code = ref(""),
  /** null until the server says how this browser may sign in. */
  authInfo = ref<{ authenticated: boolean; totp: boolean } | null>(null),
  authenticated = ref(false),
  error = ref(""),
  busy = ref(false);
const hosts = shallowRef<HostState[]>([]),
  /** The sidebar: Paseo workspaces ("threads"), pinned first, then by last use. */
  directory = new DirectoryStore<WorkspaceSummary>({
    collapsed: readJson<string[]>("litepaseo-collapsed-projects", []),
    persist: (keys) => localStorage.setItem("litepaseo-collapsed-projects", JSON.stringify(keys)),
    compare: comparePinnedFirst,
  }),
  /** Agents: the board, the open conversation, notifications; indexed by their thread. */
  agentDirectory = new DirectoryStore<AgentSummary>({
    indexBy: (a) => (a.workspaceId ? `${a.hostId}:${a.workspaceId}` : null),
  }),
  /** The thread shown; the agent shown is `selectedKey`, one of the thread's agents. */
  selectedThread = ref<string | null>(null),
  listMode = ref<"projects" | "recent">(
    localStorage.getItem("litepaseo-list-mode") === "recent" ? "recent" : "projects",
  ),
  directoryState = ref<StreamState>("closed"),
  selectedKey = ref<string | null>(null),
  timeline = shallowRef(new TimelineStore()),
  timelineNotice = ref(""),
  historyRows = shallowRef<RowRef[] | null>(null),
  historyHasOlder = ref(false),
  historyNewer = ref<number[]>([]),
  timelineElement = ref<HTMLElement | null>(null),
  composerElement = ref<HTMLTextAreaElement | null>(null),
  query = ref(""),
  /** Compact layouts show either the list or the detail pane. */
  detailOpen = ref(false);
const label = ref(""),
  connection = ref(""),
  behavior = ref<"steer" | "interrupt">("steer"),
  tab = ref<Tab>("chat"),
  cardTitle = ref(""),
  board = ref<{ revision: number; cards: Card[] }>({ revision: 0, cards: [] });
const composer = new ComposerStore(() => localStorage);
const attachments = new AttachmentStore();
const attachmentPanel = ref<InstanceType<typeof AttachmentPanel> | null>(null);
const selectedAttachments = computed(() => selectedKey.value ? attachments.get(selectedKey.value) : []);
/** Short-lived composer messages (dictation, model switches): cleared after a while or on dismiss. */
const composerNotice = ref("");
let composerNoticeTimer: ReturnType<typeof setTimeout> | undefined;
function showComposerNotice(text: string) {
  composerNotice.value = text;
  clearTimeout(composerNoticeTimer);
  composerNoticeTimer = setTimeout(() => (composerNotice.value = ""), 8000);
}
/** Dictated text goes where the cursor is, with spacing that reads naturally. */
function insertDictation(text: string) {
  const el = composerElement.value;
  const current = prompt.value;
  const start = el && document.activeElement === el ? el.selectionStart : current.length;
  const end = el && document.activeElement === el ? el.selectionEnd : current.length;
  const before = current.slice(0, start), after = current.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  prompt.value = before + lead + text + after;
  void nextTick(() => {
    if (!el) return;
    el.focus();
    const at = (before + lead + text).length;
    el.setSelectionRange(at, at);
    autosize();
  });
}
const composerHasContent = computed(() => !!prompt.value.trim() || selectedAttachments.value.length > 0);
const dragging = ref(false);
function onComposerDragLeave(event: DragEvent) {
  const form = event.currentTarget as HTMLElement;
  if (!form.contains(event.relatedTarget as Node | null)) dragging.value = false;
}
const attachmentsReady = computed(() => selectedAttachments.value.every(e => !!e.id && !e.uploading && !e.error));
/** Pasted screenshots and files become attachments; plain text pastes stay text. */
function pasteFiles(event: ClipboardEvent) {
  const data = event.clipboardData;
  if (!data) return;
  let files = Array.from(data.files);
  if (!files.length)
    files = Array.from(data.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
  if (!files.length) return;
  event.preventDefault();
  void attachmentPanel.value?.addFiles(files);
}
const prompt = computed({
  get: () => selectedKey.value ? composer.state(selectedKey.value).text : "",
  set: (text: string) => { if (selectedKey.value) composer.setText(selectedKey.value, text); },
});
const uncertain = computed(() => selectedKey.value ? composer.unresolved(selectedKey.value)[0] ?? null : null);
const savedDrafts = computed(() => selectedKey.value
  ? composer.saved(selectedKey.value).filter(d => d.text !== prompt.value) : []);
const checkingDelivery = ref(false), deliveryNotice = ref("");
async function checkDelivery() {
  const agent = active.value;
  if (!agent || busy.value || checkingDelivery.value || document.hidden) return;
  const pending = composer.unresolved(agent.key);
  if (!pending.length) return;
  const generation = composer.generation;
  checkingDelivery.value = true;
  try {
    const result = await api(path(agent) + "/messages/status", "POST", { messageIds: pending.slice(0, 20).map(p => p.messageId) });
    if (generation !== composer.generation) return;
    for (const id of result.confirmed ?? []) {
      const message = pending.find(p => p.messageId === id);
      if (message) { attachments.consume(agent.key, message.attachmentIds ?? []); composer.confirm(agent.key, id); }
    }
    if (active.value?.key === agent.key) deliveryNotice.value = result.confirmed?.length ? "Delivery confirmed from conversation history." : "Not confirmed yet. No message has been resent.";
  } catch {
    if (active.value?.key === agent.key) deliveryNotice.value = "Unable to check delivery. Your message remains saved.";
  } finally { checkingDelivery.value = false; }
}
const deliveryTimer = setInterval(() => void checkDelivery(), 15_000);
watch([selectedKey, busy], () => { deliveryNotice.value = ""; void checkDelivery(); });
function acknowledgeMessage() {
  if (selectedKey.value && uncertain.value) composer.resolve(selectedKey.value, uncertain.value.messageId);
}
function onComposerStorage(event: StorageEvent) {
  if (event.storageArea !== localStorage) return;
  if (event.key === "litepaseo-composer-signout") composer.clear();
  else composer.onStorage(event.key, event.newValue); // O(1); ignores unrelated keys such as theme
}
window.addEventListener("storage", onComposerStorage);

const hostLabels = computed(() => new Map(hosts.value.map((h) => [h.id, h.label])));
const hostStates = computed(() => new Map(hosts.value.map((h) => [h.id, h.state])));
const connectedHosts = computed(() => hosts.value.filter((h) => h.state === "connected").length);
// O(1) per directory message: map lookups, not scans.
const active = computed(() => {
  agentDirectory.version.value;
  return agentDirectory.get(selectedKey.value) ?? null;
});
const activeThread = computed(() => {
  directory.version.value;
  return directory.get(selectedThread.value) ?? null;
});
/** The open thread's agents, most recent first (tabs when there is more than one). */
const threadAgents = computed(() => {
  agentDirectory.version.value;
  return agentDirectory.indexed(selectedThread.value, 12);
});
const sessionCount = computed(() => {
  directory.version.value;
  return directory.total;
});
const viewSize = computed(() => {
  directory.version.value;
  return directory.size;
});
const projectCount = computed(() => {
  directory.version.value;
  return directory.projectCount;
});
watch(listMode, (mode) => localStorage.setItem("litepaseo-list-mode", mode));

// Host scope for the sidebar. Each host keeps its own incrementally maintained view.
const hostFilter = ref<string | null>(localStorage.getItem("litepaseo-host-filter"));
watch(
  hostFilter,
  (id) => {
    directory.setHost(id);
    agentDirectory.setHost(id);
    if (id) localStorage.setItem("litepaseo-host-filter", id);
    else localStorage.removeItem("litepaseo-host-filter");
  },
  { immediate: true },
);
watch(hosts, (list) => {
  if (hostFilter.value && list.length && !list.some((h) => h.id === hostFilter.value))
    hostFilter.value = null;
});
const hostCounts = computed(() => {
  directory.version.value;
  return new Map(hosts.value.map((h) => [h.id, directory.hostSize(h.id)]));
});
/** The open thread's working directory: the workspace checkout, else the agent's cwd. */
const workspaceCwd = computed(() => activeThread.value?.directory || active.value?.cwd || "");
const activeProject = computed(() => {
  const cwd = active.value?.cwd ?? "";
  return cwd.replace(/\/+$/, "").split("/").pop() || cwd;
});
const running = computed(() => active.value?.status === "running");
/** Live-tail working indicator above the composer, like Paseo's in-chat spinner. */
const working = computed(() => !historyRows.value && active.value?.state === "running");
// A 1 s clock runs only while the open agent works and the page is visible.
const clockNow = ref(Date.now());
const turnStartedAt = computed(() => (working.value ? active.value?.turnStartedAt ?? null : null));
const elapsed = computed(() => (turnStartedAt.value ? formatElapsed(clockNow.value - turnStartedAt.value) : ""));
/** Whole seconds into the turn: the timer text and the spinner's quarter turns move together. */
const turnSeconds = computed(() => (turnStartedAt.value ? Math.max(0, Math.floor((clockNow.value - turnStartedAt.value) / 1000)) : 0));
let elapsedTimer: ReturnType<typeof setTimeout> | undefined;
function syncElapsedClock() {
  clearTimeout(elapsedTimer);
  elapsedTimer = undefined;
  const start = turnStartedAt.value;
  if (!start || document.hidden) return;
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
const visibleRows = computed(() => {
  if (historyRows.value) return historyRows.value;
  const store = timeline.value;
  store.membership.value;
  return store.rows.slice(-RENDER_WINDOW);
});
const markdownSettled = computed(() => directoryState.value === "live"
  && hostStates.value.get(active.value?.hostId ?? "") === "connected"
  && active.value?.turnActive === false);
// Finished turns get a footer (copy, completion time, duration), as in Paseo. Recomputed per
// timeline flush over the rendered window only (≤ RENDER_WINDOW rows).
const turnMeta = computed(() => {
  const rows = visibleRows.value.map((r) => r.row.value);
  const a = active.value;
  const lastFinished = (!!historyRows.value && historyNewer.value.length > 0) || (!!a && !(a.turnActive ?? a.state === "running"));
  return turnFooters(rows, lastFinished);
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
const timelineContext = shallowRef<TimelineContext>({ base: "", cwd: "" });
watch(active, (a) => {
  const base = a ? "/api" + path(a) : "";
  if (base !== timelineContext.value.base || (a?.cwd ?? "") !== timelineContext.value.cwd)
    timelineContext.value = { base, cwd: a?.cwd ?? "" };
}, { immediate: true });
provide(TIMELINE_CONTEXT, timelineContext);
/** Clicking an image in a message opens it full size. */
const lightbox = ref<string | null>(null);
function onTimelineClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target instanceof HTMLImageElement && target.closest(".prose")) lightbox.value = target.currentSrc || target.src;
}
const lastTimelineSeq = computed(() => {
  const store = timeline.value;
  store.membership.value;
  return store.rows.at(-1)?.seqStart;
});
const canShowOlder = computed(() => {
  if (historyRows.value) return historyHasOlder.value;
  const store = timeline.value;
  store.membership.value;
  return store.rows.length > RENDER_WINDOW || store.hasOlder;
});
const cardsByColumn = computed(() => {
  const map = new Map<string, Card[]>(COLUMNS.map((c) => [c, []]));
  for (const card of board.value.cards) map.get(card.column)?.push(card);
  return map;
});
const liveLabel = computed(() =>
  directoryState.value === "live"
    ? "Live"
    : directoryState.value === "paused"
      ? "Paused"
      : "Reconnecting",
);

let directoryStream: { close(): void } | null = null,
  timelineStream: { close(): void } | null = null,
  searchTimer: ReturnType<typeof setTimeout> | undefined;

async function api(path: string, method = "GET", body?: unknown, timeoutMs = 20000) {
  const response = await fetch("/api" + path, {
    method,
    // Cookie session; the custom header marks the request as same-origin script (CSRF guard).
    headers: { "Content-Type": "application/json", "x-litepaseo": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && authenticated.value && path !== "/login") signOut("ended");
  if (!response.ok) throw Object.assign(new Error((data.error ?? "Request failed") + (data.requestId ? ` (reference ${data.requestId})` : "")), { delivery: data.delivery });
  return data;
}
async function action(fn: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = String((e as Error).message);
  } finally {
    busy.value = false;
  }
}
function path(a: { hostId: string; id: string }) {
  return `/hosts/${encodeURIComponent(a.hostId)}/agents/${encodeURIComponent(a.id)}`;
}
/**
 * "user": the person chose to sign out (Settings) — drafts and staged files are erased here and
 * in other tabs, as expected on a shared computer. "ended": the session expired or was revoked
 * elsewhere — nothing the user wrote is erased; drafts and unconfirmed messages wait for sign-in.
 */
function signOut(reason: "user" | "ended") {
  authenticated.value = false;
  if (reason === "user") {
    composer.clear();
    attachments.clear();
    try { localStorage.setItem("litepaseo-composer-signout", crypto.randomUUID()); } catch {}
  } else {
    // Staged uploads belonged to the old session; keep the files and let them upload again.
    attachments.forgetRemote("Sign in again, then retry the upload.");
  }
  directoryStream?.close();
  timelineStream?.close();
  directoryStream = timelineStream = null;
  token.value = code.value = "";
  void loadAuth();
  error.value = reason === "ended" ? "Your session ended. Sign in again; your drafts are kept." : "";
}
async function loadAuth() {
  try { authInfo.value = await api("/auth"); }
  catch {
    authInfo.value = { authenticated: false, totp: false };
    return; // An unreachable server must not erase recoverable drafts.
  }
  // Not signed in (e.g. the session expired while the page was closed) is not a reason to erase
  // drafts: only an explicit sign-out does that.
  if (authInfo.value!.authenticated) await enter();
}
async function login() {
  await action(async () => {
    await api("/login", "POST", { token: token.value.trim(), ...(authInfo.value?.totp ? { code: code.value.trim() } : {}) });
    token.value = code.value = "";
    await enter();
  });
}
async function enter() {
  authenticated.value = true;
  error.value = "";
  board.value = await api("/board");
  openDirectory();
  void registerServiceWorker();
  preloadMarkstream();
  void loadUsage();
  clearInterval(usageTimer);
  usageTimer = setInterval(() => void loadUsage(), 5 * 60_000);
  // A notification tap opens /?session=<key>; select it once and clean the address.
  const wanted = new URLSearchParams(location.search).get("session");
  if (wanted) {
    history.replaceState(history.state, "", "/");
    select(wanted);
  }
}
function onCodeInput() {
  code.value = code.value.replace(/\D/g, "").slice(0, 6);
}
// The service worker asks an already-open app to show the tapped session.
navigator.serviceWorker?.addEventListener("message", (event) => {
  if (event.data?.type === "open-session" && authenticated.value) select(String(event.data.key));
});
function openDirectory() {
  directoryStream?.close();
  directoryStream = openStream({
    url: () =>
      `/api/stream?generation=${encodeURIComponent(agentDirectory.generation)}&since=${agentDirectory.seq}` +
      `&wgeneration=${encodeURIComponent(directory.generation)}&wsince=${directory.seq}`,
    onState: (state) => {
      directoryState.value = state;
      if (state === "unauthorized") signOut("ended");
    },
    onMessage: (data) => {
      const message = data as DirectoryMessage;
      if (message.type === "hosts") hosts.value = message.hosts;
      else if (message.type === "workspaces-snapshot")
        directory.applyCollection({ type: "snapshot", generation: message.generation, seq: message.seq, items: message.workspaces });
      else if (message.type === "workspaces-changes")
        directory.applyCollection({ type: "changes", generation: message.generation, seq: message.seq, changes: message.changes });
      else agentDirectory.apply(message);
    },
  });
}

// Search: the matching set is built once per query and then maintained incrementally.
watch(query, (text) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const needle = text.trim().toLowerCase();
    if (!needle) {
      directory.setFilter(null);
      agentDirectory.setFilter(null);
      return;
    }
    const labels = hostLabels.value;
    directory.setFilter((w) =>
      `${w.name}\n${w.project}\n${w.branch ?? ""}\n${w.directory}\n${labels.get(w.hostId) ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
    agentDirectory.setFilter((a) =>
      `${a.title ?? ""}\n${a.project}\n${a.cwd}\n${labels.get(a.hostId) ?? ""}\n${a.provider}`
        .toLowerCase()
        .includes(needle),
    );
  }, 120);
});

// Async Markdown nodes can acquire height after the SSE update's nextTick.
// Follow that layout only while the reader remains at the live tail.
let followLatest = true;
watch(timelineElement, (element, _previous, cleanup) => {
  const inner = element?.querySelector(".timeline-inner");
  if (!element || !inner) return;
  // Only the reader scrolling up leaves the tail. A programmatic scroll can land short of the
  // bottom when content grows before its scroll event is dispatched; that must not unfollow.
  let lastTop = element.scrollTop;
  const onScroll = () => {
    const top = element.scrollTop;
    if (nearBottom()) followLatest = true;
    else if (top < lastTop - 1) followLatest = false;
    lastTop = top;
  };
  const observer = new ResizeObserver(() => {
    if (!historyRows.value && followLatest) scrollToBottom();
  });
  element.addEventListener("scroll", onScroll, { passive: true });
  observer.observe(inner);
  // The viewport shrinks when the composer grows (attachments, multi-line drafts): keep the tail in view.
  observer.observe(element);
  cleanup(() => { observer.disconnect(); element.removeEventListener("scroll", onScroll); });
}, { flush: "post" });

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
/** Opens an agent (board, notification, a new session) and the thread it belongs to. */
function select(key: string) {
  tab.value = "chat";
  selectedKey.value = key;
  const agent = agentDirectory.get(key);
  selectedThread.value = agent?.workspaceId ? `${agent.hostId}:${agent.workspaceId}` : null;
  openDetail();
}
/** Opens a thread from the sidebar: its most recently used agent. */
function selectThread(key: string) {
  tab.value = "chat";
  selectedThread.value = key;
  selectedKey.value = agentDirectory.indexed(key, 1)[0]?.key ?? null;
  openDetail();
}
// An agent that arrives after its selection (new session, notification tap) finds its thread;
// a thread whose agent is not known yet picks one when it arrives.
watch(active, (a) => {
  if (a?.workspaceId && !selectedThread.value) selectedThread.value = `${a.hostId}:${a.workspaceId}`;
});
watch(threadAgents, (list) => {
  if (selectedThread.value && list.length && !list.some((a) => a.key === selectedKey.value))
    selectedKey.value = list[0].key;
});

// Compact layouts: the detail pane is a history entry, so the system back button or gesture
// returns to the list instead of leaving the app.
const compact = matchMedia("(max-width: 760px)");
function openDetail() {
  if (!detailOpen.value && compact.matches) history.pushState({ litepaseoDetail: true }, "");
  detailOpen.value = true;
}
function closeDetail() {
  if (history.state?.litepaseoDetail) history.back();
  else detailOpen.value = false;
}
function onPopState() {
  if (detailOpen.value && !history.state?.litepaseoDetail) detailOpen.value = false;
}
window.addEventListener("popstate", onPopState);

const searchInput = ref<HTMLInputElement | null>(null);
function onGlobalKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  if (event.key === "Escape" && lightbox.value) {
    lightbox.value = null;
    return;
  }
  if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
    event.preventDefault();
    if (detailOpen.value && compact.matches) closeDetail();
    searchInput.value?.focus();
    searchInput.value?.select();
  } else if (event.key === "n" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey && authenticated.value && !newSession.value) {
    event.preventDefault();
    startNew();
  } else if (event.key === "Escape" && target === searchInput.value && query.value) {
    query.value = "";
  }
}
window.addEventListener("keydown", onGlobalKey);

// New sessions: the dialog creates, the directory stream delivers, the selection opens it.
const newSession = ref<{
  hostId: string | null;
  cwd: string | null;
  project: { key: string | null; name: string } | null;
} | null>(null);
function startNew(group?: ProjectGroup<WorkspaceSummary>) {
  // Without a project, start where you worked last: the most recent thread in the current view.
  const recent = group ? group.items.at(0) : directory.range(0, 1)[0];
  newSession.value = {
    hostId: hostFilter.value ?? recent?.hostId ?? active.value?.hostId ?? null,
    cwd: recent?.rootPath ?? null,
    project: recent ? { key: recent.projectKey, name: recent.project } : null,
  };
}
function onCreated(key: string) {
  newSession.value = null;
  if (query.value) query.value = "";
  select(key);
}
const pendingSelection = computed(() => (!!selectedKey.value || !!selectedThread.value) && !active.value);

// Thread actions (rename, pin, unread/read, archive): the daemon operations Paseo's sidebar uses.
const menu = shallowRef<{ thread: WorkspaceSummary; x: number; y: number } | null>(null);
const renaming = shallowRef<WorkspaceSummary | null>(null);
function threadPath(w: { hostId: string; id: string }) {
  return `/hosts/${encodeURIComponent(w.hostId)}/workspaces/${encodeURIComponent(w.id)}`;
}
function openMenu(thread: WorkspaceSummary, x: number, y: number) {
  menu.value = { thread, x, y };
}
function openHeaderMenu(event: MouseEvent) {
  const thread = activeThread.value;
  if (!thread) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu(thread, rect.right - 200, rect.bottom + 6);
}
async function renameThread(title: string | null) {
  const thread = renaming.value;
  if (!thread) return;
  await action(async () => {
    await api(threadPath(thread) + "/title", "POST", { title });
    renaming.value = null;
  });
}
async function pinThread(thread: WorkspaceSummary, pinned: boolean) {
  await action(async () => void (await api(threadPath(thread) + "/pin", "POST", { pinned })));
}
async function markThreadUnread(thread: WorkspaceSummary) {
  await action(async () => {
    await api(threadPath(thread) + "/unread", "POST", {});
    // Leave it so viewing does not mark it read again right away.
    if (selectedThread.value === thread.key) {
      selectedThread.value = selectedKey.value = null;
      closeDetail();
    }
  });
}
async function markThreadRead(thread: WorkspaceSummary) {
  await action(async () => void (await api(threadPath(thread) + "/read", "POST", {})));
}
async function archiveThread(thread: WorkspaceSummary) {
  if (!confirm(`Archive “${thread.name}”? It leaves the sidebar; the host keeps its history.`)) return;
  await action(async () => {
    await api(threadPath(thread) + "/archive", "POST", {});
    if (selectedThread.value === thread.key) selectedThread.value = selectedKey.value = null;
  });
}
// Viewing an unread thread marks it read (the agent-level read happens below).
let threadReadSent = "";
watch(
  () => (activeThread.value?.unread && timeline.value.membership.value >= 0 && timeline.value.ready ? activeThread.value : null),
  (w) => {
    if (!w || document.hidden) return;
    const marker = `${w.key}@${w.activityAt}`;
    if (threadReadSent === marker) return;
    threadReadSent = marker;
    void api(threadPath(w) + "/read", "POST", {}).catch(() => (threadReadSent = ""));
  },
);

// Kanban: live agent lanes (default) or the hand-made plan.
const boardMode = ref<"agents" | "plan">(localStorage.getItem("litepaseo-board-mode") === "plan" ? "plan" : "agents");
watch(boardMode, (mode) => localStorage.setItem("litepaseo-board-mode", mode));
async function stopAgent(a: AgentSummary) {
  await action(async () => void (await api(path(a) + "/stop", "POST")));
}
async function markRead(a: AgentSummary) {
  await action(async () => void (await api(path(a) + "/read", "POST", {})));
}
async function archiveAgent(a: AgentSummary) {
  if (!confirm(`Archive “${a.title || "this session"}”? It leaves the board and sidebar; the host keeps its history.`)) return;
  await action(async () => void (await api(path(a) + "/archive", "POST", {})));
}

// Opening a finished-but-unseen conversation marks it read, as the official app does.
let readSent = "";
watch(
  () => (active.value && active.value.unread && timeline.value.membership.value >= 0 && timeline.value.ready ? active.value : null),
  (a) => {
    if (!a || document.hidden) return;
    const marker = `${a.key}@${a.activityAt}`;
    if (readSent === marker) return;
    readSent = marker;
    void api(path(a) + "/read", "POST", {}).catch(() => (readSent = ""));
  },
);

// next-input suggestions: rows ask through these; the newest ready one is the Tab completion.
const suggestion = ref<{ key: string; seqStart: number; text: string } | null>(null);
provide(SUGGESTIONS, {
  predict: (token) => {
    const a = active.value;
    if (!a) return Promise.resolve({ status: "expired", text: "" });
    return api(path(a) + "/suggestion", "POST", { token }, 65_000);
  },
  use: (text) => {
    prompt.value = text;
    void nextTick(() => {
      autosize();
      composerElement.value?.focus();
    });
  },
  send: (text) => void sendText(text),
  offer: (seqStart, text) => {
    const a = active.value;
    if (!a) return;
    if (!suggestion.value || suggestion.value.key !== a.key || seqStart >= suggestion.value.seqStart)
      suggestion.value = { key: a.key, seqStart, text };
  },
});
const composerSuggestion = computed(() =>
  suggestion.value && suggestion.value.key === active.value?.key && !prompt.value ? suggestion.value.text : "",
);
const composerPlaceholder = computed(() => {
  if (composerSuggestion.value && !coarsePointer) return composerSuggestion.value;
  if (!running.value) return "Message this agent…";
  return behavior.value === "steer" ? "Interject to steer the current turn" : "Interrupt and send a new message";
});

// Usage across hosts, read while the app is visible (the server caches each host for 5 min).
const usage = shallowRef<UsageReport | null>(null);
const usageLoading = ref(false);
let usageTimer: ReturnType<typeof setInterval> | undefined;
async function loadUsage(refresh = false) {
  if (!authenticated.value || document.hidden) return;
  usageLoading.value = true;
  try {
    usage.value = await api("/usage" + (refresh ? "?refresh=1" : ""));
  } catch {
    // keep the last report
  } finally {
    usageLoading.value = false;
  }
}
watch(selectedKey, () => {
  suggestion.value = null;
});
// The timeline stream follows the selected agent while it exists in the directory, so a
// just-created session opens when it arrives and an archived one releases its subscription.
watch(
  () => active.value?.key ?? null,
  (key) => {
  timelineStream?.close();
  timelineStream = null;
  const store = new TimelineStore();
  timeline.value = store;
  historyRows.value = null;
  historyNewer.value = [];
  timelineNotice.value = "";
  const agent = agentDirectory.get(key);
  if (!agent) return;
  timelineStream = openStream({
    url: () => "/api" + path(agent) + "/timeline/stream",
    onState: (state) => {
      if (state === "unauthorized") signOut("ended");
    },
    onMessage: (data) => {
      if (timeline.value !== store) return;
      const stick = !historyRows.value && (nearBottom() || !store.ready);
      const ops = (data as TimelineMessage).ops;
      const failure = ops.find((op) => op.type === "error");
      timelineNotice.value = failure?.type === "error" ? failure.message : "";
      const epoch = store.epoch;
      store.apply(ops);
      if (epoch && epoch !== store.epoch) {
        historyRows.value = null;
        historyNewer.value = [];
        scrollToBottom();
      }
      if (stick) scrollToBottom();
    },
  });
  },
);
function showLatest() {
  historyRows.value = null;
  historyNewer.value = [];
  scrollToBottom();
}
async function moveHistory(direction: "before" | "after") {
  const store = timeline.value;
  const el = timelineElement.value;
  const current = visibleRows.value.map(r => ({ seqStart: r.seqStart, row: shallowRef(r.row.value) }));
  const edge = direction === "before" ? current[0] : current.at(-1);
  const agent = active.value;
  if (!agent || !edge) return;
  const epoch = store.epoch;
  const rect = el?.getBoundingClientRect();
  const onScreen = el ? Array.from(el.querySelectorAll<HTMLElement>("[data-seq-start]"))
    .filter(row => row.getBoundingClientRect().bottom > rect!.top && row.getBoundingClientRect().top < rect!.bottom) : [];
  const anchor = direction === "before" ? onScreen[0] : onScreen.at(-1);
  const anchorSeq = anchor?.dataset.seqStart;
  const anchorTop = anchor?.getBoundingClientRect().top;
  // Forward navigation uses the previous page's stable seqStart boundary. An `after`
  // catch-up read can include old tool rows whose seqEnd changed much later.
  const boundary = direction === "before" ? edge.seqStart : historyNewer.value.at(-1);
  if (boundary === undefined) return;
  const cursor = { epoch, seq: boundary };
  await action(async () => {
    const page: TimelinePage = await api(path(agent) + "/timeline?cursor=" + encodeURIComponent(JSON.stringify(cursor)));
    if (timeline.value !== store || store.epoch !== epoch) return;
    if (page.epoch !== epoch) { showLatest(); return; }
    const window = pageHistory(current, page, direction);
    if (direction === "after" && !window.added) { showLatest(); return; }
    if (direction === "before" && window.added) historyNewer.value.push(current.at(-1)!.seqStart + 1);
    if (direction === "after") historyNewer.value.pop();
    historyRows.value = window.rows;
    historyHasOlder.value = window.hasOlder;
    await nextTick();
    const retained = el?.querySelector<HTMLElement>(`[data-seq-start="${anchorSeq}"]`);
    if (el && retained && anchorTop !== undefined) el.scrollTop += retained.getBoundingClientRect().top - anchorTop;
    else if (el) el.scrollTop = direction === "before" ? 0 : el.scrollHeight;
  });
}

function autosize() {
  const el = composerElement.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4)) + "px";
}
function onComposerKey(event: KeyboardEvent) {
  if (event.key === "Tab" && !event.shiftKey && composerSuggestion.value) {
    event.preventDefault();
    prompt.value = composerSuggestion.value;
    void nextTick(autosize);
    return;
  }
  if (event.key !== "Enter" || event.isComposing) return;
  // Desktop: Enter sends, Shift+Enter breaks. Touch keyboards keep Enter for new lines.
  if ((!coarsePointer && !event.shiftKey) || event.metaKey || event.ctrlKey) {
    event.preventDefault();
    void send();
  }
}
async function send() {
  await sendText(prompt.value, true);
}
async function sendText(text: string, fromComposer = false) {
  const a = active.value;
  if (!a || (!text.trim() && (!fromComposer || !selectedAttachments.value.length)) || uncertain.value || busy.value || (fromComposer && !attachmentsReady.value)) return;
  const state = composer.state(a.key);
  const generation = composer.generation;
  const selected = fromComposer ? [...selectedAttachments.value] : [];
  const sent = { text, messageId: crypto.randomUUID(),
    attachmentIds: selected.map(e => e.id!), attachmentNames: selected.map(e => e.file.name) };
  composer.begin(a.key, sent);
  if (fromComposer) composer.setText(a.key, "");
  await action(async () => {
    try {
      await api(path(a) + "/messages", "POST", { ...sent, behavior: behavior.value });
      if (generation !== composer.generation) return;
      composer.resolve(a.key, sent.messageId);
      attachments.consume(a.key, sent.attachmentIds);
      if (selectedKey.value === a.key) suggestion.value = null;
      void nextTick(autosize);
      if (selectedKey.value === a.key) showLatest();
    } catch (e) {
      if (generation !== composer.generation) return;
      if (fromComposer && !state.text) composer.restoreFailed(a.key, sent);
      if ((e as { delivery?: string }).delivery === "not-sent") {
        composer.resolve(a.key, sent.messageId);
        for (const entry of selected) entry.error = "Not sent. Retry the upload or remove this attachment.";
      }
      throw e;
    }
  });
}
async function stop() {
  const a = active.value;
  if (a) await action(async () => void (await api(path(a) + "/stop", "POST")));
}
async function respond(p: Permission, response: Record<string, unknown>) {
  const a = active.value;
  if (!a) return;
  await action(async () => {
    await api(path(a) + "/permissions/" + encodeURIComponent(p.id), "POST", response);
  });
}
async function addHost() {
  await action(async () => {
    await api("/hosts", "POST", { label: label.value, connection: connection.value });
    label.value = "";
    connection.value = "";
  });
}
async function removeHost(host: HostState) {
  if (!confirm(`Disconnect and remove ${host.label}? Its agents keep running on the host.`)) return;
  await action(async () => void (await api("/hosts/" + host.id, "DELETE")));
}
async function saveCards(cards: Card[]) {
  try {
    board.value = await api("/board", "PUT", { revision: board.value.revision, cards });
  } catch (e) {
    board.value = await api("/board");
    throw e;
  }
}
async function addCard() {
  await action(async () => {
    if (!cardTitle.value.trim()) return;
    await saveCards([
      ...board.value.cards,
      {
        id: crypto.randomUUID(),
        title: cardTitle.value,
        column: "Todo",
        hostId: active.value?.hostId ?? null,
        agentId: active.value?.id ?? null,
      },
    ]);
    cardTitle.value = "";
  });
}
async function moveCard(card: Card, column: string) {
  await action(() =>
    saveCards(board.value.cards.map((c) => (c.id === card.id ? { ...c, column } : c))),
  );
}
function openCard(card: Card) {
  if (card.hostId && card.agentId) select(`${card.hostId}:${card.agentId}`);
}
function openTab(next: Tab) {
  tab.value = next;
  if (next !== "chat" || selectedKey.value) openDetail();
  else closeDetail();
}

void loadAuth();
// Waiting sessions show on the app icon and in the tab title.
const waiting = computed(() => {
  directory.version.value;
  return agentDirectory.waiting;
});
watch(waiting, (count) => {
  setBadge(count);
  document.title = count ? `(${count}) LitePaseo` : "LitePaseo";
});
// The tab icon carries a status dot (Paseo's favicon states): needs you > working > unread.
const tabState = computed(() => {
  agentDirectory.version.value;
  if (agentDirectory.waiting) return "attention";
  if (agentDirectory.allLaneSize("running")) return "running";
  if (agentDirectory.allLaneSize("review")) return "unread";
  return "";
});
watch(tabState, (state) => setFavicon(state), { immediate: true });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void loadUsage();
});
onUnmounted(() => {
  clearInterval(usageTimer);
  clearInterval(deliveryTimer);
  clearTimeout(elapsedTimer);
  document.removeEventListener("visibilitychange", syncElapsedClock);
  attachments.clear();
  window.removeEventListener("storage", onComposerStorage);
  window.removeEventListener("popstate", onPopState);
  window.removeEventListener("keydown", onGlobalKey);
  directoryStream?.close();
  timelineStream?.close();
  clearTimeout(searchTimer);
});
</script>

<template>
  <div v-if="!authenticated" class="login">
    <form v-if="authInfo" class="login-card" @submit.prevent="login">
      <div class="brand brand-large"><img class="brand-mark" src="/icons/mark.svg" alt="" width="22" height="22" />LitePaseo</div>
      <p class="login-lede">All your Paseo hosts, one fast console.</p>
      <label class="field">
        <span>Server access token</span>
        <input v-model="token" type="password" autocomplete="off" required autofocus />
      </label>
      <p class="hint">Run <code>litepaseo token</code> on the server to print it.</p>
      <template v-if="authInfo.totp">
        <label class="field">
          <span>Authenticator code</span>
          <input v-model="code" class="code-input" inputmode="numeric"
            autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}"
            placeholder="••••••" required @input="onCodeInput" />
        </label>
        <p class="hint">Both your access token and a code from your authenticator app are required.</p>
      </template>
      <button class="btn btn-primary btn-block" :disabled="busy">{{ busy ? "Signing in…" : "Connect" }}</button>
      <p v-if="error" class="form-error">{{ error }}</p>
    </form>
  </div>

  <div
    v-else
    class="shell"
    :class="{ 'detail-open': detailOpen, 'is-resizing': resizing }"
    :style="{ '--sidebar-w': sidebarWidth + 'px' }"
  >
    <aside class="sidebar">
      <div
        class="sidebar-resize"
        :class="{ 'is-dragging': resizing }"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        :aria-valuenow="sidebarWidth"
        :aria-valuemin="SIDEBAR_MIN"
        :aria-valuemax="SIDEBAR_MAX"
        tabindex="0"
        title="Drag to resize · double-click to reset"
        @pointerdown="startResize"
        @dblclick="setSidebarWidth(SIDEBAR_DEFAULT)"
        @keydown.left.prevent="setSidebarWidth(sidebarWidth - 16)"
        @keydown.right.prevent="setSidebarWidth(sidebarWidth + 16)"
      ></div>
      <!-- Compact navigation, as in Paseo: search and the few pages, then the workspace list. -->
      <nav class="side-nav" aria-label="Pages">
        <label class="side-row side-search" :class="{ active: !!query }">
          <Icon name="search" :size="15" />
          <input
            ref="searchInput"
            v-model="query"
            type="search"
            placeholder="Search"
            aria-label="Search sessions, projects, hosts"
            aria-keyshortcuts="/ Control+K Meta+K"
          />
          <kbd class="hide-sm">{{ isMac ? "⌘K" : "Ctrl K" }}</kbd>
        </label>
        <button class="side-row" :class="{ chosen: tab === 'board' }" @click="openTab('board')">
          <Icon name="board" :size="15" />Kanban
        </button>
      </nav>
      <div class="side-section">
        <span class="side-label">{{ listMode === "projects" ? "Workspaces" : "Recent" }}</span>
        <span class="list-summary">{{ listMode === "projects" ? projectCount : viewSize }}</span>
        <button
          class="icon-btn side-tool"
          :class="{ chosen: viewMenu || hostFilter !== null || listMode !== 'projects' }"
          aria-label="View options"
          title="Group and filter"
          :aria-expanded="viewMenu"
          @click="viewMenu = !viewMenu"
        >
          <Icon name="sliders" :size="15" />
        </button>
      </div>
      <div v-if="viewMenu" class="view-menu">
        <div class="segmented segmented-sm" role="radiogroup" aria-label="Group sessions">
          <button role="radio" :aria-checked="listMode === 'projects'" :class="{ chosen: listMode === 'projects' }" @click="listMode = 'projects'">
            By project
          </button>
          <button role="radio" :aria-checked="listMode === 'recent'" :class="{ chosen: listMode === 'recent' }" @click="listMode = 'recent'">Recent</button>
        </div>
        <div v-if="hosts.length > 1" class="host-filter" role="radiogroup" aria-label="Filter by host">
          <button role="radio" :aria-checked="hostFilter === null" :class="{ chosen: hostFilter === null }" @click="hostFilter = null">
            All<span class="chip-count">{{ sessionCount }}</span>
          </button>
          <button
            v-for="h in hosts"
            :key="h.id"
            role="radio"
            :aria-checked="hostFilter === h.id"
            :class="{ chosen: hostFilter === h.id }"
            :title="h.label + ' · ' + h.state"
            @click="hostFilter = h.id"
          >
            <span class="status-dot" :class="h.state === 'connected' ? 'is-idle-ok' : 'is-offline'"></span
            >{{ h.label }}<span class="chip-count">{{ hostCounts.get(h.id) }}</span>
          </button>
        </div>
      </div>
      <SessionList
        :mode="listMode"
        :store="directory"
        :host-labels="hostLabels"
        :host-states="hostStates"
        :selected-key="selectedThread"
        :searching="!!query.trim()"
        @select="selectThread"
        @new="startNew"
        @menu="openMenu"
      />
      <UsagePanel :report="usage" :loading="usageLoading" @refresh="loadUsage(true)" />
      <div class="side-foot">
        <span class="live" :class="'is-' + directoryState" :title="'Directory stream: ' + directoryState">
          <span class="live-dot"></span>{{ liveLabel }}
        </span>
        <button
          class="icon-btn"
          :class="{ chosen: tab === 'schedules' }"
          title="Schedules"
          aria-label="Schedules"
          @click="openTab('schedules')"
        >
          <Icon name="clock" :size="15" />
        </button>
        <button
          class="icon-btn foot-hosts"
          :class="{ chosen: tab === 'hosts' }"
          :title="`Hosts: ${connectedHosts} of ${hosts.length} connected`"
          :aria-label="`Hosts, ${connectedHosts} of ${hosts.length} connected`"
          @click="openTab('hosts')"
        >
          <Icon name="server" :size="15" />
          <span v-if="connectedHosts < hosts.length" class="foot-alert" aria-hidden="true"></span>
        </button>
        <button
          class="icon-btn"
          :title="'Theme: ' + theme + ' (click to change)'"
          :aria-label="'Theme: ' + theme"
          @click="cycleTheme"
        >
          <Icon :name="theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor'" :size="15" />
        </button>
        <button class="icon-btn" :class="{ chosen: tab === 'settings' }" title="Settings" aria-label="Settings" @click="openTab('settings')">
          <Icon name="gear" :size="15" />
        </button>
      </div>
    </aside>

    <main class="main">
      <div v-if="error" class="toast" role="alert">
        <Icon name="alert" :size="15" /><span>{{ error }}</span
        ><button class="icon-btn" aria-label="Dismiss" @click="error = ''">
          <Icon name="close" :size="14" />
        </button>
      </div>

      <!-- Hosts -->
      <Settings
        v-if="tab === 'settings'"
        :request="api"
        :totp-enabled="!!authInfo?.totp"
        @back="closeDetail"
        @signed-out="signOut('user')"
        @totp-changed="(on) => authInfo && (authInfo.totp = on)"
      />

      <section v-else-if="tab === 'hosts'" class="page">
        <header class="page-head">
          <button class="icon-btn back" aria-label="Back" @click="closeDetail">
            <Icon name="back" :size="18" />
          </button>
          <div>
            <h1>Hosts</h1>
            <p class="subtle">Paseo daemons this console connects to. Secrets stay on this server.</p>
          </div>
        </header>
        <div class="page-body">
          <div class="card">
            <div v-for="h in hosts" :key="h.id" class="card-row">
              <span class="status-dot" :class="h.state === 'connected' ? 'is-idle-ok' : 'is-offline'"></span>
              <div class="grow">
                <div class="row-title">{{ h.label }}</div>
                <div class="row-sub">{{ h.state }}</div>
                <p v-if="h.diagnostic?.error" role="status">{{ h.diagnostic.error.message }}</p>
                <div v-if="h.diagnostic?.lastConnectedAt" class="row-sub">Last connected: {{ new Date(h.diagnostic.lastConnectedAt).toLocaleString() }}</div>
                <div v-if="h.diagnostic?.attempt" class="row-sub">Connection attempt {{ h.diagnostic.attempt }}</div>
                <div v-if="h.diagnostic?.nextRetryAt" class="row-sub">Next retry: {{ new Date(h.diagnostic.nextRetryAt).toLocaleString() }}</div>
              </div>
              <button class="btn btn-outline" :disabled="busy" @click="removeHost(h)">Remove</button>
            </div>
            <div v-if="!hosts.length" class="card-row muted-text">No hosts yet.</div>
          </div>
          <h2 class="section-label">Add a host</h2>
          <form class="card form-card" @submit.prevent="addHost">
            <label class="field">
              <span>Name</span>
              <input v-model="label" placeholder="Build server" required />
            </label>
            <label class="field">
              <span>Connection</span>
              <input
                v-model="connection"
                type="password"
                placeholder="ws://host:port/ws, pairing offer or SSH target"
                required
                autocomplete="off"
                aria-describedby="host-connection-help"
              />
            </label>
            <div id="host-connection-help" class="field-help">
              <p>
                The LitePaseo server connects to the daemon, so the address must be reachable from the
                server, not from this browser. The default daemon port is <code>6767</code>.
              </p>
              <details>
                <summary>Connection formats</summary>
                <dl>
                  <dt>Same machine</dt>
                  <dd><code>6767</code> or <code>127.0.0.1:6767</code></dd>
                  <dt>Network address</dt>
                  <dd><code>192.168.1.10:6767</code>, <code>tcp://host:6767</code>, <code>ws://host:6767/ws</code> or <code>wss://host/ws</code></dd>
                  <dt>Daemon password</dt>
                  <dd><code>ws://host:6767/ws?password=…</code></dd>
                  <dt>SSH tunnel</dt>
                  <dd>
                    <code>ssh://user@host</code> or <code>ssh://user@host:2222?daemonPort=6767</code>. Key-based login
                    only: the server's user must be able to run <code>ssh user@host</code> without a prompt.
                  </dd>
                  <dt>Pairing / relay</dt>
                  <dd>Paste a pairing link from Paseo (containing <code>#connect=</code>) or a <code>relay://</code> URL.</dd>
                  <dt>Local socket</dt>
                  <dd><code>unix:///path/to/socket</code></dd>
                </dl>
              </details>
            </div>
            <div class="form-actions">
              <button class="btn btn-primary" :disabled="busy">Add host</button>
            </div>
          </form>
        </div>
      </section>

      <!-- Kanban -->
      <SchedulesPage v-else-if="tab === 'schedules'" :hosts="hosts" :api="api" @back="closeDetail" @open-agent="select" />

      <section v-else-if="tab === 'board'" class="page">
        <header class="page-head">
          <button class="icon-btn back" aria-label="Back" @click="closeDetail">
            <Icon name="back" :size="18" />
          </button>
          <div>
            <h1>Kanban</h1>
            <p class="subtle">
              {{
                boardMode === "agents"
                  ? "Every agent by state, live. Follows the host filter and search."
                  : "Your own plan. Moving a card never changes an agent."
              }}
            </p>
          </div>
          <div class="segmented head-toggle" role="radiogroup" aria-label="Board">
            <button :class="{ chosen: boardMode === 'agents' }" @click="boardMode = 'agents'">Agents</button>
            <button :class="{ chosen: boardMode === 'plan' }" @click="boardMode = 'plan'">Plan</button>
          </div>
        </header>
        <div class="page-body wide">
          <AgentBoard
            v-if="boardMode === 'agents'"
            :store="agentDirectory"
            :host-labels="hostLabels"
            :busy="busy"
            @open="select"
            @stop="stopAgent"
            @read="markRead"
            @archive="archiveAgent"
          />
          <template v-else>
          <form class="add-card" @submit.prevent="addCard">
            <input v-model="cardTitle" placeholder="New task" required />
            <button class="btn btn-primary" :disabled="busy"><Icon name="plus" :size="15" />Add task</button>
          </form>
          <p v-if="active" class="subtle small">New tasks link to “{{ active.title || active.id }}”.</p>
          <div class="board">
            <div v-for="column in COLUMNS" :key="column" class="column">
              <div class="column-head">
                <h3>{{ column }}</h3>
                <span class="count">{{ cardsByColumn.get(column)!.length }}</span>
              </div>
              <article v-for="card in cardsByColumn.get(column)" :key="card.id" class="card kanban-card">
                <div class="row-title">{{ card.title }}</div>
                <button v-if="card.agentId" class="link-btn" @click="openCard(card)">
                  <Icon name="chat" :size="13" />Open conversation
                </button>
                <div class="kanban-actions">
                  <select :value="card.column" @change="moveCard(card, ($event.target as HTMLSelectElement).value)">
                    <option v-for="c in COLUMNS" :key="c">{{ c }}</option>
                  </select>
                  <button
                    class="icon-btn"
                    aria-label="Remove"
                    @click="action(() => saveCards(board.cards.filter((c) => c.id !== card.id)))"
                  >
                    <Icon name="trash" :size="15" />
                  </button>
                </div>
              </article>
              <p v-if="!cardsByColumn.get(column)!.length" class="column-empty">Nothing here</p>
            </div>
          </div>
          </template>
        </div>
      </section>

      <!-- Conversation -->
      <div v-else-if="active" class="chat-split" :style="{ '--panel-w': panelWidth + 'px' }">
      <section class="chat">
        <header class="chat-head">
          <button class="icon-btn back" aria-label="Back to sessions" @click="closeDetail">
            <Icon name="back" :size="18" />
          </button>
          <span class="status-dot chat-status" :class="'is-' + (active.attention ? 'attention' : active.state === 'failed' ? 'error' : active.state === 'running' ? 'running' : 'idle')" :title="active.status"></span>
          <h1 class="chat-title" :title="activeThread?.name || active.title || ''">
            <Icon v-if="activeThread?.pinnedAt" name="pin" :size="12" class="title-pin" />{{ activeThread?.name || active.title || "Untitled session" }}
          </h1>
          <span
            class="chat-context hide-sm"
            :title="[activeProject, hostLabels.get(active.hostId), activeThread?.branch, active.provider].filter(Boolean).join(' · ')"
          >{{ activeProject }}<template v-if="hosts.length > 1"> · {{ hostLabels.get(active.hostId) }}</template><template v-if="activeThread?.branch"> · {{ activeThread.branch }}</template></span>
          <span class="grow"></span>
          <button
            class="icon-btn head-tool"
            :class="{ chosen: panel === 'files' }"
            aria-label="Files"
            title="Files"
            @click="togglePanel('files')"
          >
            <Icon name="folder" :size="16" />
          </button>
          <button
            class="icon-btn head-tool"
            :class="{ chosen: panel === 'terminal' }"
            aria-label="Terminal"
            title="Terminal"
            @click="togglePanel('terminal')"
          >
            <Icon name="terminal" :size="16" />
          </button>
          <button
            v-if="activeThread"
            class="icon-btn head-tool"
            aria-label="Thread actions"
            title="Rename, pin, mark unread, archive"
            @click="openHeaderMenu"
          >
            <Icon name="more" :size="16" />
          </button>
        </header>
        <!-- Tabs: the thread's agents, then files opened from the side panel (Paseo's workspace tabs). -->
        <nav v-if="threadAgents.length > 1 || openFiles.length" class="agent-tabs" aria-label="Tabs">
          <button
            v-for="a in threadAgents.length ? threadAgents : [active]"
            :key="a.key"
            :class="{ chosen: a.key === selectedKey && !activeFile }"
            @click="selectedKey = a.key; activeFile = null"
          >
            <span class="status-dot" :class="'is-' + (a.attention ? 'attention' : a.state === 'failed' ? 'error' : a.state === 'running' ? 'running' : a.unread ? 'unread' : 'idle')"></span>
            <span class="agent-tab-name">{{ a.title || a.provider }}</span>
          </button>
          <button
            v-for="f in openFiles"
            :key="'file:' + f"
            class="file-tab"
            :class="{ chosen: activeFile === f }"
            :title="f"
            @click="activeFile = f"
            @auxclick.prevent="$event.button === 1 && closeFile(f)"
          >
            <Icon name="file" :size="13" />
            <span class="agent-tab-name">{{ f.split("/").pop() }}</span>
            <span class="tab-close" role="button" :aria-label="'Close ' + f" @click.stop="closeFile(f)"><Icon name="close" :size="11" /></span>
          </button>
        </nav>
        <FileViewer
          v-if="activeFile"
          :key="active.hostId + ':' + workspaceCwd + ':' + activeFile"
          :host-id="active.hostId"
          :cwd="workspaceCwd"
          :path="activeFile"
          :api="api"
        />

        <div v-show="!activeFile" ref="timelineElement" class="timeline" @click="onTimelineClick">
          <div class="timeline-inner">
            <div v-if="canShowOlder" class="older">
              <button class="btn btn-ghost" :disabled="busy" @click="moveHistory('before')">Show earlier messages</button>
            </div>
            <p v-if="timelineNotice" class="notice"><Icon name="alert" :size="14" />{{ timelineNotice }}</p>
            <template v-for="r in visibleRows" :key="`${active?.key}:${timeline.epoch}:${r.seqStart}`">
              <TimelineRowView :entry="r.row" :final="r.seqStart !== lastTimelineSeq || markdownSettled" :data-seq-start="r.seqStart" />
              <div v-if="turnMeta.get(r.seqStart)" class="turn-footer">
                <button
                  v-if="turnMeta.get(r.seqStart)!.messages.length"
                  type="button"
                  class="icon-btn"
                  :aria-label="copiedTurn === r.seqStart ? 'Copied' : 'Copy turn'"
                  :title="copiedTurn === r.seqStart ? 'Copied' : 'Copy turn'"
                  @click="copyTurn(r.seqStart, turnMeta.get(r.seqStart)!.messages)"
                >
                  <Icon :name="copiedTurn === r.seqStart ? 'check' : 'copy'" :size="14" />
                </button>
                <span>{{ turnMeta.get(r.seqStart)!.at }}</span>
                <span v-if="turnMeta.get(r.seqStart)!.took">Worked for {{ turnMeta.get(r.seqStart)!.took }}</span>
              </div>
            </template>
            <div v-if="historyRows" class="older">
              <button v-if="historyNewer.length" class="btn btn-ghost" :disabled="busy" @click="moveHistory('after')">Show newer messages</button>
              <button class="btn btn-ghost" :disabled="busy" @click="showLatest">Back to latest</button>
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
              <span v-if="!timeline.ready" class="spinner"></span>
              {{ timeline.ready ? "No messages yet." : "Loading conversation…" }}
            </div>
          </div>
        </div>

        <div v-show="!activeFile" class="dock">
          <div class="dock-inner">
            <PermissionForm v-for="p in active.pendingPermissions" :key="active.key + ':' + p.id" :permission="p" :busy="busy" @respond="respond(p, $event)" />

            <p v-if="deliveryNotice" role="status">{{ deliveryNotice }}</p>
            <p v-if="composer.warning.value" role="status">{{ composer.warning.value }}</p>
            <p v-if="composerNotice" class="composer-notice" role="status">
              <Icon name="alert" :size="13" />{{ composerNotice }}
              <button type="button" class="icon-btn" aria-label="Dismiss" @click="composerNotice = ''"><Icon name="close" :size="12" /></button>
            </p>
            <details v-if="savedDrafts.length">
              <summary>Other saved drafts ({{ savedDrafts.length }})</summary>
              <div v-for="draft in savedDrafts" :key="draft.slot">
                <p style="white-space: pre-wrap">{{ draft.text }}</p>
                <button class="btn btn-ghost" @click="selectedKey && composer.restore(selectedKey, draft.slot)">Restore draft</button>
              </div>
            </details>
            <div v-if="uncertain && !busy" class="uncertain">
              <Icon name="alert" :size="15" />
              <span class="grow">Delivery unknown. Check the conversation before sending again. Message: {{ uncertain.text }} {{ uncertain.attachmentNames?.join(", ") }}</span>
              <button class="btn btn-ghost" :disabled="checkingDelivery" @click="checkDelivery">{{ checkingDelivery ? "Checking…" : "Check delivery" }}</button>
              <button class="btn btn-ghost" @click="acknowledgeMessage">I checked</button>
            </div>

            <form
              class="composer"
              :class="{ 'is-dragging': dragging }"
              @submit.prevent="send"
              @dragover.prevent="dragging = true"
              @dragleave="onComposerDragLeave"
              @drop.prevent="dragging = false; attachmentPanel?.addFiles($event.dataTransfer?.files)"
              @paste="pasteFiles"
            >
              <AttachmentPanel ref="attachmentPanel" :store="attachments" :agent-key="active.key" :base="'/api' + path(active)" :busy="busy || !!uncertain" />
              <textarea
                ref="composerElement"
                v-model="prompt"
                rows="1"
                :placeholder="composerPlaceholder"
                :required="!selectedAttachments.length"
                @input="autosize"
                @keydown="onComposerKey"
              ></textarea>
              <div class="composer-bar">
                <button
                  type="button"
                  class="composer-tool"
                  aria-label="Attach files"
                  :title="attachmentPanel?.hint"
                  :disabled="busy || !!uncertain || !attachmentPanel?.available"
                  @click="attachmentPanel?.pick()"
                >
                  <Icon name="plus" :size="18" />
                </button>
                <AgentControls
                  :agent="active"
                  :path="path(active)"
                  :api="api"
                  :disabled="busy || hostStates.get(active.hostId) !== 'connected'"
                  @notice="showComposerNotice"
                />
                <div class="composer-actions">
                  <button
                    v-if="running"
                    type="button"
                    class="chip-behavior"
                    :class="'is-' + behavior"
                    :aria-label="behavior === 'steer' ? 'Steer: your message joins the running turn (click for interrupt)' : 'Interrupt: your message stops the running turn (click for steer)'"
                    :title="behavior === 'steer' ? 'Steer: your message joins the running turn' : 'Interrupt: your message stops the running turn and starts a new one'"
                    @click="behavior = behavior === 'steer' ? 'interrupt' : 'steer'"
                  >
                    {{ behavior === "steer" ? "Steer" : "Interrupt" }}
                  </button>
                  <DictationButton
                    :host-id="active.hostId"
                    :disabled="busy || hostStates.get(active.hostId) !== 'connected'"
                    @text="insertDictation"
                    @notice="showComposerNotice"
                  />
                  <button
                    v-if="running"
                    type="button"
                    class="disc disc-stop"
                    :class="{ 'is-primary': !composerHasContent }"
                    aria-label="Stop turn"
                    title="Stop turn"
                    :disabled="busy"
                    @click="stop"
                  >
                    <Icon name="stop" :size="18" />
                  </button>
                  <button
                    v-if="!running || composerHasContent"
                    class="disc disc-send"
                    aria-label="Send"
                    title="Send (Enter) · Shift+Enter for a new line"
                    :disabled="busy || !!uncertain || !attachmentsReady || !composerHasContent"
                  >
                    <Icon name="send" :size="17" />
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </section>
      <aside v-if="panel" class="side-panel" :aria-label="panel === 'files' ? 'Files' : 'Terminal'">
        <div
          class="panel-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          tabindex="0"
          @pointerdown="startPanelResize"
          @dblclick="setPanelWidth(PANEL_DEFAULT)"
        ></div>
        <div class="panel-tabs">
          <button :class="{ chosen: panel === 'files' }" @click="panel = 'files'"><Icon name="folder" :size="14" />Files</button>
          <button :class="{ chosen: panel === 'terminal' }" @click="panel = 'terminal'"><Icon name="terminal" :size="14" />Terminal</button>
          <span class="grow"></span>
          <button class="icon-btn" aria-label="Close panel" title="Close panel" @click="panel = null"><Icon name="close" :size="14" /></button>
        </div>
        <div class="panel-body">
          <KeepAlive>
            <FilesPanel
              v-if="panel === 'files'"
              :key="'f:' + active.hostId + workspaceCwd"
              :host-id="active.hostId"
              :cwd="workspaceCwd"
              :api="api"
              :active-path="activeFile"
              @open="openFile"
            />
            <TerminalPanel v-else :key="'t:' + active.hostId + workspaceCwd" :host-id="active.hostId" :cwd="workspaceCwd" :api="api" />
          </KeepAlive>
        </div>
      </aside>
      </div>

      <section v-else-if="tab === 'chat' && pendingSelection" class="empty">
        <span class="spinner"></span>
        <p>Starting session…</p>
      </section>

      <section v-else class="empty">
        <div class="empty-mark"><Icon name="chat" :size="26" /></div>
        <h2>{{ sessionCount ? "Pick a session" : "Connect your first host" }}</h2>
        <p>
          {{
            sessionCount
              ? hostFilter
                ? `${viewSize} sessions in ${projectCount} projects on ${hostLabels.get(hostFilter) ?? "this host"}.`
                : `${sessionCount} sessions in ${projectCount} projects across ${hosts.length} hosts.`
              : "Add a Paseo daemon and its agents show up here, live."
          }}
        </p>
        <button v-if="!hosts.length" class="btn btn-primary" @click="openTab('hosts')">Add a host</button>
        <button v-else class="btn btn-primary" @click="startNew()"><Icon name="plus" :size="15" />New session</button>
      </section>
    </main>
    <ThreadMenu
      v-if="menu"
      :thread="menu.thread"
      :x="menu.x"
      :y="menu.y"
      @close="menu = null"
      @rename="(t) => (renaming = t)"
      @pin="pinThread"
      @unread="markThreadUnread"
      @read="markThreadRead"
      @archive="archiveThread"
    />
    <div v-if="lightbox" class="lightbox" role="dialog" aria-label="Image" @click="lightbox = null">
      <img :src="lightbox" alt="" />
    </div>
    <RenameThread v-if="renaming" :thread="renaming" :busy="busy" @close="renaming = null" @save="renameThread" />
    <NewSession
      v-if="newSession"
      :hosts="hosts"
      :initial-host-id="newSession.hostId"
      :initial-cwd="newSession.cwd"
      :initial-project="newSession.project"
      :request="api"
      @close="newSession = null"
      @created="onCreated"
    />
  </div>
</template>
