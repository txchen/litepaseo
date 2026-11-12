<script setup lang="ts">
import { computed, nextTick, onUnmounted, provide, reactive, ref, shallowRef, watch } from "vue";
import type { DirectoryMessage, HostState, Permission, TimelineMessage, TimelinePage, WorkspaceSummary } from "../shared/wire.ts";
import { DirectoryStore, comparePinnedFirst } from "./directory-store.ts";
import ThreadMenu from "./ThreadMenu.vue";
import RenameThread from "./RenameThread.vue";
import { ComposerStore } from "./composer-store.ts";
import { TimelineStore, type RowRef } from "./timeline-store.ts";
import { PAGE_STEP, pageHistory, RENDER_WINDOW } from "./timeline-window.ts";
import ChatOutline from "./ChatOutline.vue";
import { openStream, type StreamState } from "./event-stream.ts";
import SessionList from "./SessionList.vue";
import TimelineRowView from "./TimelineRowView.vue";
import NewSession from "./NewSession.vue";
import type { ProjectGroup } from "./directory-store.ts";
import AttachmentPanel from "./AttachmentPanel.vue";
import { AttachmentStore, type LocalAttachment } from "./attachment-store.ts";
import { SendQueue, type QueuedMessage } from "./send-queue.ts";
import PermissionForm from "./PermissionForm.vue";
import Icon from "./Icon.vue";
import { cycleTheme, theme } from "./theme.ts";
import Settings from "./Settings.vue";
import AgentBoard from "./AgentBoard.vue";
import UsagePanel, { type UsageReport } from "./UsagePanel.vue";
import { SUGGESTIONS } from "./suggestions.ts";
import type { AgentSummary, BoardCard, CardPatch, PromptIndex, PromptMarker, RewindMode, TimelineRow } from "../shared/wire.ts";
import TaskDialog from "./TaskDialog.vue";
import { registerServiceWorker, setBadge, setFavicon } from "./pwa.ts";
import { preloadMarkstream } from "./markstream-loader.ts";
import { formatElapsed } from "./elapsed.ts";
import AgentControls from "./AgentControls.vue";
import ProviderIcon from "./ProviderIcon.vue";
import SchedulesPage from "./SchedulesPage.vue";
import { defineAsyncComponent } from "vue";
// The side panel loads on first use: the file viewer and xterm.js stay out of the first page.
const FilesPanel = defineAsyncComponent(() => import("./FilesPanel.vue"));
const FileViewer = defineAsyncComponent(() => import("./FileViewer.vue"));
const TerminalPanel = defineAsyncComponent(() => import("./TerminalPanel.vue"));
import DictationButton from "./DictationButton.vue";
import { TIMELINE_CONTEXT, turnFooters, type TimelineContext } from "./timeline-display.ts";

type Card = BoardCard;
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
  /** A history page being fetched while the reader scrolls; paging never blocks the composer. */
  paging = ref<"before" | "after" | null>(null),
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
  /** The conversation a new task links to: chosen explicitly, none by default. */
  cardLink = ref(""),
  board = ref<{ revision: number; cards: Card[] }>({ revision: 0, cards: [] });
const composer = new ComposerStore(() => localStorage);
const attachments = new AttachmentStore();
const sendQueue = new SendQueue();
const queued = computed(() => selectedKey.value ? sendQueue.get(selectedKey.value) : []);
// Queued messages live only in this tab: warn before closing it with some still waiting.
window.addEventListener("beforeunload", (event) => {
  if (sendQueue.size) event.preventDefault();
});
const attachmentPanel = ref<InstanceType<typeof AttachmentPanel> | null>(null);
const agentControls = ref<InstanceType<typeof AgentControls> | null>(null);
/** Model name for turn footers: the open agent's current model, as the composer chip names it. */
const footerModel = computed(() => {
  const label = agentControls.value?.modelLabel;
  return label && label !== "Model" ? label : "";
});
const selectedAttachments = computed(() => selectedKey.value ? attachments.get(selectedKey.value) : []);
/** Voice input shows only once a transcription service is set up in Settings. */
const dictationReady = ref(false);
const dictationPreview = ref("");
const dictationPreviewElement = ref<HTMLDivElement | null>(null);
watch(dictationPreview, () => {
  const el = dictationPreviewElement.value;
  if (el) el.scrollTop = el.scrollHeight;
}, { flush: "post" });
async function loadDictation() {
  try { dictationReady.value = !!(await api("/dictation")).configured; } catch { /* keep the last answer */ }
}
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
/** A rewind in flight (one at a time); the timeline is replaced when it lands. */
const rewinding = ref(false);
async function rewindTo(messageId: string, text: string, mode: RewindMode) {
  const a = active.value;
  if (!a || rewinding.value) return;
  rewinding.value = true;
  error.value = "";
  try {
    await api(path(a) + "/rewind", "POST", { messageId, mode }, 120_000);
    // As in Paseo: the rewound prompt comes back to an empty composer, ready to edit and resend.
    if (mode !== "files" && selectedKey.value === a.key && !prompt.value.trim()) {
      prompt.value = text;
      void nextTick(autosize);
    }
    if (selectedKey.value === a.key)
      showComposerNotice(mode === "files" ? "Files rewound." : mode === "both" ? "Conversation and files rewound." : "Conversation rewound.");
  } catch (e) {
    error.value = String((e as Error).message);
  } finally {
    rewinding.value = false;
  }
}
const timelineContext = shallowRef<TimelineContext>({ base: "", cwd: "" });
watch(active, (a) => {
  const base = a ? "/api" + path(a) : "";
  const modes = a?.rewind ?? [];
  const current = timelineContext.value;
  if (base !== current.base || (a?.cwd ?? "") !== current.cwd || modes.join() !== (current.rewindModes ?? []).join())
    timelineContext.value = { base, cwd: a?.cwd ?? "", rewindModes: modes, rewinding, rewind: (id, text, mode) => void rewindTo(id, text, mode) };
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
    for (const key of sendQueue.keys()) for (const m of sendQueue.get(key)) discardQueued(key, m);
    sendQueue.clear();
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
  void loadDictation();
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
    // Pages load ahead of the reader in the direction they scroll; our own anchor
    // corrections after a page swap are not reader intent.
    scheduleActivePrompt();
    if (performance.now() >= pagingQuietUntil) {
      if (top < lastTop - 1) pagingIntent = "up";
      else if (top > lastTop + 1) pagingIntent = "down";
      autoPage();
    }
    lastTop = top;
  };
  const observer = new ResizeObserver(() => {
    if (!historyRows.value && followLatest) scrollToBottom();
  });
  // At either end of a window there is nothing left to scroll, so no scroll event: the wheel
  // still says which way the reader wants to go.
  const onWheel = (event: WheelEvent) => {
    if (performance.now() < pagingQuietUntil || !event.deltaY) return;
    pagingIntent = event.deltaY < 0 ? "up" : "down";
    autoPage();
  };
  element.addEventListener("scroll", onScroll, { passive: true });
  element.addEventListener("wheel", onWheel, { passive: true });
  observer.observe(inner);
  // The viewport shrinks when the composer grows (attachments, multi-line drafts): keep the tail in view.
  observer.observe(element);
  cleanup(() => {
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
  pagingQuietUntil = 0;
function autoPage() {
  const el = timelineElement.value;
  if (!el || paging.value || !pagingIntent || el.offsetParent === null) return;
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
  pagingQuietUntil = performance.now() + 150;
  el.scrollTop += retained.getBoundingClientRect().top - anchor!.top;
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
  return behavior.value === "steer" ? "Queue a message for when this turn ends" : "Interrupt and send a new message";
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
      if (store.epoch && store.epoch !== promptEpoch) void loadPrompts(agent, store);
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
function fetchHistoryPage(agent: AgentSummary, epoch: string, seq: number): Promise<TimelinePage> {
  return api(path(agent) + "/timeline?cursor=" + encodeURIComponent(JSON.stringify({ epoch, seq })));
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
async function newerRows(agent: AgentSummary, store: TimelineStore, epoch: string, last: number): Promise<RowRef[] | null | "stale"> {
  const found: RowRef[] = [];
  // Set once the server has nothing between the window and the live store's first row.
  let reachedStore = false;
  for (let request = 0; request < 8 && found.length < PAGE_STEP; ) {
    const after = found.at(-1)?.seqStart ?? last;
    const top = historyNewer.value.at(-1);
    if (top === undefined) {
      const rows = store.rows;
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
      const far = await fetchHistoryPage(agent, epoch, stack[index]);
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
    let page = await fetchHistoryPage(agent, epoch, top);
    if (page.epoch !== epoch) return "stale";
    let newer = page.rows.filter((r) => r.seqStart > after), consumed = true;
    // Not known to start right after the window: look below the page; anything found there
    // comes first, and this cursor stays on the stack for the rest.
    while (!exactCursors.has(top) && newer.length && page.hasOlder && !page.rows.some((r) => r.seqStart <= after) && request < 8) {
      request++;
      const near = newer[0].seqStart;
      const probe = await fetchHistoryPage(agent, epoch, near);
      if (probe.epoch !== epoch) return "stale";
      const between = probe.rows.filter((r) => r.seqStart > after && r.seqStart < near);
      if (!between.length) break;
      page = probe;
      newer = between;
      consumed = false;
    }
    const room = PAGE_STEP - found.length;
    if (!newer.length && top === store.rows[0]?.seqStart) reachedStore = true;
    // The cursor is spent only when its page fits; otherwise the rest comes from it next time.
    if (consumed && newer.length <= room) historyNewer.value.pop();
    found.push(...newer.slice(0, room).map((row) => ({ seqStart: row.seqStart, row: shallowRef(row) })));
    if (!consumed) break;
  }
  return found.length ? found : null;
}
async function moveHistory(direction: "before" | "after") {
  const store = timeline.value;
  const el = timelineElement.value;
  const current = visibleRows.value.slice();
  // Rows paged back into history are a snapshot; rows continued from the live store stay live.
  if (direction === "before") current.forEach((r, i) => (current[i] = { seqStart: r.seqStart, row: shallowRef(r.row.value) }));
  const edge = direction === "before" ? current[0] : current.at(-1);
  const agent = active.value;
  if (!agent || !edge || paging.value) return;
  const epoch = store.epoch;
  paging.value = direction;
  try {
    const stillHere = () => timeline.value === store && store.epoch === epoch && active.value?.key === agent.key;
    if (direction === "before") {
      const page = await fetchHistoryPage(agent, epoch, edge.seqStart);
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
      const added = await newerRows(agent, store, epoch, edge.seqStart);
      if (!stillHere()) return;
      if (added === "stale") return showLatest();
      const tail = store.rows.at(-1)?.seqStart;
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
    error.value = String((e as Error).message);
    pagingIntent = null; // no retry loop on failure; the next scroll tries again
  } finally {
    paging.value = null;
  }
  // Still near the edge (a fast fling, short rows): keep going in the same direction.
  void nextTick(autoPage);
}

// ---- Outline rail: the conversation's prompts, with hover previews and jump-to ---------------
const canHoverOutline = matchMedia("(hover: hover) and (pointer: fine)").matches;
/** The daemon's prompt index for the open conversation (whole history, not just loaded rows). */
const promptIndex = shallowRef<{ key: string; prompts: PromptMarker[] } | null>(null);
let promptEpoch = "";
async function loadPrompts(agent: AgentSummary, store: TimelineStore) {
  promptEpoch = store.epoch;
  try {
    const index: PromptIndex = await api(path(agent) + "/timeline/prompts");
    if (timeline.value === store && index.epoch === store.epoch) promptIndex.value = { key: agent.key, prompts: index.prompts };
  } catch {
    // Older daemon: the rail falls back to the prompts already loaded.
    if (timeline.value === store) promptIndex.value = { key: agent.key, prompts: [] };
  }
}
watch(() => active.value?.key, () => {
  promptIndex.value = null;
  promptEpoch = "";
  exactCursors.clear();
});
const previewOf = (row: TimelineRow) => String(row.item.text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
/** Indexed prompts plus any sent since the index was read (from the live store). */
const outlinePrompts = computed<PromptMarker[]>(() => {
  const store = timeline.value;
  store.membership.value;
  const index = promptIndex.value?.key === active.value?.key ? promptIndex.value?.prompts ?? [] : [];
  const lastIndexed = index.at(-1)?.seq ?? -1;
  const live: PromptMarker[] = [];
  for (const r of store.rows)
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
    ?? Array.from(el?.querySelectorAll<HTMLElement>("[data-seq-start]") ?? []).find((r) => Number(r.dataset.seqStart) >= seq);
  if (!el || !row) return;
  pagingQuietUntil = performance.now() + 250;
  followLatest = false;
  el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
  scheduleActivePrompt();
}
/**
 * Jumps to a prompt: in place when rendered, from the live store when it holds the prompt, else
 * from the server (the prompt's turn, up to the next prompt). Later prompts become the forward
 * cursors, so scrolling down from there pages through the turns in order.
 */
async function jumpToPrompt(seq: number) {
  const agent = active.value;
  const store = timeline.value;
  if (!agent || paging.value) return;
  if (timelineElement.value?.querySelector(`[data-seq-start="${seq}"]`)) return revealRow(seq);
  const rows = store.rows;
  const local = rows.length && rows[0].seqStart <= seq ? rows.findIndex((r) => r.seqStart >= seq) : -1;
  if (local >= 0) {
    const start = local;
    historyNewer.value = [];
    if (start >= rows.length - RENDER_WINDOW) historyRows.value = null;
    else {
      historyRows.value = rows.slice(start, start + RENDER_WINDOW);
      historyHasOlder.value = start > 0 || store.hasOlder;
    }
    await nextTick();
    return revealRow(seq);
  }
  const epoch = store.epoch;
  const later = outlinePrompts.value.map((p) => p.seq).filter((s) => s > seq && (!rows.length || s < rows[0].seqStart));
  paging.value = "before";
  try {
    let cursor = later[0] ?? rows[0]?.seqStart ?? Number.MAX_SAFE_INTEGER;
    let collected: TimelineRow[] = [], hasOlder = false;
    // A turn longer than a page: keep reading back until the prompt itself is in hand.
    for (let request = 0; request < 8; request++) {
      const page = await fetchHistoryPage(agent, epoch, cursor);
      if (timeline.value !== store || active.value?.key !== agent.key) return;
      if (page.epoch !== epoch) return showLatest();
      collected = [...page.rows, ...collected];
      hasOlder = page.hasOlder;
      if (!page.rows.length || page.rows[0].seqStart <= seq || !page.hasOlder) break;
      cursor = page.rows[0].seqStart;
    }
    const at = Math.max(0, collected.findIndex((r) => r.seqStart >= seq));
    const start = at; // the prompt opens the window; earlier rows load as the reader scrolls up
    let jumped: RowRef[] = collected.slice(start, start + RENDER_WINDOW).map((row) => ({ seqStart: row.seqStart, row: shallowRef(row) }));
    historyNewer.value = [...later].reverse();
    exactCursors.clear();
    skipAhead = 4;
    // A short turn: fill the window from the following turns, so there is something to scroll.
    if (jumped.length && jumped.length <= RENDER_WINDOW - PAGE_STEP) {
      const more = await newerRows(agent, store, epoch, jumped.at(-1)!.seqStart);
      if (timeline.value !== store || active.value?.key !== agent.key) return;
      if (more === "stale") return showLatest();
      if (more) jumped = [...jumped, ...more];
    }
    historyRows.value = jumped;
    historyHasOlder.value = hasOlder || start > 0;
    await nextTick();
    revealRow(seq);
    // Read ahead: the next turns are where the reader goes from a jump.
    pagingIntent = "down";
    setTimeout(autoPage, 300);
  } catch (e) {
    error.value = String((e as Error).message);
  } finally {
    paging.value = null;
  }
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
/** No turn in flight: the moment a queued message may go. */
function turnIdle(a: AgentSummary) {
  return a.turnActive === false || (a.turnActive === undefined && a.status !== "running" && a.status !== "initializing");
}
async function sendText(text: string, fromComposer = false) {
  const a = active.value;
  if (!a || (!text.trim() && (!fromComposer || !selectedAttachments.value.length)) || uncertain.value || busy.value || (fromComposer && !attachmentsReady.value)) return;
  // Queue mode: while a turn runs the message waits above the composer instead of entering
  // the conversation; it goes when the turn ends, or at once if the reader chooses to interrupt.
  if (behavior.value === "steer" && !turnIdle(a)) {
    sendQueue.add(a.key, { id: crypto.randomUUID(), text, attachments: fromComposer ? attachments.detach(a.key) : [] });
    if (fromComposer) composer.setText(a.key, "");
    if (selectedKey.value === a.key) suggestion.value = null;
    void nextTick(autosize);
    return;
  }
  const selected = fromComposer ? [...selectedAttachments.value] : [];
  if (fromComposer) composer.setText(a.key, "");
  await deliver(a, text, selected, behavior.value, { restore: fromComposer });
}
/**
 * Sends one message. On failure the text returns to an empty composer. A refused queued message
 * goes back to the head of its queue, paused, and is never resent automatically; an unknown
 * outcome stays with the delivery check instead, so nothing is sent twice.
 */
async function deliver(a: AgentSummary, text: string, selected: LocalAttachment[], mode: "steer" | "interrupt",
  { restore, requeue }: { restore: boolean; requeue?: QueuedMessage }) {
  const state = composer.state(a.key);
  const generation = composer.generation;
  const sent = { text, messageId: crypto.randomUUID(),
    attachmentIds: selected.map(e => e.id!), attachmentNames: selected.map(e => e.file.name) };
  composer.begin(a.key, sent);
  let delivered = false;
  await action(async () => {
    try {
      await api(path(a) + "/messages", "POST", { ...sent, behavior: mode });
      delivered = true;
      if (generation !== composer.generation) return;
      composer.resolve(a.key, sent.messageId);
      for (const entry of selected) attachments.remove(a.key, entry, true);
      if (selectedKey.value === a.key) suggestion.value = null;
      void nextTick(autosize);
      if (selectedKey.value === a.key) showLatest();
    } catch (e) {
      if (generation !== composer.generation) return;
      const notSent = (e as { delivery?: string }).delivery === "not-sent";
      if (notSent) {
        composer.resolve(a.key, sent.messageId);
        for (const entry of selected) entry.error = "Not sent. Retry the upload or remove this attachment.";
        if (requeue) {
          sendQueue.unshift(a.key, { ...requeue, error: String((e as Error).message) });
          throw e;
        }
      }
      if ((restore || requeue) && !state.text) {
        composer.restoreFailed(a.key, sent);
        if (requeue) attachments.reattach(a.key, selected);
      }
      throw e;
    }
  });
  return delivered;
}
/** Removes a queued message for good, releasing its staged uploads. */
function discardQueued(key: string, m: QueuedMessage) {
  for (const entry of m.attachments) attachments.remove(key, entry);
}
function removeQueued(m: QueuedMessage) {
  const key = selectedKey.value;
  if (key && sendQueue.take(key, m.id)) discardQueued(key, m);
}
/** Back into the composer for changes; appended below any text already there. */
function editQueued(m: QueuedMessage) {
  const key = selectedKey.value;
  if (!key || !sendQueue.take(key, m.id)) return;
  prompt.value = prompt.value.trim() ? prompt.value.trimEnd() + "\n\n" + m.text : m.text;
  attachments.reattach(key, m.attachments);
  void nextTick(() => {
    autosize();
    composerElement.value?.focus();
  });
}
/** Sends a queued message now, interrupting the running turn. */
async function interruptWith(m: QueuedMessage) {
  const a = active.value;
  if (!a || busy.value || uncertain.value || !sendQueue.take(a.key, m.id)) return;
  await deliver(a, m.text, m.attachments, "interrupt", { restore: false, requeue: m });
}
// Dispatch: when an agent's turn ends, its next queued message goes, one per turn. After a send
// the agent may still look idle until the directory reports the new turn; wait for that (or a
// timeout) before sending the next, so two queued messages never go into the same gap.
const dispatching = new Set<string>(), awaitingTurn = new Map<string, number>();
let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
const TURN_START_WAIT_MS = 15_000;
function dispatchQueues() {
  clearTimeout(dispatchTimer);
  if (!authenticated.value || busy.value) return;
  for (const key of sendQueue.keys()) {
    const a = agentDirectory.get(key);
    if (!a || dispatching.has(key)) continue;
    const idle = turnIdle(a);
    const waitUntil = awaitingTurn.get(key);
    if (waitUntil !== undefined) {
      if (!idle || Date.now() >= waitUntil) awaitingTurn.delete(key);
      else { dispatchTimer = setTimeout(dispatchQueues, waitUntil - Date.now() + 50); continue; }
    }
    if (!idle || hostStates.value.get(a.hostId) !== "connected" || composer.unresolved(key).length) continue;
    const next = sendQueue.next(key);
    if (!next || !sendQueue.take(key, next.id)) continue;
    dispatching.add(key);
    void deliver(a, next.text, next.attachments, "steer", { restore: false, requeue: next }).then((ok) => {
      if (ok) awaitingTurn.set(key, Date.now() + TURN_START_WAIT_MS);
    }).finally(() => {
      dispatching.delete(key);
      dispatchQueues();
    });
    return; // one at a time: `busy` is shared by the whole page
  }
}
watch(() => {
  agentDirectory.version.value;
  composer.revision.value;
  return [sendQueue.size, busy.value, hostStates.value];
}, dispatchQueues);

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
/** "<host>:<agent>" → the card's link fields; "" → no link. */
function linkFields(key: string): Pick<Card, "hostId" | "agentId"> {
  const agent = agentDirectory.get(key);
  return agent ? { hostId: agent.hostId, agentId: agent.id } : { hostId: null, agentId: null };
}
async function addCard() {
  await action(async () => {
    if (!cardTitle.value.trim()) return;
    await saveCards([
      ...board.value.cards,
      { id: crypto.randomUUID(), title: cardTitle.value.trim(), column: "Todo", ...linkFields(cardLink.value), createdAt: Date.now() },
    ]);
    cardTitle.value = "";
    cardLink.value = "";
  });
}
/** One card's change, applied by the server to the board as it is now (no lost updates). */
async function patchCard(card: Card, change: CardPatch) {
  await action(async () => {
    board.value = await api(`/board/cards/${encodeURIComponent(card.id)}`, "PATCH", change);
  });
}
async function linkCard(card: Card, key: string) {
  const fields = linkFields(key);
  await patchCard(card, { link: fields.hostId && fields.agentId ? { hostId: fields.hostId, agentId: fields.agentId } : null });
}
async function commentCard(card: Card, text: string) {
  await action(async () => {
    board.value = await api(`/board/cards/${encodeURIComponent(card.id)}/comments`, "POST", { text });
  });
}
async function uncommentCard(card: Card, id: string) {
  await action(async () => {
    board.value = await api(`/board/cards/${encodeURIComponent(card.id)}/comments/${encodeURIComponent(id)}`, "DELETE");
  });
}
function confirmRemove(card: Card) {
  if (!card.description && !card.comments?.length) return void removeCard(card);
  if (confirm(`Delete “${card.title}”? Its description and comments are deleted too.`)) void removeCard(card);
}
async function removeCard(card: Card) {
  await action(() => saveCards(board.value.cards.filter((c) => c.id !== card.id)));
  if (openTaskId.value === card.id) openTaskId.value = null;
}
/** The task open in the detail dialog. */
const openTaskId = ref<string | null>(null);
const openTask = computed(() => board.value.cards.find((c) => c.id === openTaskId.value) ?? null);
/** A line of the description for the board card, without Markdown punctuation. */
function cardExcerpt(card: Card) {
  return (card.description ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]()|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}
/** Conversations a task can link to: the open one first, then the most recent. */
const linkChoices = computed(() => {
  agentDirectory.version.value;
  const recent = agentDirectory.range(0, 30);
  const open = active.value;
  const list = open ? [open, ...recent.filter((a) => a.key !== open.key)] : recent;
  const many = hosts.value.length > 1;
  return list.map((a) => ({
    key: a.key,
    label: (a.title || `${a.provider} · ${a.project}`) + (many ? ` (${hostLabels.value.get(a.hostId) ?? a.hostId})` : ""),
  }));
});
/** The linked conversation of a card, or null when it is not in the directory (archived, host gone). */
function cardAgent(card: Card) {
  agentDirectory.version.value;
  return card.hostId && card.agentId ? agentDirectory.get(`${card.hostId}:${card.agentId}`) ?? null : null;
}
async function moveCard(card: Card, column: string) {
  await patchCard(card, { column });
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
        @dictation-changed="(on) => (dictationReady = on)"
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
            <select v-model="cardLink" class="card-link-select" aria-label="Link to conversation">
              <option value="">No conversation</option>
              <option v-for="c in linkChoices" :key="c.key" :value="c.key">{{ c.label }}</option>
            </select>
            <button class="btn btn-primary" :disabled="busy"><Icon name="plus" :size="15" />Add task</button>
          </form>
          <div class="board">
            <div v-for="column in COLUMNS" :key="column" class="column">
              <div class="column-head">
                <h3>{{ column }}</h3>
                <span class="count">{{ cardsByColumn.get(column)!.length }}</span>
              </div>
              <article v-for="card in cardsByColumn.get(column)" :key="card.id" class="card kanban-card">
                <button type="button" class="kanban-open" :aria-label="'Open task ' + card.title" @click="openTaskId = card.id">
                  <span class="row-title">{{ card.title }}</span>
                  <span v-if="cardExcerpt(card)" class="kanban-excerpt">{{ cardExcerpt(card) }}</span>
                </button>
                <div v-if="card.agentId" class="card-link">
                  <button v-if="cardAgent(card)" class="link-btn" :title="'Open ' + (cardAgent(card)!.title || cardAgent(card)!.id)" @click="openCard(card)">
                    <Icon name="chat" :size="13" /><span class="card-link-name">{{ cardAgent(card)!.title || cardAgent(card)!.provider }}</span>
                  </button>
                  <span v-else class="subtle small">Conversation unavailable</span>
                  <button class="icon-btn" aria-label="Unlink conversation" title="Unlink conversation" :disabled="busy" @click="linkCard(card, '')">
                    <Icon name="close" :size="13" />
                  </button>
                </div>
                <select v-else class="card-link-select" aria-label="Link to conversation" :disabled="busy" value=""
                  @change="linkCard(card, ($event.target as HTMLSelectElement).value)">
                  <option value="" disabled>Link a conversation…</option>
                  <option v-for="c in linkChoices" :key="c.key" :value="c.key">{{ c.label }}</option>
                </select>
                <div class="kanban-actions">
                  <select :value="card.column" aria-label="Column" @change="moveCard(card, ($event.target as HTMLSelectElement).value)">
                    <option v-for="c in COLUMNS" :key="c">{{ c }}</option>
                  </select>
                  <button v-if="card.comments?.length" type="button" class="kanban-count" :title="card.comments.length + ' comments'" @click="openTaskId = card.id">
                    <Icon name="chat" :size="13" />{{ card.comments.length }}
                  </button>
                  <button type="button" class="icon-btn" aria-label="Edit task" title="Edit" @click="openTaskId = card.id">
                    <Icon name="edit" :size="15" />
                  </button>
                  <button
                    class="icon-btn"
                    aria-label="Remove"
                    @click="confirmRemove(card)"
                  >
                    <Icon name="trash" :size="15" />
                  </button>
                </div>
              </article>
              <p v-if="!cardsByColumn.get(column)!.length" class="column-empty">Nothing here</p>
            </div>
          </div>
          <TaskDialog
            v-if="openTask"
            :key="openTask.id"
            :card="openTask"
            :columns="COLUMNS"
            :links="linkChoices"
            :linked-name="cardAgent(openTask) ? cardAgent(openTask)!.title || cardAgent(openTask)!.provider : null"
            :busy="busy"
            @close="openTaskId = null"
            @patch="patchCard(openTask, $event)"
            @comment="commentCard(openTask, $event)"
            @uncomment="uncommentCard(openTask, $event)"
            @remove="removeCard(openTask)"
            @open="openTaskId = null; openCard(openTask)"
          />
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

        <div v-show="!activeFile" class="timeline-wrap">
        <div ref="timelineElement" class="timeline" @click="onTimelineClick">
          <div class="timeline-inner">
            <div v-if="canShowOlder" class="older">
              <span v-if="paging === 'before'" class="older-loading" role="status"><span class="spinner"></span>Loading earlier messages…</span>
              <!-- Scrolling up loads automatically; the button covers a window too short to scroll. -->
              <button v-else class="btn btn-ghost" @click="moveHistory('before')">Show earlier messages</button>
            </div>
            <p v-if="timelineNotice" class="notice"><Icon name="alert" :size="14" />{{ timelineNotice }}</p>
            <template v-for="r in visibleRows" :key="`${active?.key}:${timeline.epoch}:${r.seqStart}`">
              <TimelineRowView :entry="r.row" :final="r.seqStart !== lastTimelineSeq || markdownSettled" :data-seq-start="r.seqStart" />
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
                <span v-if="footerModel && r.row.value.provider === active.provider" class="turn-item" :title="'Model: ' + footerModel">
                  <ProviderIcon :provider="r.row.value.provider" />{{ footerModel }}
                </span>
                <span class="turn-item" :title="'Finished ' + turnMeta.get(r.seqStart)!.at"><Icon name="clock" :size="14" />{{ turnMeta.get(r.seqStart)!.at }}</span>
                <span v-if="turnMeta.get(r.seqStart)!.took" class="turn-item" :title="'Worked for ' + turnMeta.get(r.seqStart)!.took">
                  <Icon name="hourglass" :size="14" />{{ turnMeta.get(r.seqStart)!.took }}
                </span>
              </div>
            </template>
            <div v-if="historyRows" class="older">
              <span v-if="paging === 'after'" class="older-loading" role="status"><span class="spinner"></span>Loading newer messages…</span>
              <button v-else class="btn btn-ghost" @click="showLatest">Back to latest</button>
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
        <ChatOutline v-if="outlinePrompts.length >= 2 && canHoverOutline" :prompts="outlinePrompts" :active-seq="activePromptSeq" @jump="jumpToPrompt" />
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

            <div v-if="queued.length" class="send-queue" role="list" aria-label="Queued messages">
              <div v-for="m in queued" :key="m.id" class="queue-item" :class="{ 'is-error': m.error }" role="listitem">
                <Icon :name="m.error ? 'alert' : 'clock'" :size="14" class="queue-icon" />
                <div class="queue-body">
                  <span class="queue-text" :title="m.text">{{ m.text || "(attachments only)" }}</span>
                  <span v-if="m.attachments.length" class="queue-meta">{{ m.attachments.map(e => e.file.name).join(", ") }}</span>
                  <span v-if="m.error" class="queue-meta queue-error">{{ m.error }}</span>
                </div>
                <button type="button" class="queue-send" :disabled="busy || !!uncertain"
                  :title="running ? 'Send now: stops the running turn' : 'Send now'" @click="interruptWith(m)">
                  {{ running ? "Interrupt" : "Send" }}
                </button>
                <button type="button" class="icon-btn" aria-label="Edit queued message" title="Edit" @click="editQueued(m)"><Icon name="edit" :size="14" /></button>
                <button type="button" class="icon-btn" aria-label="Remove queued message" title="Remove" @click="removeQueued(m)"><Icon name="close" :size="14" /></button>
              </div>
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
              <div v-if="dictationPreview" ref="dictationPreviewElement" class="dictation-preview" role="status" aria-live="polite">{{ dictationPreview }}</div>
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
                  ref="agentControls"
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
                    :aria-label="behavior === 'steer' ? 'Queue: your message waits until the running turn ends (click for interrupt)' : 'Interrupt: your message stops the running turn (click for queue)'"
                    :title="behavior === 'steer' ? 'Queue: your message waits above the composer and is sent when the running turn ends' : 'Interrupt: your message stops the running turn and starts a new one'"
                    @click="behavior = behavior === 'steer' ? 'interrupt' : 'steer'"
                  >
                    {{ behavior === "steer" ? "Queue" : "Interrupt" }}
                  </button>
                  <DictationButton
                    v-if="dictationReady"
                    :key="active.key"
                    :disabled="busy"
                    @text="insertDictation"
                    @preview="dictationPreview = $event"
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
