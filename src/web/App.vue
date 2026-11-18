<script setup lang="ts">
import { trackViewingPresence } from "./viewing-presence.ts";
import { computed, nextTick, onUnmounted, provide, reactive, ref, shallowRef, watch } from "vue";
import type { DirectoryMessage, HostState, Permission, ProviderSubagent, WorkspaceSummary, MessageDeliveryMode } from "../shared/wire.ts";
import { DirectoryStore, comparePinnedFirst } from "./directory-store.ts";
import ThreadMenu from "./ThreadMenu.vue";
import RenameThread from "./RenameThread.vue";
import ProjectMenu from "./ProjectMenu.vue";
import ProjectSettings from "./ProjectSettings.vue";
import { ComposerStore } from "./composer-store.ts";
import ImagePreview from "./ImagePreview.vue";
import { openStream, type StreamState } from "./event-stream.ts";
import SessionList from "./SessionList.vue";
import ConversationView from "./ConversationView.vue";
import NewSession from "./NewSession.vue";
import type { ProjectGroup } from "./directory-store.ts";
import AttachmentPanel from "./AttachmentPanel.vue";
import { AttachmentStore, type LocalAttachment } from "./attachment-store.ts";
import type { ServerQueuedMessage as QueuedMessage } from "../shared/wire.ts";
import PermissionForm from "./PermissionForm.vue";
import Icon from "./Icon.vue";
import { cycleTheme, theme } from "./theme.ts";
import Settings from "./Settings.vue";
import AgentBoard from "./AgentBoard.vue";
import UsagePanel, { type UsageReport } from "./UsagePanel.vue";
import { SUGGESTIONS } from "./suggestions.ts";
import type { AgentSummary, BoardCard, CardPatch, RewindMode } from "../shared/wire.ts";
import TaskDialog from "./TaskDialog.vue";
import { registerServiceWorker, setBadge, setFavicon } from "./pwa.ts";
import { preloadMarkstream } from "./markstream-loader.ts";
import { version as WEB_VERSION } from "../../package.json";
import AgentControls from "./AgentControls.vue";
import SchedulesPage from "./SchedulesPage.vue";
import { defineAsyncComponent } from "vue";
// The side panel loads on first use: the file viewer and xterm.js stay out of the first page.
const HostSettings = defineAsyncComponent(() => import("./HostSettings.vue"));
const ChangesPanel = defineAsyncComponent(() => import("./ChangesPanel.vue"));
const ConversationSearch = defineAsyncComponent(() => import("./ConversationSearch.vue"));
const FilesPanel = defineAsyncComponent(() => import("./FilesPanel.vue"));
const FileViewer = defineAsyncComponent(() => import("./FileViewer.vue"));
const TerminalPanel = defineAsyncComponent(() => import("./TerminalPanel.vue"));
const SubagentsPanel = defineAsyncComponent(() => import("./SubagentsPanel.vue"));
import DictationButton from "./DictationButton.vue";
import { TIMELINE_CONTEXT, parseFileLink, type FileLink, type FileViewState, type LineRange, type TimelineContext } from "./timeline-display.ts";

type Card = BoardCard;
type Tab = "chat" | "board" | "hosts" | "settings" | "schedules";
const COLUMNS = ["Todo", "Doing", "Done"] as const;
const coarsePointer = matchMedia("(pointer: coarse)").matches;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const viewMenu = ref(false);
// The file tree stays in the side panel; terminal content opens in the center.
type Panel = "files" | "changes" | "search" | "subagents";
const panel = ref<Panel | null>(localStorage.getItem("litepaseo-panel") === "files" ? "files" : null);
watch(panel, (p) => (p ? localStorage.setItem("litepaseo-panel", p) : localStorage.removeItem("litepaseo-panel")));
const togglePanel = (p: Panel) => (panel.value = panel.value === p ? null : p);
/** The open agent's provider subagents (from its timeline stream) and the one being read. */
const providerSubagents = shallowRef<ProviderSubagent[]>([]);
const openedSubagent = ref<string | null>(null);
function openSubagent(id: string | null) {
  openedSubagent.value = id;
  panel.value = "subagents";
}
const terminalTabs = reactive(new Map<string, boolean>());
const terminalOpen = computed(() => terminalTabs.has(tabOwner.value));
const terminalActive = computed(() => terminalTabs.get(tabOwner.value) === true);
function openTerminal() {
  terminalTabs.set(tabOwner.value, true);
  activeFile.value = null;
  if (compact.matches) panel.value = null;
}
function showConversation() {
  terminalTabs.has(tabOwner.value) && terminalTabs.set(tabOwner.value, false);
  activeFile.value = null;
}
// Files opened as tabs, per thread (kept while the page lives; at most a dozen per thread).
const fileTabs = reactive(new Map<string, { paths: string[]; active: string | null; jump?: FileJump }>());
const tabOwner = computed(() => selectedThread.value ?? selectedKey.value ?? "");
const openFiles = computed(() => fileTabs.get(tabOwner.value)?.paths ?? []);
const activeFile = computed({
  get: () => fileTabs.get(tabOwner.value)?.active ?? null,
  set: (path: string | null) => {
    const entry = fileTabs.get(tabOwner.value);
    if (entry) entry.active = path;
    if (path && terminalTabs.has(tabOwner.value)) terminalTabs.set(tabOwner.value, false);
  },
});
/** A line to show in a file tab; `seq` makes a second click on the same line scroll again. */
type FileJump = LineRange & { path: string; seq: number };
let jumpSeq = 0;
const activeJump = computed(() => {
  const entry = fileTabs.get(tabOwner.value);
  return entry?.jump && entry.jump.path === entry.active ? entry.jump : undefined;
});
function openFile(path: string, range?: Partial<LineRange>) {
  const owner = tabOwner.value;
  if (!owner) return;
  const entry = fileTabs.get(owner) ?? { paths: [], active: null };
  if (!entry.paths.includes(path)) entry.paths = [...entry.paths, path].slice(-12);
  entry.active = path;
  entry.jump = range?.line ? { path, line: range.line, end: range.end, seq: ++jumpSeq } : undefined;
  if (terminalTabs.has(owner)) terminalTabs.set(owner, false);
  fileTabs.set(owner, entry);
  if (compact.matches) panel.value = null; // phones: show the file, not the tree on top of it
}
/** Each open tab's scroll position and view, per thread; closing the tab forgets it. */
const fileViews = new Map<string, FileViewState>();
const fileViewKey = (owner: string, path: string) => `${owner}\n${path}`;
/** Sent as a tab is left; a tab that was closed (not just switched away from) stays forgotten. */
function saveFileView(key: string, state: FileViewState) {
  const split = key.indexOf("\n");
  if (fileTabs.get(key.slice(0, split))?.paths.includes(key.slice(split + 1))) fileViews.set(key, state);
}
/** A directory a link pointed at, shown in the Files panel (per thread; `seq` reveals again). */
const reveal = ref<{ owner: string; path: string; seq: number } | null>(null);
function revealDirectory(path: string) {
  reveal.value = { owner: tabOwner.value, path, seq: ++jumpSeq };
  panel.value = "files";
}
/** Follows a local link rewritten by rewriteFileLinks (never a copy link). */
function openLocalLink(link: Exclude<FileLink, { kind: "copy" }>) {
  if (link.kind === "reveal") revealDirectory(link.path);
  else openFile(link.path, link);
}
function closeFile(path: string) {
  const entry = fileTabs.get(tabOwner.value);
  if (!entry) return;
  fileViews.delete(fileViewKey(tabOwner.value, path));
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

const instanceName = ref("");
const instanceLabel = computed(() => instanceName.value || "LitePaseo");
const token = ref(""),
  code = ref(""),
  /** null until the server says how this browser may sign in. */
  authInfo = ref<{ authenticated: boolean; totp: boolean; instanceName?: string } | null>(null),
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
    indexBy: (a) => [
      a.workspaceId ? `${a.hostId}:${a.workspaceId}` : null,
      a.parentAgentId ? `parent:${a.hostId}:${a.parentAgentId}` : null,
    ],
  }),
  /** The thread shown; the agent shown is `selectedKey`, one of the thread's agents. */
  selectedThread = ref<string | null>(null),
  listMode = ref<"projects" | "recent">(
    localStorage.getItem("litepaseo-list-mode") === "recent" ? "recent" : "projects",
  ),
  directoryState = ref<StreamState>("closed"),
  selectedKey = ref<string | null>(null),
  /** The open conversation; it owns its timeline, history paging and scrolling. */
  conversation = ref<InstanceType<typeof ConversationView> | null>(null),
  /** The conversation whose first rows arrived (read marking waits for them). */
  readyKey = ref<string | null>(null),
  composerElement = ref<HTMLTextAreaElement | null>(null),
  query = ref(""),
  /** Compact layouts show either the list or the detail pane. */
  detailOpen = ref(false);
const label = ref(""),
  connection = ref(""),
  behavior = ref<MessageDeliveryMode>("steer"),
  tab = ref<Tab>("chat"),
  cardTitle = ref(""),
  /** The conversation a new task links to: chosen explicitly, none by default. */
  cardLink = ref(""),
  board = ref<{ revision: number; cards: Card[] }>({ revision: 0, cards: [] });
const composer = new ComposerStore(() => localStorage);
const attachments = new AttachmentStore();
const queued = ref<QueuedMessage[]>([]);
const queueAttempts = new Map<string, string>();
const editingQueued = ref<string | null>(null), queuedText = ref("");
let queueRead = 0;
async function refreshQueue() {
  const a = active.value;
  const read = ++queueRead;
  if (!a || !authenticated.value) { queued.value = []; return; }
  try {
    const result = await api(path(a) + "/queue");
    if (read === queueRead && active.value?.key === a.key) queued.value = Array.isArray(result) ? result : [];
  } catch { /* The connection status already reports connectivity failures. */ }
}
watch(selectedKey, () => { queued.value = []; void refreshQueue(); });
const queueSummary = ref<Record<string, { count: number; paused: boolean }>>({});
let queueSummaryStream: { close(): void } | null = null;
watch(authenticated, signedIn => {
  queueSummaryStream?.close(); queueSummary.value = {};
  if (signedIn) queueSummaryStream = openStream({ url: () => '/api/queue/stream', onMessage: data => { queueSummary.value = data as typeof queueSummary.value; } });
});
onUnmounted(() => queueSummaryStream?.close());
let queueStream: { close(): void } | null = null;
watch([selectedKey, authenticated], () => {
  queueStream?.close(); queueStream = null;
  queueRead++; queued.value = [];
  const a = active.value;
  if (a && authenticated.value) queueStream = openStream({ url: () => '/api' + path(a) + '/queue/stream', onMessage: data => {
    if (authenticated.value && active.value?.key === a.key && Array.isArray(data)) { queueRead++; queued.value = data; }
  } });
});
onUnmounted(() => queueStream?.close());
async function controlQueue(m: QueuedMessage, command: string) {
  const a = active.value; if (!a) return;
  await action(async () => { await api(path(a) + '/queue/' + m.id + '/control', 'POST', { action: command }); await refreshQueue(); });
}
async function jumpSearch(seq: number, epoch: string) {
  const view = conversation.value;
  if (!view || view.epoch() !== epoch) { error.value = 'Conversation changed. Search again.'; return; }
  showConversation();
  if (compact.matches) panel.value = null;
  await view.jumpToPrompt(seq, true);
}
// A different conversation starts without the previous one's subagents.
watch(() => active.value?.key ?? null, () => {
  providerSubagents.value = [];
  openedSubagent.value = null;
  if (panel.value === "subagents") panel.value = null;
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
const settingsHost = ref<HostState | null>(null);
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
/** Agents the open agent delegated through Paseo, most recent first. */
const delegatedAgents = computed(() => {
  agentDirectory.version.value;
  const a = active.value;
  return a ? agentDirectory.indexed(`parent:${a.hostId}:${a.id}`, 50) : [];
});
/** The agent that delegated the open one, when it is a subagent. */
const parentAgent = computed(() => {
  agentDirectory.version.value;
  const a = active.value;
  return a?.parentAgentId ? agentDirectory.get(`${a.hostId}:${a.parentAgentId}`) ?? null : null;
});
/** The chat header's subagent summary, as Paseo's pill words it. */
const subagentSummary = computed(() => {
  const agents = delegatedAgents.value, subagents = providerSubagents.value;
  const total = agents.length + subagents.length;
  if (!total) return null;
  const attention = agents.filter((a) => a.attention).length;
  const working = agents.filter((a) => a.state === "running" && !a.attention).length + subagents.filter((s) => s.status === "running").length;
  const failed = agents.filter((a) => a.state === "failed").length + subagents.filter((s) => s.status === "failed").length;
  const label = attention ? `${attention} need${attention === 1 ? "s" : ""} input`
    : working ? `${working} working`
    : failed ? `${failed} failed`
    : `${total} subagent${total === 1 ? "" : "s"}`;
  return { total, label, tone: attention ? "attention" : working ? "running" : failed ? "error" : "idle" };
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
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** The sidebar count spelled out, e.g. "45 workspaces in 23 projects". */
const listSummary = computed(() => `${plural(viewSize.value, "workspace")} in ${plural(projectCount.value, "project")}`);
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
/** A deep-linked file or directory (`/?session=…&file=…`), opened once its thread is known. */
const pendingLink = ref<Exclude<FileLink, { kind: "copy" }> | null>(null);
watch([pendingLink, active, selectedThread], ([pending, a, thread]) => {
  if (!pending || a?.key !== pending.session || (a.workspaceId && !thread)) return;
  pendingLink.value = null;
  openLocalLink(pending);
});
const activeProject = computed(() => {
  const cwd = active.value?.cwd ?? "";
  return cwd.replace(/\/+$/, "").split("/").pop() || cwd;
});
const running = computed(() => active.value?.status === "running");
const deliveryModes = computed<MessageDeliveryMode[]>(() => active.value?.deliveryModes ?? ["queue", "interrupt"]);
const deliveryMode = computed(() => deliveryModes.value.includes(behavior.value) ? behavior.value : "queue");
watch([() => active.value?.key, () => deliveryModes.value.includes("steer")], ([, canSteer]) => {
  behavior.value = canSteer ? "steer" : "queue";
}, { immediate: true });
const markdownSettled = computed(() => directoryState.value === "live"
  && hostStates.value.get(active.value?.hostId ?? "") === "connected"
  && active.value?.turnActive === false);
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
/** Undefined until the host list arrives; meanwhile images Paseo saved are assumed readable. */
const activeHostLocal = computed(() => {
  const host = hosts.value.find((h) => h.id === active.value?.hostId);
  return host ? !!host.local : undefined;
});
watch([active, workspaceCwd, activeHostLocal], ([a, workspace, localHost]) => {
  const base = a ? "/api" + path(a) : "";
  const modes = a?.rewind ?? [];
  const current = timelineContext.value;
  if (base !== current.base || (a?.cwd ?? "") !== current.cwd || workspace !== current.workspace || localHost !== current.localHost || modes.join() !== (current.rewindModes ?? []).join())
    timelineContext.value = {
      base, cwd: a?.cwd ?? "", session: a?.key, workspace, localHost,
      rewindModes: modes, rewinding, rewind: (id, text, mode) => void rewindTo(id, text, mode),
      subagents: providerSubagents, openSubagent,
    };
}, { immediate: true });
provide(TIMELINE_CONTEXT, timelineContext);
/** Clicking an image in a message opens it full size. */
const lightbox = ref<string | null>(null);
function onTimelineClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target instanceof HTMLImageElement && target.closest(".prose, .user-images")) { event.preventDefault(); lightbox.value = target.currentSrc || target.src; return; }
  // Local links (rewritten by rewriteFileLinks): open a file tab, show a directory in the Files
  // panel, or copy a path this app cannot open. Modified clicks open the deep link in a new tab.
  const link = target?.closest?.(".prose a");
  const file = parseFileLink(link?.getAttribute("href"));
  if (!file) return;
  if (file.kind === "copy") {
    event.preventDefault();
    const fallback = () => showComposerNotice(`Can't open this here. Path: ${file.path}`);
    if (navigator.clipboard) navigator.clipboard.writeText(file.path).then(() => showComposerNotice(`Copied path: ${file.path}`), fallback);
    else fallback();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (file.session !== selectedKey.value) select(file.session);
  openLocalLink(file);
}
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
  if (!response.ok) throw Object.assign(new Error((data.error ?? "Request failed") + (data.requestId ? ` (reference ${data.requestId})` : "")), { status: response.status, delivery: data.delivery, code: data.code, scope: data.scope });
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
    queued.value = [];
    queueRead++;
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
  try { authInfo.value = await api("/auth"); instanceName.value = authInfo.value?.instanceName ?? ""; }
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
  // A file link opened in a new tab adds &file= (or &dir=): open it once the session is shown.
  const wanted = new URLSearchParams(location.search).get("session");
  if (wanted) {
    const linked = parseFileLink("/" + location.search);
    history.replaceState(history.state, "", "/");
    pendingLink.value = linked && linked.kind !== "copy" ? linked : null;
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
      if (message.type === "project-pins") applyProjectPins(message.pins);
      else if (message.type === "hosts") {
        hosts.value = message.hosts;
        if (message.instanceName !== undefined) instanceName.value = message.instanceName;
        if (message.version) serverVersion.value = message.version;
      }
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
/** Conversations kept rendered for switching back: fewer on phones, where memory is tighter. */
const CACHED_CONVERSATIONS = compact.matches ? 3 : 5;
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
// Project actions (Paseo's project menu): edit paseo.json, remove the project from its host.
type ProjectTarget = { name: string; hostId: string; rootPath: string; projectIds: string[]; threadKeys: string[] };
const projectPins = ref<Record<string, number>>({});
function projectPinned(target: ProjectTarget) { return target.projectIds.some(id => !!projectPins.value[JSON.stringify([target.hostId, id])]); }
let projectPinsRevision = 0;
function applyProjectPins(pins: Record<string, number>) { projectPinsRevision++; projectPins.value = pins; directory.setProjectPins(pins); }
async function pinProject(target: ProjectTarget) {
  const pinned = !projectPinned(target);
  const revision = projectPinsRevision;
  await action(async () => {
    const pins = await api('/project-pins', 'POST', {hostId: target.hostId, projectIds: target.projectIds, pinned});
    if (revision === projectPinsRevision) applyProjectPins(pins);
  });
}
const projectMenu = shallowRef<{ project: ProjectTarget; x: number; y: number } | null>(null);
const projectSettings = shallowRef<ProjectTarget | null>(null);
/** The open settings follow the live directory, so a rename or new icon shows at once. */
const settingsProject = computed(() => {
  directory.version.value;
  const target = projectSettings.value;
  if (!target) return null;
  const thread = target.threadKeys.map((key) => directory.get(key)).find(Boolean);
  return {
    projectId: thread?.projectId ?? target.projectIds[0] ?? "",
    name: thread?.project ?? target.name,
    customName: thread?.projectCustomName ?? null,
    iconRevision: thread?.projectIconRevision ?? null,
  };
});
function openProjectMenu(group: ProjectGroup<WorkspaceSummary>, x: number, y: number) {
  const items = group.items.range(0, group.items.size);
  const first = items[0];
  if (!first) return;
  projectMenu.value = {
    project: {
      name: group.name,
      hostId: first.hostId,
      rootPath: first.rootPath,
      // A row groups by name, so it may hold more than one daemon project; removal covers them all.
      projectIds: [...new Set(items.map((t) => t.projectId).filter(Boolean))],
      threadKeys: items.map((t) => t.key),
    },
    x,
    y,
  };
}
async function removeProject(project: ProjectTarget) {
  const host = hostLabels.value.get(project.hostId) ?? "its host";
  const threads = project.threadKeys.length;
  if (
    !confirm(
      `Remove “${project.name}” from ${host}? Its ${threads === 1 ? "thread is" : `${threads} threads are`} archived ` +
        "and the project leaves the sidebar. Files on disk are not touched; the host keeps the history.",
    )
  )
    return;
  await action(async () => {
    if (!project.projectIds.length) throw new Error("This host did not report a project id; update Paseo on it.");
    for (const id of project.projectIds)
      await api(`/hosts/${encodeURIComponent(project.hostId)}/projects/${encodeURIComponent(id)}`, "DELETE", undefined, 60000);
    if (selectedThread.value && project.threadKeys.includes(selectedThread.value))
      selectedThread.value = selectedKey.value = null;
  });
}
// Viewing an unread thread marks it read (the agent-level read happens below).
let threadReadSent = "";
watch(
  () => (activeThread.value?.unread && !!selectedKey.value && readyKey.value === selectedKey.value ? activeThread.value : null),
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
  () => (active.value && active.value.unread && readyKey.value === active.value.key ? active.value : null),
  (a) => {
    if (!a || document.hidden) return;
    const marker = `${a.key}@${a.activityAt}`;
    if (readSent === marker) return;
    readSent = marker;
    void api(path(a) + "/read", "POST", {}).catch(() => (readSent = ""));
  },
);

// next-input suggestions: rows ask through these; each conversation's newest ready one is its
// Tab completion, kept while the conversation is cached out of view.
const suggestions = reactive(new Map<string, { seqStart: number; text: string }>());
function offerSuggestion(key: string, seqStart: number, text: string) {
  const current = suggestions.get(key);
  if (!current || seqStart >= current.seqStart) suggestions.set(key, { seqStart, text });
}
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
    if (active.value) offerSuggestion(active.value.key, seqStart, text);
  },
});
const composerSuggestion = computed(() => {
  const offered = active.value && suggestions.get(active.value.key);
  return offered && !prompt.value ? offered.text : "";
});
const composerPlaceholder = computed(() => {
  if (composerSuggestion.value && !coarsePointer) return composerSuggestion.value;
  if (!running.value) return "Message this agent…";
  return deliveryMode.value === "queue" ? "Queue a message for when this turn ends"
    : deliveryMode.value === "steer" ? "Guide the current turn with a new instruction"
    : "Interrupt and send a new message";
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
/** The server's version, from the directory stream; this page was built as WEB_VERSION. */
const serverVersion = ref("");
const reloadPage = () => location.reload();

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
  if (deliveryMode.value === "queue" && (!turnIdle(a) || queued.value.length > 0)) {
    const selected = fromComposer ? [...selectedAttachments.value] : [];
    await action(async () => {
      const attachmentIds = selected.map(e => e.id!);
      const attempt = JSON.stringify([a.key, text, attachmentIds]);
      const id = queueAttempts.get(attempt) ?? crypto.randomUUID();
      queueAttempts.set(attempt, id);
      try { await api(path(a) + "/queue", "POST", { id, text, attachmentIds }); }
      catch (e) { await refreshQueue(); throw e; }
      queueAttempts.delete(attempt);
      for (const entry of selected) attachments.remove(a.key, entry, true);
      if (fromComposer && composer.state(a.key).text === text) composer.setText(a.key, "");
      suggestions.delete(a.key);
      await refreshQueue();
      void nextTick(autosize);
    });
    return;
  }
  const selected = fromComposer ? [...selectedAttachments.value] : [];
  if (fromComposer) composer.setText(a.key, "");
  await deliver(a, text, selected, turnIdle(a) || deliveryMode.value === "queue" ? "send" : deliveryMode.value, { restore: fromComposer });
}
/** Sends immediately; uncertain outcomes remain in the delivery check. */
async function deliver(a: AgentSummary, text: string, selected: LocalAttachment[], mode: "send" | "steer" | "interrupt",
  { restore }: { restore: boolean }) {
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
      suggestions.delete(a.key);
      void nextTick(autosize);
      if (selectedKey.value === a.key) conversation.value?.showLatest();
    } catch (e) {
      if (generation !== composer.generation) return;
      const notSent = (e as { delivery?: string }).delivery === "not-sent";
      if (notSent) {
        composer.resolve(a.key, sent.messageId);
        if ((e as { status?: number }).status !== 409)
          for (const entry of selected) entry.error = "Not sent. Retry the upload or remove this attachment.";
      }
      if (restore && !state.text) {
        composer.restoreFailed(a.key, sent);
      }
      throw e;
    }
  });
  return delivered;
}
async function removeQueued(m: QueuedMessage) {
  const a = active.value;
  if (!a) return;
  await action(async () => { await api(path(a) + "/queue/" + m.id, "DELETE"); await refreshQueue(); });
}
async function editQueued(m: QueuedMessage) {
  const a = active.value;
  if (!a) return;
  const text = queuedText.value;
  await action(async () => { await api(path(a) + "/queue/" + m.id, "PATCH", { text }); editingQueued.value = null; await refreshQueue(); });
}
async function interruptWith(m: QueuedMessage) {
  const a = active.value;
  if (!a || busy.value || uncertain.value) return;
  await action(async () => { await api(path(a) + "/queue/" + m.id + "/send", "POST"); await refreshQueue(); });
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

trackViewingPresence(() => authenticated.value && tab.value === "chat" &&
  (!compact.matches || detailOpen.value) && !activeFile.value && !terminalActive.value
  ? active.value?.key ?? null : null, () => authenticated.value);

void loadAuth();
// Waiting sessions show on the app icon and in the tab title.
const waiting = computed(() => {
  directory.version.value;
  return agentDirectory.waiting;
});
watch(waiting, (count) => setBadge(count));
watch([waiting, instanceName], ([count, name]) => {
  const title = name ? `${name} · LitePaseo` : "LitePaseo";
  document.title = count ? `(${count}) ${title}` : title;
}, { immediate: true });
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
  attachments.clear();
  window.removeEventListener("storage", onComposerStorage);
  window.removeEventListener("popstate", onPopState);
  window.removeEventListener("keydown", onGlobalKey);
  directoryStream?.close();
  clearTimeout(searchTimer);
});
</script>

<template>
  <div v-if="!authenticated" class="login">
    <form v-if="authInfo" class="login-card" @submit.prevent="login">
      <div class="brand brand-large"><img class="brand-mark" src="/icons/mark.svg" alt="" width="22" height="22" />{{ instanceLabel }}</div>
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
      <div v-if="instanceName" class="instance-name" :title="instanceName">{{ instanceName }}</div>
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
        <!-- Always the number of workspaces listed: the same unit as the host chips. -->
        <span class="list-summary" :title="listSummary" :aria-label="listSummary">{{ viewSize }}</span>
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
      <div v-if="hostFilter" class="active-host-filter" role="group" aria-label="Active host filter">
        <button class="active-host-label" :title="'Filtered by host: ' + (hostLabels.get(hostFilter) ?? hostFilter)" @click="viewMenu = true">
          <Icon name="server" :size="13" />
          <span>Host: {{ hostLabels.get(hostFilter) ?? hostFilter }}</span>
        </button>
        <button class="icon-btn" aria-label="Clear host filter" title="Show all hosts" @click="hostFilter = null"><Icon name="close" :size="13" /></button>
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
            All<span class="chip-count" :title="plural(sessionCount, 'workspace')">{{ sessionCount }}</span>
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
            >{{ h.label }}<span class="chip-count" :title="plural(hostCounts.get(h.id) ?? 0, 'workspace')">{{ hostCounts.get(h.id) }}</span>
          </button>
        </div>
      </div>
      <SessionList
        :queues="queueSummary"
        :mode="listMode"
        :store="directory"
        :host-labels="hostLabels"
        :host-states="hostStates"
        :selected-key="selectedThread"
        :searching="!!query.trim()"
        @select="selectThread"
        @new="startNew"
        @menu="openMenu"
        @project-menu="openProjectMenu"
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
      <div v-if="serverVersion && serverVersion !== WEB_VERSION" class="toast update-toast" role="status">
        <Icon name="refresh" :size="15" /><span>LitePaseo {{ serverVersion }} is installed. Reload to use it.</span
        ><button class="btn btn-sm" @click="reloadPage">Reload</button>
      </div>
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
        :instance-name="instanceName"
        @instance-changed="(name) => instanceName = name"
        :totp-enabled="!!authInfo?.totp"
        @back="closeDetail"
        @signed-out="signOut('user')"
        @totp-changed="(on) => authInfo && (authInfo.totp = on)"
        @dictation-changed="(on) => (dictationReady = on)"
      />

      <HostSettings v-else-if="tab === 'hosts' && settingsHost" :key="settingsHost.id" :host="settingsHost" :api="api" @back="settingsHost = null" />
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
              <button class="btn btn-outline" :disabled="h.state !== 'connected'" @click="settingsHost = h">Settings</button>
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
          <button
            v-if="parentAgent"
            class="chat-chip"
            :title="'Subagent of ' + (parentAgent.title || 'another session') + ' · open the parent'"
            @click="select(parentAgent.key)"
          >
            <Icon name="back" :size="12" /><span>{{ parentAgent.title || "Parent agent" }}</span>
          </button>
          <span class="grow"></span>
          <button
            v-if="subagentSummary"
            class="chat-chip chat-subagents"
            :class="['is-' + subagentSummary.tone, { chosen: panel === 'subagents' }]"
            :aria-label="'Subagents: ' + subagentSummary.label"
            :title="subagentSummary.total + (subagentSummary.total === 1 ? ' subagent' : ' subagents')"
            @click="openedSubagent = null; togglePanel('subagents')"
          >
            <span v-if="subagentSummary.tone !== 'idle'" class="status-dot" :class="'is-' + subagentSummary.tone"></span>
            <Icon v-else name="bot" :size="14" /><span>{{ subagentSummary.label }}</span>
          </button>
          <button class="icon-btn head-tool" aria-label="Changes" title="Workspace changes" @click="togglePanel('changes')"><Icon name="file" :size="16" /></button>
          <button class="icon-btn head-tool" aria-label="Search conversation" title="Search conversation" @click="togglePanel('search')"><Icon name="search" :size="16" /></button>
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
            :class="{ chosen: terminalActive }"
            aria-label="Terminal"
            title="Terminal"
            @click="openTerminal()"
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
        <nav v-if="threadAgents.length > 1 || openFiles.length || terminalOpen" class="agent-tabs" aria-label="Tabs">
          <button
            v-for="a in threadAgents.length ? threadAgents : [active]"
            :key="a.key"
            :class="{ chosen: a.key === selectedKey && !activeFile && !terminalActive }"
            @click="selectedKey = a.key; showConversation()"
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
          <button v-if="terminalOpen" class="file-tab" :class="{ chosen: terminalActive }" @click="openTerminal()">
            <Icon name="terminal" :size="13" /><span class="agent-tab-name">Terminal</span>
            <span class="tab-close" role="button" aria-label="Close terminal tab" @click.stop="terminalTabs.delete(tabOwner)"><Icon name="close" :size="11" /></span>
          </button>
        </nav>
        <TerminalPanel
          v-if="terminalOpen"
          v-show="terminalActive"
          :key="'t:' + active.hostId + workspaceCwd"
          :host-id="active.hostId" :cwd="workspaceCwd" :api="api"
          :visible="terminalActive"
        />
        <FileViewer
          v-if="activeFile"
          :key="active.hostId + ':' + workspaceCwd + ':' + activeFile"
          :host-id="active.hostId"
          :cwd="workspaceCwd"
          :path="activeFile"
          :api="api"
          :session="active.key"
          :jump="activeJump"
          :view="fileViews.get(fileViewKey(tabOwner, activeFile))"
          :view-key="fileViewKey(tabOwner, activeFile)"
          @view="saveFileView"
          @open="openFile"
          @reveal="revealDirectory"
        />

        <!-- Recently opened conversations stay rendered (out of view they are inert): switching back is instant. -->
        <KeepAlive :max="CACHED_CONVERSATIONS">
          <ConversationView
            v-show="!activeFile && !terminalActive"
            ref="conversation"
            :key="active.key"
            :agent="active"
            :api="api"
            :context="timelineContext"
            :host-label="hostLabels.get(active.hostId) ?? ''"
            :settled="markdownSettled"
            :footer-model="footerModel"
            @error="(message) => (error = message)"
            @subagents="(list) => (providerSubagents = list)"
            @ready="readyKey = active.key"
            @timeline-click="onTimelineClick"
            @unauthorized="signOut('ended')"
            @suggestion="offerSuggestion"
          />
        </KeepAlive>

        <div v-show="!activeFile && !terminalActive" class="dock">
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
                  <template v-if="editingQueued === m.id">
                    <textarea v-model="queuedText" aria-label="Queued message text" rows="3" />
                    <button type="button" class="btn btn-ghost" :disabled="busy" @click="editQueued(m)">Save</button>
                    <button type="button" class="btn btn-ghost" @click="editingQueued = null">Cancel</button>
                  </template>
                  <span v-else class="queue-text" :title="m.text">{{ m.text || "(attachments only)" }}</span>
                  <span v-if="m.attachmentNames.length" class="queue-meta">{{ m.attachmentNames.join(", ") }}</span>
                  <span class="queue-meta">{{ m.sending ? 'Sending…' : m.error ? 'Delivery unknown · queue paused' : m.paused ? 'Paused' : hostStates.get(active.hostId) !== 'connected' ? 'Waiting for host' : 'Waiting for turn to finish' }}</span>
                  <span v-if="m.error" class="queue-meta queue-error">{{ m.error }}</span>
                </div>
                <button class="btn btn-ghost" :disabled="busy || m.sending" @click="controlQueue(m, m.paused ? 'resume' : 'pause')">{{ m.paused ? 'Resume' : 'Pause' }}</button>
                <button class="btn btn-ghost" :disabled="busy || m.sending || queued[0].id === m.id" @click="controlQueue(m, 'up')" aria-label="Move queued message up">↑</button>
                <button v-if="m.error" class="btn btn-ghost" :disabled="busy" @click="controlQueue(m, 'check')">Check delivery</button>
                <button type="button" class="queue-send" :disabled="busy || !!uncertain || m.sending"
                  :title="running ? 'Send now: stops the running turn' : 'Send now'" @click="interruptWith(m)">
                  {{ running ? "Interrupt" : "Send" }}
                </button>
                <button type="button" class="icon-btn" :disabled="busy || m.sending" aria-label="Edit queued message" title="Edit" @click="editingQueued = m.id; queuedText = m.text"><Icon name="edit" :size="14" /></button>
                <button type="button" class="icon-btn" :disabled="busy || m.sending" aria-label="Remove queued message" title="Remove" @click="removeQueued(m)"><Icon name="close" :size="14" /></button>
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
                  <label v-if="running" class="chip-behavior" :class="'is-' + behavior"
                    :title="behavior === 'queue' ? 'Queue: send when the current turn ends' : behavior === 'steer' ? 'Steer: send instructions into the current turn; Paseo may interrupt if steering is unavailable' : 'Interrupt: stop the current turn and start a new one'">
                    <span>{{ behavior === 'queue' ? 'Queue' : behavior === 'steer' ? 'Steer' : 'Interrupt' }}</span>
                    <Icon name="chevron" :size="11" class="behavior-caret" />
                    <select v-model="behavior" aria-label="Message delivery mode">
                      <option value="queue">Queue</option>
                      <option v-if="deliveryModes.includes('steer')" value="steer">Steer</option>
                      <option value="interrupt">Interrupt</option>
                    </select>
                  </label>
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
      <aside v-if="panel" class="side-panel" aria-label="Files">
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
          <button :class="{ chosen: panel === 'changes' }" @click="panel = 'changes'">Changes</button>
          <button :class="{ chosen: panel === 'search' }" @click="panel = 'search'">Search</button>
          <button v-if="subagentSummary || panel === 'subagents'" :class="{ chosen: panel === 'subagents' }" @click="panel = 'subagents'">Subagents</button>
          <span class="grow"></span>
          <button class="icon-btn" aria-label="Close panel" title="Close panel" @click="panel = null"><Icon name="close" :size="14" /></button>
        </div>
        <div class="panel-body">
          <ChangesPanel v-if="panel === 'changes'" :host-id="active.hostId" :cwd="workspaceCwd" :api="api" />
          <ConversationSearch v-if="panel === 'search'" :base="path(active)" :api="api" @jump="jumpSearch" />
          <SubagentsPanel
            v-if="panel === 'subagents'"
            v-model:opened="openedSubagent"
            :agents="delegatedAgents"
            :subagents="providerSubagents"
            :base="path(active)"
            :api="api"
            @select="select"
          />
          <KeepAlive>
            <FilesPanel
              v-if="panel === 'files'"
              :key="'f:' + active.hostId + workspaceCwd"
              :host-id="active.hostId"
              :cwd="workspaceCwd"
              :api="api"
              :active-path="activeFile"
              :reveal="reveal?.owner === tabOwner ? reveal : null"
              @open="openFile"
            />
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
    <ProjectMenu
      v-if="projectMenu"
      :name="projectMenu.project.name"
      :pinned="projectPinned(projectMenu.project)"
      @pin="pinProject(projectMenu!.project)"
      :host="hostLabels.get(projectMenu.project.hostId) ?? 'Unknown host'"
      :x="projectMenu.x"
      :y="projectMenu.y"
      @close="projectMenu = null"
      @settings="projectSettings = projectMenu!.project"
      @remove="removeProject(projectMenu!.project)"
    />
    <ProjectSettings
      v-if="projectSettings"
      :host-id="projectSettings.hostId"
      :host-label="hostLabels.get(projectSettings.hostId) ?? 'Unknown host'"
      :project="settingsProject!"
      :root-path="projectSettings.rootPath"
      :custom-icons="!!hosts.find((h) => h.id === projectSettings!.hostId)?.customIcons"
      :request="api"
      @close="projectSettings = null"
    />
    <ImagePreview v-if="lightbox" :src="lightbox" @close="lightbox = null" />
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
