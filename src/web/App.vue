<script setup lang="ts">
import { trackViewingPresence } from "./viewing-presence.ts";
import { safeGetItem, safeRemoveItem, safeSetItem } from "./safe-storage.ts";
import { computed, defineAsyncComponent, nextTick, onUnmounted, provide, ref, shallowRef, watch } from "vue";
import type { AgentBackgroundWorkItem, AgentSummary, DirectoryMessage, ForkContextResult, HostState, ProviderSubagent, RewindMode, WorkspaceSummary } from "../shared/wire.ts";
import { DirectoryStore, comparePinnedFirst, type ProjectGroup } from "./directory-store.ts";
import { openStream, type StreamState } from "./event-stream.ts";
import { newId } from "./id.ts";
import { agentPath as path, useApi } from "./use-api.ts";
import { useComposer } from "./use-composer.ts";
import { useResizableWidth } from "./use-resizable-width.ts";
import { useThreadActions } from "./use-thread-actions.ts";
import { useWorkspaceTabs } from "./use-workspace-tabs.ts";
import ThreadMenu from "./ThreadMenu.vue";
import RenameThread from "./RenameThread.vue";
import ProjectMenu from "./ProjectMenu.vue";
import ProjectSettings from "./ProjectSettings.vue";
import ImagePreview from "./ImagePreview.vue";
import Sidebar, { type Tab } from "./Sidebar.vue";
import ChatHeader from "./ChatHeader.vue";
import ConversationView from "./ConversationView.vue";
import ComposerDock from "./ComposerDock.vue";
import SidePanel from "./SidePanel.vue";
import NewSession from "./NewSession.vue";
import Icon from "./Icon.vue";
import Settings from "./Settings.vue";
import HostsPage from "./HostsPage.vue";
import LoginPage from "./LoginPage.vue";
import type { Board } from "./PlanBoard.vue";
import type { UsageReport } from "./UsagePanel.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import { confirmAction, confirmRequest } from "./confirm.ts";
import { dialogOpen } from "./use-dialog.ts";
import { registerServiceWorker, setBadge, setFavicon } from "./pwa.ts";
import { loadMarkstream } from "./markstream-loader.ts";
import { version as WEB_VERSION } from "../../package.json";
import SchedulesPage from "./SchedulesPage.vue";
import { TIMELINE_CONTEXT, parseFileLink, type FileLink, type TimelineContext } from "./timeline-display.ts";
import { cycleTheme } from "./theme.ts";
import type { CommandAction } from "./CommandCenter.vue";
// These load on first use: the board, host settings, the file viewer and xterm.js stay out of the first page.
const KanbanPage = defineAsyncComponent(() => import("./KanbanPage.vue"));
const HostSettings = defineAsyncComponent(() => import("./HostSettings.vue"));
const FileViewer = defineAsyncComponent(() => import("./FileViewer.vue"));
const TerminalPanel = defineAsyncComponent(() => import("./TerminalPanel.vue"));
const CommandCenter = defineAsyncComponent(() => import("./CommandCenter.vue"));
const ArchivedWorkspaces = defineAsyncComponent(() => import("./ArchivedWorkspaces.vue"));
const AddProjectDialog = defineAsyncComponent(() => import("./AddProjectDialog.vue"));
const ImportSessionDialog = defineAsyncComponent(() => import("./ImportSessionDialog.vue"));
const LabelsDialog = defineAsyncComponent(() => import("./LabelsDialog.vue"));

// Compact layouts: the detail pane is a history entry, so the system back button or gesture
// returns to the list instead of leaving the app.
const compact = matchMedia("(max-width: 760px)");
const isCompact = ref(compact.matches);
const onCompactChange = (event: MediaQueryListEvent) => {
  isCompact.value = event.matches;
};
compact.addEventListener("change", onCompactChange);
/** Conversations kept rendered for switching back: fewer on phones, where memory is tighter. */
const CACHED_CONVERSATIONS = compact.matches ? 3 : 5;

// Resizable sidebar and side panel (desktop): widths persist per browser.
const resizing = ref(false);
const { width: sidebarWidth, setWidth: setSidebarWidth, startResize, ...sidebarBounds } =
  useResizableWidth("litepaseo-sidebar-width", { min: 220, max: 520, initial: 300, direction: 1, perFrame: true }, resizing);
const { width: panelWidth, setWidth: setPanelWidth, startResize: startPanelResize, ...panelBounds } =
  useResizableWidth("litepaseo-panel-width", { min: 280, max: 900, initial: 420, direction: -1 }, resizing);

function readJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(safeGetItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
}

const instanceName = ref("");
const instanceLabel = computed(() => instanceName.value || "LitePaseo");
/** null until the server says how this browser may sign in. */
const authInfo = ref<{ authenticated: boolean; totp: boolean; instanceName?: string } | null>(null),
  authenticated = ref(false);
const { api, action, busy, error } = useApi({ authenticated, onUnauthorized: () => signOut("ended") });
const hosts = shallowRef<HostState[]>([]),
  /** The sidebar: Paseo workspaces ("threads"), pinned first, then by last use. */
  directory = new DirectoryStore<WorkspaceSummary>({
    collapsed: readJson<string[]>("litepaseo-collapsed-projects", []),
    persist: (keys) => safeSetItem("litepaseo-collapsed-projects", JSON.stringify(keys)),
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
    safeGetItem("litepaseo-list-mode") === "recent" ? "recent" : "projects",
  ),
  directoryState = ref<StreamState>("closed"),
  selectedKey = ref<string | null>(null),
  /** The open conversation; it owns its timeline, history paging and scrolling. */
  conversation = ref<InstanceType<typeof ConversationView> | null>(null),
  /** The conversation whose first rows arrived (read marking waits for them). */
  readyKey = ref<string | null>(null),
  query = ref(""),
  /** Compact layouts show either the list or the detail pane. */
  detailOpen = ref(false);
const tab = ref<Tab>("chat"),
  board = ref<Board>({ revision: 0, cards: [] });

// O(1) per directory message: map lookups, not scans.
const active = computed(() => {
  agentDirectory.version.value;
  return agentDirectory.get(selectedKey.value) ?? null;
});
const activeThread = computed(() => {
  directory.version.value;
  return directory.get(selectedThread.value) ?? null;
});

/** Files, the terminal and the side panel, per open thread. */
const tabOwner = computed(() => selectedThread.value ?? selectedKey.value ?? "");
const tabs = useWorkspaceTabs(tabOwner, compact);
const { panel, togglePanel, terminalOpen, terminalActive, showConversation, activeFile, activeJump, openFile,
  fileViews, fileViewKey, saveFileView, reveal, revealDirectory, openLocalLink } = tabs;
/** The open agent's provider subagents (from its timeline stream) and the one being read. */
const providerSubagents = shallowRef<ProviderSubagent[]>([]);
const backgroundWork = shallowRef<AgentBackgroundWorkItem[]>([]);
const openedSubagent = ref<string | null>(null);
function openSubagent(id: string | null) {
  openedSubagent.value = id;
  panel.value = "subagents";
}

const composer = useComposer({
  active,
  selectedKey,
  authenticated,
  api,
  action,
  busy,
  showLatest: () => conversation.value?.showLatest(),
  baselineSeqEnd: () => conversation.value?.latestSeqEnd() ?? -1,
});
const { prompt, autosize, queueSummary, offerSuggestion, dictationReady, showNotice } = composer;
const suggestionsReady = ref(false);
watch(authenticated, (ok) => {
  if (!ok) { suggestionsReady.value = false; return; }
  void api("/next-suggestion").then((s) => { suggestionsReady.value = !!s?.configured; }).catch(() => {});
}, { immediate: true });

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
  backgroundWork.value = [];
  openedSubagent.value = null;
  if (panel.value === "subagents") panel.value = null;
});
/** Model name for turn footers: the open agent's current model, as the composer chip names it. */
const footerModel = ref("");

const hostLabels = computed(() => new Map(hosts.value.map((h) => [h.id, h.label])));
const hostStates = computed(() => new Map(hosts.value.map((h) => [h.id, h.state])));
const settingsHost = ref<HostState | null>(null);
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
  return agentDirectory.indexed(selectedThread.value, 50);
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
watch(listMode, (mode) => safeSetItem("litepaseo-list-mode", mode));

// Host scope for the sidebar. Each host keeps its own incrementally maintained view.
const hostFilter = ref<string | null>(safeGetItem("litepaseo-host-filter"));
watch(
  hostFilter,
  (id) => {
    directory.setHost(id);
    agentDirectory.setHost(id);
    if (id) safeSetItem("litepaseo-host-filter", id);
    else safeRemoveItem("litepaseo-host-filter");
  },
  { immediate: true },
);
watch(hosts, (list) => {
  if (hostFilter.value && list.length && !list.some((h) => h.id === hostFilter.value))
    hostFilter.value = null;
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
      showNotice(mode === "files" ? "Files rewound." : mode === "both" ? "Conversation and files rewound." : "Conversation rewound.");
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
    const fallback = () => showNotice(`Can't open this here. Path: ${file.path}`);
    if (navigator.clipboard) navigator.clipboard.writeText(file.path).then(() => showNotice(`Copied path: ${file.path}`), fallback);
    else fallback();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (file.session !== selectedKey.value) select(file.session);
  openLocalLink(file);
}

let directoryStream: { close(): void } | null = null,
  searchTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * "user": the person chose to sign out (Settings) — drafts and staged files are erased here and
 * in other tabs, as expected on a shared computer. "ended": the session expired or was revoked
 * elsewhere — nothing the user wrote is erased; drafts and unconfirmed messages wait for sign-in.
 */
function signOut(reason: "user" | "ended") {
  authenticated.value = false;
  composer.signedOut(reason);
  if (reason === "user") {
    // Nothing from the signed-out account stays in memory for the next person at this computer.
    tabs.clear();
    settingsHost.value = null;
    usage.value = null;
    board.value = { revision: 0, cards: [] };
  }
  directoryStream?.close();
  directoryStream = null;
  clearInterval(usageTimer);
  usageTimer = undefined;
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
async function login(token: string, code: string) {
  await action(async () => {
    await api("/login", "POST", { token, ...(authInfo.value?.totp ? { code } : {}) });
    await enter();
  });
}
let pendingNotificationSession: string | null = null;
async function enter() {
  authenticated.value = true;
  error.value = "";
  openDirectory();
  void api("/board")
    .then((b) => {
      if (authenticated.value && b && (!board.value.cards.length || (b.revision ?? 0) >= (board.value.revision ?? 0))) {
        board.value = b;
      }
    })
    .catch(() => {});
  void registerServiceWorker();
  void loadUsage();
  void composer.loadDictation();
  syncUsageTimer();
  // A notification tap opens /?session=<key>; select it once and clean the address.
  // A file link opened in a new tab adds &file= (or &dir=): open it once the session is shown.
  const wanted = new URLSearchParams(location.search).get("session") || pendingNotificationSession;
  pendingNotificationSession = null;
  if (wanted) {
    const linked = parseFileLink("/" + location.search);
    if (location.search) history.replaceState(history.state, "", "/");
    pendingLink.value = linked && linked.kind !== "copy" ? linked : null;
    select(wanted);
  }
}
// The service worker asks an already-open app to show the tapped session.
function onServiceWorkerMessage(event: MessageEvent) {
  if (event.data?.type !== "open-session") return;
  const key = String(event.data.key || "");
  if (!key) return;
  if (authenticated.value) select(key);
  else pendingNotificationSession = key;
}
navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
function openDirectory() {
  directoryStream?.close();
  directoryStream = openStream({
    url: () =>
      `/api/stream?queues=1&generation=${encodeURIComponent(agentDirectory.generation)}&since=${agentDirectory.seq}` +
      `&wgeneration=${encodeURIComponent(directory.generation)}&wsince=${directory.seq}` +
      `&pgeneration=${encodeURIComponent(directory.emptyGeneration)}&psince=${directory.emptySeq}`,
    onState: (state) => {
      directoryState.value = state;
      if (state === "connecting") composer.resetQueueSync();
      if (state === "unauthorized") signOut("ended");
    },
    onMessage: (data) => {
      const message = data as DirectoryMessage;
      if (message.type === "project-pins") applyProjectPins(message.pins);
      else if (message.type === "queue-summary") composer.applyQueueSummary(message.summary, message.version);
      else if (message.type === "hosts") {
        hosts.value = message.hosts;
        if (message.instanceName !== undefined) instanceName.value = message.instanceName;
        if (message.version) serverVersion.value = message.version;
      }
      else if (message.type === "workspaces-snapshot")
        directory.applyCollection({ type: "snapshot", generation: message.generation, seq: message.seq, items: message.workspaces });
      else if (message.type === "workspaces-changes")
        directory.applyCollection({ type: "changes", generation: message.generation, seq: message.seq, changes: message.changes });
      else if (message.type === "empty-projects-snapshot")
        directory.applyEmptyProjects({ type: "snapshot", generation: message.generation, seq: message.seq, items: message.projects });
      else if (message.type === "empty-projects-changes")
        directory.applyEmptyProjects({ type: "changes", generation: message.generation, seq: message.seq, changes: message.changes });
      else agentDirectory.apply(message);
    },
  });
}

// Search and label filter: the matching set is built once per query and then maintained incrementally.
const labelFilter = ref<string | null>(null);
function applyDirectoryFilter() {
  const needle = query.value.trim().toLowerCase();
  const lbl = labelFilter.value;
  if (!needle && !lbl) {
    directory.setFilter(null);
    agentDirectory.setFilter(null);
    return;
  }
  const labels = hostLabels.value;
  directory.setFilter(
    (w) => {
      if (lbl && !(w.labels ?? []).includes(lbl)) return false;
      if (!needle) return true;
      return `${w.name}\n${w.project}\n${w.branch ?? ""}\n${w.directory}\n${(w.labels ?? []).join(" ")}\n${labels.get(w.hostId) ?? ""}`
        .toLowerCase()
        .includes(needle);
    },
    (p) =>
      !lbl &&
      `${p.name}\n${p.rootPath}\n${labels.get(p.hostId) ?? ""}`
        .toLowerCase()
        .includes(needle),
  );
  agentDirectory.setFilter(
    needle
      ? (a) =>
          `${a.title ?? ""}\n${a.project}\n${a.cwd}\n${labels.get(a.hostId) ?? ""}\n${a.provider}`
            .toLowerCase()
            .includes(needle)
      : null,
  );
}
watch(query, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyDirectoryFilter, 120);
});
watch(labelFilter, () => applyDirectoryFilter());

/** Opens an agent (board, notification, a new session) and the thread it belongs to. */
function select(key: string) {
  tab.value = "chat";
  newSession.value = null;
  selectedKey.value = key;
  const agent = agentDirectory.get(key);
  selectedThread.value = agent?.workspaceId ? `${agent.hostId}:${agent.workspaceId}` : null;
  void loadMarkstream();
  openDetail();
}
/** Opens a thread from the sidebar: its most recently used agent. */
function selectThread(key: string) {
  tab.value = "chat";
  newSession.value = null;
  selectedThread.value = key;
  selectedKey.value = agentDirectory.indexed(key, 1)[0]?.key ?? null;
  void loadMarkstream();
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

function openDetail() {
  if (!detailOpen.value && compact.matches) history.pushState({ litepaseoDetail: true }, "");
  detailOpen.value = true;
}
function closeDetail() {
  if (history.state?.litepaseoDetail) history.back();
  else detailOpen.value = false;
}
function onPopState() {
  if (detailOpen.value && !history.state?.litepaseoDetail) {
    detailOpen.value = false;
    newSession.value = null;
  }
}
window.addEventListener("popstate", onPopState);
function openTab(next: Tab) {
  tab.value = next;
  if (next !== "chat") newSession.value = null;
  if (next !== "chat" || selectedKey.value || newSession.value) openDetail();
  else closeDetail();
}

const sidebar = ref<InstanceType<typeof Sidebar> | null>(null);
const composerDock = ref<InstanceType<typeof ComposerDock> | null>(null);
const newSessionRef = ref<InstanceType<typeof NewSession> | null>(null);
const commandCenterOpen = ref(false);
const archivedOpen = ref(false);
const addProjectOpen = ref(false);
const importSessionOpen = ref(false);
const labelingThread = shallowRef<WorkspaceSummary | null>(null);

interface AgentProfileItem {
  id: string;
  hostId: string;
  name: string;
  provider: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
}
const hostProfilesCache = new Map<string, { at: number; items: AgentProfileItem[] }>();
const commandProfiles = ref<AgentProfileItem[]>([]);
const draftHostId = ref<string | null>(null);
const activeProfileHostId = computed(
  () => (newSession.value ? (draftHostId.value ?? newSession.value.hostId) : null) ?? active.value?.hostId ?? hostFilter.value ?? hosts.value.find((h) => h.state === "connected")?.id ?? null,
);
let profilesLoadSeq = 0;
watch(
  () => (commandCenterOpen.value ? activeProfileHostId.value : null),
  (hid) => {
    if (!commandCenterOpen.value) return;
    const seq = ++profilesLoadSeq;
    if (!hid) {
      commandProfiles.value = [];
      return;
    }
    const hit = hostProfilesCache.get(hid);
    if (hit && Date.now() - hit.at < 120_000) {
      commandProfiles.value = hit.items;
      return;
    }
    // Clear previous host's profiles immediately so they cannot be applied to another host.
    commandProfiles.value = [];
    void api(`/hosts/${encodeURIComponent(hid)}/settings`)
      .then((r) => {
        const raw: Omit<AgentProfileItem, "hostId">[] = r?.features?.agentProfiles ? (r?.config?.agentProfiles ?? []) : [];
        const items: AgentProfileItem[] = raw.map((item) => ({ ...item, hostId: hid }));
        hostProfilesCache.set(hid, { at: Date.now(), items });
        if (seq === profilesLoadSeq && activeProfileHostId.value === hid) commandProfiles.value = items;
      })
      .catch(() => {
        if (seq === profilesLoadSeq) commandProfiles.value = [];
      });
  },
);

async function applyCommandProfile(p: AgentProfileItem) {
  if (newSession.value && newSessionRef.value && (draftHostId.value ?? newSession.value.hostId) === p.hostId) {
    await newSessionRef.value.applyProfile(p.id);
    return;
  }
  const a = active.value;
  if (a && a.hostId === p.hostId && a.provider === p.provider) {
    await action(async () => {
      if (p.model) await api(path(a) + "/config", "POST", { model: p.model });
      if (p.thinkingOptionId) await api(path(a) + "/config", "POST", { thinkingOptionId: p.thinkingOptionId });
      if (p.modeId) await api(path(a) + "/config", "POST", { modeId: p.modeId });
      showNotice(`Applied profile “${p.name}”.`);
    });
    return;
  }
  const sameHostRecent = allWorkspaces.value.find((w) => w.hostId === p.hostId);
  tab.value = "chat";
  selectedThread.value = null;
  selectedKey.value = null;
  newSession.value = {
    hostId: p.hostId,
    cwd: sameHostRecent?.rootPath ?? null,
    project: sameHostRecent
      ? { key: sameHostRecent.projectKey, name: sameHostRecent.project, projectId: sameHostRecent.projectId, iconRevision: sameHostRecent.projectIconRevision }
      : null,
    profileId: p.id,
  };
  openDetail();
}

async function rewindLatestFromCommandCenter() {
  const a = active.value;
  const modes = a?.rewind ?? [];
  if (!a || !modes.length) return;
  const latest = conversation.value?.latestRewindableMessage();
  if (!latest) {
    showNotice("No rewindable turn found in the loaded conversation.");
    return;
  }
  const mode: RewindMode = modes.includes("both") ? "both" : modes[0]!;
  const label = mode === "both" ? "conversation and files" : mode === "files" ? "files" : "conversation";
  const preview = latest.text.trim().slice(0, 120);
  const ok = await confirmAction({
    title: "Rewind latest turn?",
    message: `Rewind ${label} back to: “${preview}${latest.text.length > 120 ? "…" : ""}”`,
    confirmLabel: "Rewind",
    danger: mode !== "conversation",
  });
  if (ok) void rewindTo(latest.messageId, latest.text, mode);
}

const allWorkspaces = computed(() => {
  directory.version.value;
  return directory.range(0, directory.size);
});

const commandActions = computed<CommandAction[]>(() => {
  const list: CommandAction[] = [
    { id: "new-session", label: "New session", sub: "Start a new workspace conversation", icon: "plus", shortcut: "N", run: () => startNew() },
    { id: "import-session", label: "Import CLI session", sub: "Resume an existing Claude, Codex, Pi or Antigravity session", icon: "download", run: () => { importSessionOpen.value = true; } },
    { id: "add-project", label: "Add project", sub: "Open existing folder, clone from GitHub, or create new folder", icon: "folder", run: () => { addProjectOpen.value = true; } },
    { id: "archived", label: "Archived workspaces", sub: "View and restore archived workspaces", icon: "archive", run: () => { archivedOpen.value = true; } },
    { id: "board", label: "Open Kanban board", icon: "board", run: () => openTab("board") },
    { id: "schedules", label: "Open Schedules", icon: "clock", run: () => openTab("schedules") },
    { id: "hosts", label: "Manage Hosts", icon: "server", run: () => openTab("hosts") },
    { id: "settings", label: "Open Settings", icon: "gear", run: () => openTab("settings") },
    { id: "theme", label: "Cycle theme (System / Light / Dark)", icon: "sun", run: () => cycleTheme() },
  ];
  for (const p of commandProfiles.value) {
    const summary = [p.provider, p.model, p.modeId].filter(Boolean).join(" · ");
    list.push({
      id: "profile:" + p.id,
      label: `Profile › ${p.name}`,
      sub: summary || p.provider,
      icon: "sliders",
      run: () => void applyCommandProfile(p),
    });
  }
  if (newSession.value) {
    list.unshift(
      { id: "draft-model", label: "Switch model", sub: "Draft session", icon: "sparkle", shortcut: "⌘/", run: () => newSessionRef.value?.focusModel() },
      { id: "draft-thinking", label: "Cycle thinking level", sub: "Draft session", icon: "brain", shortcut: "⌘⇧/", run: () => newSessionRef.value?.cycleThinking() },
    );
  } else if (active.value) {
    const a = active.value;
    const t = activeThread.value;
    if (a.workspaceId) {
      list.unshift({ id: "new-agent", label: "New agent in workspace", sub: t?.name || a.project, icon: "bot", run: () => startNewAgentInWorkspace() });
    }
    if (threadAgents.value.length > 1) {
      list.push({ id: "close-agent", label: "Close current agent session", sub: a.title || a.provider, icon: "close", run: () => void closeAgent(a) });
    }
    if (a.rewind?.length) {
      list.unshift({ id: "rewind-latest", label: "Rewind latest turn", sub: a.title || a.provider, icon: "undo", run: () => void rewindLatestFromCommandCenter() });
    }
    list.unshift(
      { id: "model", label: "Switch model", sub: footerModel.value || a.provider, icon: "sparkle", shortcut: "⌘/", run: () => composerDock.value?.focusModel() },
      { id: "thinking", label: "Cycle thinking level", sub: a.thinking || "Default", icon: "brain", shortcut: "⌘⇧/", run: () => composerDock.value?.cycleThinking() },
      { id: "panel-files", label: "Toggle Files panel", icon: "folder", run: () => togglePanel("files") },
      { id: "panel-changes", label: "Toggle Changes panel", icon: "file", run: () => togglePanel("changes") },
      { id: "panel-search", label: "Search conversation", icon: "search", run: () => togglePanel("search") },
      { id: "terminal", label: "Open Terminal", icon: "terminal", run: () => tabs.openTerminal() },
    );
    if (t) {
      list.push(
        { id: "labels", label: "Manage workspace labels", sub: t.name, icon: "layers", run: () => { labelingThread.value = t; } },
        { id: "fork", label: "Fork conversation", sub: t.name, icon: "branch", run: () => void forkThread(t) },
        { id: "rename", label: "Rename workspace", sub: t.name, icon: "edit", run: () => { renaming.value = t; } },
        { id: "archive", label: "Archive workspace", sub: t.name, icon: "archive", run: () => void archiveThread(t) },
      );
    }
  }
  return list;
});

async function restoreArchivedWorkspace(hostId: string, workspaceId: string) {
  await action(async () => {
    await api(`/hosts/${encodeURIComponent(hostId)}/workspaces/${encodeURIComponent(workspaceId)}/restore`, "POST", {});
  });
}

function onGlobalKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  if (event.key === "Escape" && lightbox.value) {
    lightbox.value = null;
    return;
  }
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "k" && authenticated.value) {
    event.preventDefault();
    commandCenterOpen.value = !commandCenterOpen.value;
    return;
  }
  // Page shortcuts must not act behind a modal dialog.
  if (dialogOpen()) return;
  if (mod && (event.key === "/" || event.key === "?" || event.code === "Slash") && tab.value === "chat" && (active.value || newSession.value)) {
    event.preventDefault();
    if (newSession.value) {
      if (event.shiftKey) newSessionRef.value?.cycleThinking();
      else newSessionRef.value?.focusModel();
    } else {
      if (event.shiftKey) composerDock.value?.cycleThinking();
      else composerDock.value?.focusModel();
    }
    return;
  }
  if (mod && event.key.toLowerCase() === "z" && !event.shiftKey && !typing && archiveUndo.value) {
    event.preventDefault();
    void undoArchive();
    return;
  }
  if (event.key === "/" && !typing && !mod) {
    event.preventDefault();
    if (detailOpen.value && compact.matches) closeDetail();
    sidebar.value?.focusSearch();
  } else if (event.key === "n" && !typing && !mod && !event.altKey && authenticated.value && !newSession.value) {
    event.preventDefault();
    startNew();
  } else if (event.key === "Escape" && sidebar.value?.isSearchInput(target) && query.value) {
    query.value = "";
  }
}
window.addEventListener("keydown", onGlobalKey);

// New sessions: a draft conversation screen; nothing is created until the user sends.
const newSession = ref<{
  hostId: string | null;
  cwd: string | null;
  project: { key: string | null; name: string; projectId?: string; iconRevision?: string | null } | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  forkContext?: ForkContextResult | null;
  profileId?: string | null;
} | null>(null);
function startNew(group?: ProjectGroup<WorkspaceSummary>) {
  // Without a project, start where you worked last: the most recent thread in the current view.
  const recent = group ? group.items.at(0) : directory.range(0, 1)[0];
  const empty = !recent && group ? group.emptyProjects?.values().next().value : undefined;
  tab.value = "chat";
  selectedThread.value = null;
  selectedKey.value = null;
  newSession.value = {
    hostId: recent?.hostId ?? empty?.hostId ?? hostFilter.value ?? active.value?.hostId ?? null,
    cwd: recent?.rootPath ?? empty?.rootPath ?? null,
    project: recent
      ? { key: recent.projectKey, name: recent.project, projectId: recent.projectId, iconRevision: recent.projectIconRevision }
      : empty
        ? { key: empty.projectKey, name: empty.name, projectId: empty.projectId, iconRevision: empty.iconRevision }
        : null,
  };
  openDetail();
}
function startNewAgentInWorkspace() {
  const a = active.value;
  const t = activeThread.value;
  if (!a || !a.workspaceId) return;
  const cwd = workspaceCwd.value || a.cwd;
  tab.value = "chat";
  selectedThread.value = null;
  selectedKey.value = null;
  newSession.value = {
    hostId: a.hostId,
    cwd,
    project: t
      ? { key: t.projectKey, name: t.project, projectId: t.projectId, iconRevision: t.projectIconRevision }
      : { key: a.projectKey, name: a.project },
    workspaceId: a.workspaceId,
    workspaceName: t?.name || a.title || a.project,
  };
  openDetail();
}
async function closeAgent(a: AgentSummary) {
  const name = a.title || a.provider || "this session";
  const running = a.turnActive || a.attention;
  const message = running
    ? "This session is still active. Closing it archives the session and removes its tab; the host keeps its history."
    : "It leaves this workspace’s tabs; the host keeps its history.";
  if (!(await confirmAction({ title: `Close “${name}”?`, message, confirmLabel: "Close session", danger: running }))) return;
  await action(async () => {
    await api(path(a) + "/archive", "POST", {});
    if (selectedKey.value === a.key) {
      const next = threadAgents.value.find((other) => other.key !== a.key);
      if (next) selectedKey.value = next.key;
    }
  });
}
async function forkThread(thread: WorkspaceSummary) {
  const agent = agentDirectory.indexed(thread.key, 1)[0] ?? (active.value?.workspaceId === thread.id ? active.value : null);
  if (!agent) {
    error.value = "No active agent found to fork in this workspace.";
    return;
  }
  await action(async () => {
    const forkContext = (await api(path(agent) + "/fork-context", "POST", {}, 60_000)) as ForkContextResult;
    tab.value = "chat";
    selectedThread.value = null;
    selectedKey.value = null;
    newSession.value = {
      hostId: thread.hostId,
      cwd: thread.rootPath,
      project: { key: thread.projectKey, name: thread.project, projectId: thread.projectId, iconRevision: thread.projectIconRevision },
      workspaceName: thread.name,
      forkContext,
    };
    openDetail();
  });
}
function sendReviewToAgent(reviewPrompt: string) {
  prompt.value = prompt.value.trim() ? `${prompt.value.trim()}\n\n${reviewPrompt}` : reviewPrompt;
  void nextTick(autosize);
  showNotice("Review comments added to composer. Press Send when ready.");
}
function closeNewSession() {
  newSession.value = null;
  if (compact.matches) closeDetail();
}
function onCreated(created: { key: string; prompt: string; images: string[]; attachmentNames: string[]; messageId: string }) {
  if (created.prompt.trim() || created.images.length || created.attachmentNames.length) {
    const msgId = created.messageId || newId();
    composer.optimistic.add({
      messageId: msgId,
      agentKey: created.key,
      text: created.prompt,
      images: created.images,
      attachmentNames: created.attachmentNames,
      baselineSeqEnd: -1,
    });
    composer.optimistic.markSent(created.key, msgId);
  }
  newSession.value = null;
  if (query.value) query.value = "";
  select(created.key);
}
const pendingSelection = computed(() => (!!selectedKey.value || !!selectedThread.value) && !active.value);
const pendingSelectionMessages = computed(() => (selectedKey.value ? composer.optimistic.list(selectedKey.value) : []));

const pageForeground = ref(!document.hidden && document.hasFocus());
function syncForeground(leaving = false) {
  pageForeground.value = !leaving && !document.hidden && document.hasFocus();
}
const onWindowFocus = () => syncForeground();
const onWindowBlur = () => syncForeground(true);
const viewingConversation = computed(
  () =>
    authenticated.value &&
    pageForeground.value &&
    tab.value === "chat" &&
    (!isCompact.value || detailOpen.value) &&
    !activeFile.value &&
    !terminalActive.value,
);

// The sidebar's thread and project menus.
const {
  menu, renaming, openMenu, openHeaderMenu, renameThread, pinThread, markThreadUnread, markThreadRead, archiveThread, archiveThreads,
  archiveUndo, undoArchive, dismissArchiveUndo,
  projectPinned, applyProjectPins, pinProject, projectMenu, projectSettings, settingsProject, openProjectMenu, removeProject,
} = useThreadActions({ api, action, directory, selectedThread, selectedKey, activeThread, readyKey, viewingConversation, hostLabels, closeDetail });

// Opening a finished-but-unseen conversation marks it read, as the official app does.
let readSent = "";
watch(
  () => (viewingConversation.value && active.value && active.value.unread && readyKey.value === active.value.key ? active.value : null),
  (a) => {
    if (!a) {
      if (!active.value?.unread) readSent = "";
      return;
    }
    const marker = `${a.key}@${a.activityAt}`;
    if (readSent === marker) return;
    readSent = marker;
    void api(path(a) + "/read", "POST", {}).catch(() => (readSent = ""));
  },
);

// Usage across hosts, read while the app is visible (the server caches each host for 5 min).
const usage = shallowRef<UsageReport | null>(null);
const usageLoading = ref(false);
let usageTimer: ReturnType<typeof setInterval> | undefined;
let lastUsageAt = 0;
async function loadUsage(refresh = false) {
  if (!authenticated.value || document.hidden) return;
  usageLoading.value = true;
  try {
    usage.value = await api("/usage" + (refresh ? "?refresh=1" : ""));
    lastUsageAt = Date.now();
  } catch {
    // keep the last report
  } finally {
    usageLoading.value = false;
  }
}
function syncUsageTimer() {
  clearInterval(usageTimer);
  usageTimer = undefined;
  if (!authenticated.value || document.hidden) return;
  usageTimer = setInterval(() => void loadUsage(), 5 * 60_000);
}
const chatPaneVisible = computed(
  () =>
    tab.value === "chat" &&
    (!isCompact.value || detailOpen.value) &&
    ((!activeFile.value && !terminalActive.value) || panel.value === "subagents"),
);
/** The server's version, from the directory stream; this page was built as WEB_VERSION. */
const serverVersion = ref("");
const reloadPage = () => location.reload();

trackViewingPresence(() => authenticated.value && tab.value === "chat" &&
  (!isCompact.value || detailOpen.value) && !activeFile.value && !terminalActive.value
  ? active.value?.key ?? null : null, () => authenticated.value);

void loadAuth();
// Waiting sessions show on the app icon and in the tab title.
const waiting = computed(() => {
  agentDirectory.version.value;
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
function onVisibilityChange() {
  syncForeground();
  syncUsageTimer();
  if (!document.hidden && Date.now() - lastUsageAt >= 60_000) void loadUsage();
}
document.addEventListener("visibilitychange", onVisibilityChange);
window.addEventListener("focus", onWindowFocus);
window.addEventListener("blur", onWindowBlur);
window.addEventListener("pageshow", onWindowFocus);
window.addEventListener("pagehide", onWindowBlur);
onUnmounted(() => {
  clearInterval(usageTimer);
  navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
  compact.removeEventListener("change", onCompactChange);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("focus", onWindowFocus);
  window.removeEventListener("blur", onWindowBlur);
  window.removeEventListener("pageshow", onWindowFocus);
  window.removeEventListener("pagehide", onWindowBlur);
  window.removeEventListener("popstate", onPopState);
  window.removeEventListener("keydown", onGlobalKey);
  directoryStream?.close();
  clearTimeout(searchTimer);
});
</script>

<template>
  <LoginPage v-if="!authenticated" :auth-info="authInfo" :instance-label="instanceLabel" :busy="busy" :error="error" @login="login" />

  <div
    v-else
    class="shell"
    :class="{ 'detail-open': detailOpen, 'is-resizing': resizing }"
    :style="{ '--sidebar-w': sidebarWidth + 'px' }"
  >
    <Sidebar
      ref="sidebar"
      v-model:query="query"
      v-model:list-mode="listMode"
      v-model:host-filter="hostFilter"
      v-model:label-filter="labelFilter"
      :instance-name="instanceName"
      :hosts="hosts"
      :store="directory"
      :host-labels="hostLabels"
      :host-states="hostStates"
      :queues="queueSummary"
      :selected-thread="selectedThread"
      :usage="usage"
      :usage-loading="usageLoading"
      :directory-state="directoryState"
      :tab="tab"
      @select="selectThread"
      @new="startNew"
      @menu="openMenu"
      @project-menu="openProjectMenu"
      @open-tab="openTab"
      @refresh-usage="loadUsage(true)"
      @open-command-center="commandCenterOpen = true"
      @add-project="addProjectOpen = true"
      @open-archived="archivedOpen = true"
      @open-import-session="importSessionOpen = true"
      @archive-thread="archiveThread"
      @archive-threads="archiveThreads"
    >
      <div
        class="sidebar-resize"
        :class="{ 'is-dragging': resizing }"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        :aria-valuenow="sidebarWidth"
        :aria-valuemin="sidebarBounds.min"
        :aria-valuemax="sidebarBounds.max"
        tabindex="0"
        title="Drag to resize · double-click to reset"
        @pointerdown="startResize"
        @dblclick="setSidebarWidth(sidebarBounds.initial)"
        @keydown.left.prevent="setSidebarWidth(sidebarWidth - 16)"
        @keydown.right.prevent="setSidebarWidth(sidebarWidth + 16)"
      ></div>
    </Sidebar>

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
        @suggestions-changed="(on) => (suggestionsReady = on)"
      />

      <!-- Hosts -->
      <HostSettings v-else-if="tab === 'hosts' && settingsHost" :key="settingsHost.id" :host="settingsHost" :api="api" @back="settingsHost = null" />
      <HostsPage v-else-if="tab === 'hosts'" :hosts="hosts" :api="api" :action="action" :busy="busy" @back="closeDetail" @settings="(h) => (settingsHost = h)" />

      <SchedulesPage v-else-if="tab === 'schedules'" :hosts="hosts" :api="api" @back="closeDetail" @open-agent="select" />

      <!-- Kanban -->
      <KanbanPage
        v-else-if="tab === 'board'"
        v-model:board="board"
        :store="agentDirectory"
        :active="active"
        :host-labels="hostLabels"
        :api="api"
        :action="action"
        :busy="busy"
        @back="closeDetail"
        @open="select"
      />

      <!-- Conversation -->
      <div v-else-if="active" class="chat-split" :style="{ '--panel-w': panelWidth + 'px' }">
      <section class="chat">
        <ChatHeader
          :agent="active"
          :thread="activeThread"
          :host-label="hostLabels.get(active.hostId)"
          :show-host="hosts.length > 1"
          :parent="parentAgent"
          :subagents="subagentSummary"
          :agents="threadAgents"
          :selected-key="selectedKey"
          :tabs="tabs"
          :api="api"
          @back="closeDetail"
          @select="select"
          @select-agent="(key) => (selectedKey = key)"
          @close-agent="closeAgent"
          @subagents="openedSubagent = null; togglePanel('subagents')"
          @menu="openHeaderMenu"
          @new-agent="startNewAgentInWorkspace"
        />
        <TerminalPanel
          v-if="terminalOpen"
          v-show="terminalActive"
          :key="'t:' + active.hostId + ':' + workspaceCwd"
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
            :pane-active="chatPaneVisible"
            :api="api"
            :context="timelineContext"
            :host-label="hostLabels.get(active.hostId) ?? ''"
            :settled="markdownSettled"
            :footer-model="footerModel"
            :suggestions-ready="suggestionsReady"
            :optimistic="composer.optimistic"
            @error="(message) => (error = message)"
            @subagents="(key, list) => key === active?.key && (providerSubagents = list)"
            @background-work="(key, list) => key === active?.key && (backgroundWork = list)"
            @ready="(key) => key === active?.key && (readyKey = key)"
            @timeline-click="onTimelineClick"
            @unauthorized="signOut('ended')"
            @suggestion="offerSuggestion"
          />
        </KeepAlive>

        <ComposerDock
          ref="composerDock"
          v-show="!activeFile && !terminalActive"
          :composer="composer"
          :agent="active"
          :api="api"
          :busy="busy"
          :host-connected="hostStates.get(active.hostId) === 'connected'"
          :background-work="backgroundWork"
          @model="(label) => (footerModel = label)"
        />
      </section>
      <SidePanel
        v-if="panel"
        v-model:panel="panel"
        v-model:opened="openedSubagent"
        :agent="active"
        :cwd="workspaceCwd"
        :api="api"
        :agents="delegatedAgents"
        :subagents="providerSubagents"
        :has-subagents="!!subagentSummary"
        :active-path="activeFile"
        :reveal="reveal?.owner === tabOwner ? reveal : null"
        @close="panel = null"
        @jump="jumpSearch"
        @select="select"
        @open="openFile"
        @send-review="sendReviewToAgent"
      >
        <div
          class="panel-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          :aria-valuenow="panelWidth"
          :aria-valuemin="panelBounds.min"
          :aria-valuemax="panelBounds.max"
          tabindex="0"
          title="Drag to resize · double-click to reset"
          @pointerdown="startPanelResize"
          @dblclick="setPanelWidth(panelBounds.initial)"
          @keydown.left.prevent="setPanelWidth(panelWidth + 16)"
          @keydown.right.prevent="setPanelWidth(panelWidth - 16)"
        ></div>
      </SidePanel>
      </div>

      <!-- New session (draft conversation) -->
      <NewSession
        v-else-if="tab === 'chat' && newSession"
        ref="newSessionRef"
        :key="(newSession.hostId ?? '') + '\n' + (newSession.workspaceId ?? newSession.project?.key ?? newSession.cwd ?? '')"
        :hosts="hosts"
        :initial-host-id="newSession.hostId"
        :initial-cwd="newSession.cwd"
        :initial-project="newSession.project"
        :workspace-id="newSession.workspaceId ?? null"
        :workspace-name="newSession.workspaceName ?? null"
        :fork-context="newSession.forkContext ?? null"
        :initial-profile-id="newSession.profileId ?? null"
        :dictation-ready="dictationReady"
        :request="api"
        @host-change="(hid) => (draftHostId = hid)"
        @close="draftHostId = null; closeNewSession()"
        @created="onCreated"
      />

      <section v-else-if="tab === 'chat' && pendingSelection && pendingSelectionMessages.length" class="chat">
        <div class="timeline-wrap">
          <div class="timeline">
            <div class="timeline-inner">
              <div v-for="m in pendingSelectionMessages" :key="'opt:' + m.messageId" class="row row-user row-optimistic" :class="{ 'is-sending': m.status === 'sending' }">
                <div class="bubble" tabindex="-1">
                  <div v-if="m.images.length" class="user-images">
                    <img v-for="(url, index) in m.images" :key="url" :src="url" :alt="`Attached image ${index + 1}`" />
                  </div>
                  <div v-if="m.attachmentNames.length" class="optimistic-files">
                    <span v-for="(name, index) in m.attachmentNames" :key="index" class="optimistic-file">
                      <Icon name="file" :size="12" />{{ name }}
                    </span>
                  </div>{{ m.text }}
                </div>
                <div class="user-actions user-actions-status">
                  <span class="user-time">{{ m.status === "sending" ? "Sending…" : "Sent" }}</span>
                </div>
              </div>
              <div class="timeline-working" role="status" aria-label="Starting session">
                <span class="spinner spinner-ticked"></span>
                <span>Starting session…</span>
              </div>
            </div>
          </div>
        </div>
      </section>

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
      @labels="(t) => (labelingThread = t)"
      @fork="forkThread"
      @select-multiple="(t) => sidebar?.enterSelect(t)"
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
    <CommandCenter
      v-if="commandCenterOpen"
      :workspaces="allWorkspaces"
      :hosts="hosts"
      :active-agent="active"
      :actions="commandActions"
      :api="api"
      @close="commandCenterOpen = false"
      @select-workspace="selectThread"
      @open-file="openFile"
      @restore-archived="restoreArchivedWorkspace"
    />
    <ArchivedWorkspaces
      v-if="archivedOpen"
      :hosts="hosts"
      :api="api"
      @close="archivedOpen = false"
    />
    <AddProjectDialog
      v-if="addProjectOpen"
      :hosts="hosts"
      :initial-host-id="hostFilter ?? active?.hostId ?? null"
      :api="api"
      @close="addProjectOpen = false"
    />
    <ImportSessionDialog
      v-if="importSessionOpen"
      :hosts="hosts"
      :initial-host-id="hostFilter ?? active?.hostId ?? null"
      :api="api"
      @close="importSessionOpen = false"
      @imported="(key) => select(key)"
    />
    <LabelsDialog
      v-if="labelingThread"
      :thread="labelingThread"
      :api="api"
      @close="labelingThread = null"
    />
    <div v-if="archiveUndo?.length" class="undo-toast" role="status" aria-live="polite">
      <span>{{ archiveUndo.length === 1 ? `Archived “${archiveUndo[0]!.name}”` : `Archived ${archiveUndo.length} workspaces` }}</span>
      <button type="button" class="btn btn-sm btn-primary" @click="undoArchive">Undo</button>
      <button type="button" class="icon-btn" aria-label="Dismiss" @click="dismissArchiveUndo"><Icon name="close" :size="13" /></button>
    </div>
  </div>
  <ConfirmDialog v-if="confirmRequest" :key="confirmRequest.id" :request="confirmRequest" />
</template>
