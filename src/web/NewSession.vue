<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { CheckoutWorktreeOption, HostState, ProjectOption, ProviderOption } from "../shared/wire.ts";
import { prefs as uiPrefs } from "./preferences.ts";
import DictationButton from "./DictationButton.vue";
import Icon from "./Icon.vue";
import ProjectIcon, { type ProjectIconSource } from "./ProjectIcon.vue";
import ProviderIcon from "./ProviderIcon.vue";
import { tildeHome } from "./format.ts";
import { newId } from "./id.ts";
import { safeGetItem, safeSetItem } from "./safe-storage.ts";

const props = defineProps<{
  hosts: HostState[];
  initialHostId: string | null;
  initialCwd: string | null;
  /** Project to preselect, matched against the host's projects by key, then by name. */
  initialProject: { key: string | null; name: string; projectId?: string; iconRevision?: string | null } | null;
  /** When set, adds a new agent inside this existing workspace instead of creating a new one. */
  workspaceId?: string | null;
  workspaceName?: string | null;
  dictationReady: boolean;
  request: (path: string, method?: string, body?: unknown, timeoutMs?: number) => Promise<any>;
}>();
const emit = defineEmits<{ close: []; created: [key: string] }>();

const CUSTOM = "\u0000custom";
const PREFS = "litepaseo-new-session";
type Prefs = Record<string, { provider?: string; model?: string; thinking?: string; mode?: string }>;
const prefs: Prefs = (() => {
  try {
    return JSON.parse(safeGetItem(PREFS) ?? "{}") as Prefs;
  } catch {
    return {};
  }
})();
const coarsePointer = matchMedia("(pointer: coarse)").matches;

const connected = computed(() => props.hosts.filter((h) => h.state === "connected"));
const hostId = ref(
  connected.value.find((h) => h.id === props.initialHostId)?.id ?? connected.value[0]?.id ?? "",
);
const providers = ref<ProviderOption[] | null>(null);
const profiles = ref<any[]>([]);
const featureValues = ref<Record<string, unknown>>({});
let profileSelection = 0;

async function applyProfile(id: string) {
  if (!id) return;
  const p = profiles.value.find((item) => item.id === id);
  if (!p) return;
  if (!providers.value?.some((item) => item.id === p.provider)) {
    error.value = "This profile's provider is unavailable on this host.";
    return;
  }
  const selection = ++profileSelection, host = hostId.value;
  provider.value = p.provider;
  await nextTick();
  if (selection !== profileSelection || host !== hostId.value) return;
  model.value = p.model ?? models.value.find((m) => m.isDefault)?.id ?? models.value[0]?.id ?? "";
  await nextTick();
  if (selection !== profileSelection || host !== hostId.value) return;
  mode.value = p.modeId ?? selectedProvider.value?.defaultModeId ?? "";
  thinking.value = p.thinkingOptionId ?? selectedModel.value?.defaultThinkingId ?? "";
  featureValues.value = { ...p.featureValues };
}

const projects = ref<ProjectOption[] | null>(null);
const loadError = ref("");
const project = ref<string>("");
const customPath = ref("");
const provider = ref("");
const model = ref("");
const thinking = ref("");
const mode = ref("");
const useWorktree = ref(false);
const worktreeKind = ref<"new" | "existing">("new");
const branch = ref("");
const existingWorktrees = ref<CheckoutWorktreeOption[]>([]);
const selectedWorktreePath = ref("");
const loadingWorktrees = ref(false);

async function loadWorktrees() {
  if (!hostId.value || !cwd.value || props.workspaceId) return;
  loadingWorktrees.value = true;
  try {
    const list = (await props.request(
      `/hosts/${encodeURIComponent(hostId.value)}/worktrees?cwd=${encodeURIComponent(cwd.value)}`,
    )) as CheckoutWorktreeOption[];
    existingWorktrees.value = Array.isArray(list) ? list : [];
    if (!existingWorktrees.value.some((w) => w.path === selectedWorktreePath.value)) {
      selectedWorktreePath.value = existingWorktrees.value.find((w) => !w.containsCwd)?.path ?? existingWorktrees.value[0]?.path ?? "";
    }
  } catch {
    existingWorktrees.value = [];
  } finally {
    loadingWorktrees.value = false;
  }
}

watch([useWorktree, worktreeKind, hostId, () => cwd.value], ([use, kind]) => {
  if (use && kind === "existing") void loadWorktrees();
});
const prompt = ref("");
const busy = ref(false);
const error = ref("");
const notice = ref("");
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function showNotice(text: string) {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 6000);
}

const promptElement = ref<HTMLTextAreaElement | null>(null);
const dictationPreview = ref("");
const dictationPreviewElement = ref<HTMLDivElement | null>(null);
watch(
  dictationPreview,
  () => {
    const el = dictationPreviewElement.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
  { flush: "post" },
);

/** Reused for retries of the same request; any edit makes a new request with a new key. */
let idempotencyKey = newId();

const selectedHost = computed(() => connected.value.find((h) => h.id === hostId.value));
const selectedProvider = computed(() => providers.value?.find((p) => p.id === provider.value));
const models = computed(() => selectedProvider.value?.models ?? []);
const selectedModel = computed(() => models.value.find((m) => m.id === model.value));
const thinkingOptions = computed(() => selectedModel.value?.thinking ?? []);
const thinkingLabel = computed(() => thinkingOptions.value.find((t) => t.id === thinking.value)?.label ?? thinking.value ?? "Default");
const modes = computed(() => selectedProvider.value?.modes ?? []);
const modeLabel = computed(() => modes.value.find((m) => m.id === mode.value)?.label ?? "Mode");
const fullAccess = computed(() => /full|bypass|danger|unrestricted/i.test(`${mode.value} ${modeLabel.value}`));

const cwd = computed(() => (project.value === CUSTOM ? customPath.value.trim() : project.value));
const projectName = computed(
  () =>
    projects.value?.find((p) => p.rootPath === project.value)?.name ??
    (project.value === "" && hostId.value === props.initialHostId ? props.initialProject?.name : undefined) ??
    cwd.value.replace(/\/+$/, "").split("/").pop() ??
    "",
);
const iconSource = computed<ProjectIconSource | null>(() => {
  if (!hostId.value || !cwd.value) return null;
  const isInitial = hostId.value === props.initialHostId && cwd.value === props.initialCwd;
  return {
    hostId: hostId.value,
    rootPath: cwd.value,
    ...(isInitial && props.initialProject?.projectId
      ? { projectId: props.initialProject.projectId, projectIconRevision: props.initialProject.iconRevision ?? null }
      : {}),
  };
});

const canCreate = computed(
  () =>
    !!hostId.value &&
    !!cwd.value &&
    !!provider.value &&
    !!prompt.value.trim() &&
    !busy.value &&
    (!!props.workspaceId || !useWorktree.value || (worktreeKind.value === "new" ? !!branch.value.trim() : !!selectedWorktreePath.value)),
);

function autosize() {
  const el = promptElement.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + "px";
}

function insertDictation(text: string) {
  const el = promptElement.value;
  const current = prompt.value;
  const start = el && document.activeElement === el ? el.selectionStart : current.length;
  const end = el && document.activeElement === el ? el.selectionEnd : current.length;
  const before = current.slice(0, start),
    after = current.slice(end);
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

async function load(id: string) {
  ++profileSelection;
  providers.value = projects.value = null;
  profiles.value = [];
  featureValues.value = {};
  loadError.value = "";
  if (!id) return;
  void props
    .request(`/hosts/${encodeURIComponent(id)}/settings`)
    .then((r) => {
      if (id === hostId.value) profiles.value = r.features.agentProfiles ? r.config.agentProfiles ?? [] : [];
    })
    .catch(() => {});
  try {
    const [p, j] = await Promise.all([
      props.request(`/hosts/${encodeURIComponent(id)}/providers`),
      props.request(`/hosts/${encodeURIComponent(id)}/projects`),
    ]);
    if (id !== hostId.value) return;
    providers.value = p;
    projects.value = (j as ProjectOption[]).sort((a, b) => a.name.localeCompare(b.name));
    applyPrefs();
    const list = projects.value!;
    const wanted = id === props.initialHostId ? props.initialProject : null;
    const match = wanted
      ? (list.find((x) => wanted.key && x.key === wanted.key) ??
        list.find((x) => x.name.toLowerCase() === wanted.name.toLowerCase()))
      : undefined;
    if (match) project.value = match.rootPath;
    else if (id === props.initialHostId && props.initialCwd) {
      const exact = list.find((x) => x.rootPath === props.initialCwd);
      if (exact) project.value = exact.rootPath;
      else {
        project.value = CUSTOM;
        customPath.value = props.initialCwd;
      }
    } else if (!project.value) project.value = list[0]?.rootPath ?? CUSTOM;
  } catch (e) {
    if (id === hostId.value) loadError.value = (e as Error).message;
  }
}

function applyPrefs() {
  const saved = prefs[hostId.value] ?? {};
  const list = providers.value ?? [];
  const chosen =
    list.find((p) => p.id === saved.provider && p.status !== "error") ??
    list.find((p) => p.status === "ready") ??
    list[0];
  provider.value = chosen?.id ?? "";
  pickModel(saved.model, saved.thinking);
  mode.value = chosen?.modes.some((m) => m.id === saved.mode) ? saved.mode! : (chosen?.defaultModeId ?? "");
}

function pickModel(preferred?: string, preferredThinking?: string) {
  const list = models.value;
  const chosen = list.find((m) => m.id === preferred) ?? list.find((m) => m.isDefault) ?? list[0];
  model.value = chosen?.id ?? "";
  thinking.value = chosen?.thinking.some((t) => t.id === preferredThinking)
    ? preferredThinking!
    : (chosen?.defaultThinkingId ?? "");
}

watch(hostId, (id) => {
  project.value = "";
  void load(id);
});
watch(provider, () => {
  featureValues.value = {};
  const saved = prefs[hostId.value];
  pickModel(saved?.provider === provider.value ? saved.model : undefined);
  const p = selectedProvider.value;
  if (p && !p.modes.some((m) => m.id === mode.value)) mode.value = p.defaultModeId ?? "";
});
watch(model, () => {
  const m = selectedModel.value;
  if (m && !m.thinking.some((t) => t.id === thinking.value)) thinking.value = m.defaultThinkingId ?? "";
});
watch([hostId, project, customPath, provider, model, thinking, mode, featureValues, useWorktree, worktreeKind, branch, selectedWorktreePath, prompt], () => {
  if (error.value) idempotencyKey = newId();
  error.value = "";
});

async function create() {
  if (!canCreate.value) return;
  busy.value = true;
  error.value = "";
  const effectiveCwd = !props.workspaceId && useWorktree.value && worktreeKind.value === "existing"
    ? selectedWorktreePath.value
    : cwd.value;
  try {
    const result = await props.request(
      `/hosts/${encodeURIComponent(hostId.value)}/agents`,
      "POST",
      {
        idempotencyKey,
        cwd: effectiveCwd,
        provider: provider.value,
        ...(props.workspaceId ? { workspaceId: props.workspaceId } : {}),
        ...(Object.keys(featureValues.value).length ? { featureValues: featureValues.value } : {}),
        ...(model.value ? { model: model.value } : {}),
        ...(mode.value ? { modeId: mode.value } : {}),
        ...(thinking.value ? { thinkingOptionId: thinking.value } : {}),
        prompt: prompt.value,
        ...(!props.workspaceId && useWorktree.value && worktreeKind.value === "new" ? { worktreeBranch: branch.value.trim() } : {}),
      },
      120_000,
    );
    prefs[hostId.value] = { provider: provider.value, model: model.value, thinking: thinking.value, mode: mode.value };
    safeSetItem(PREFS, JSON.stringify(prefs));
    emit("created", result.key);
  } catch (e) {
    // Keep the key: retrying the identical request is deduplicated by the daemon.
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function onKey(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.isComposing) return;
  const mod = event.metaKey || event.ctrlKey;
  const enterSends = !coarsePointer && uiPrefs.sendShortcut === "enter" && !event.shiftKey;
  if (enterSends || mod) {
    event.preventDefault();
    void create();
  }
}

onMounted(() => {
  void load(hostId.value);
  void nextTick(() => {
    autosize();
    promptElement.value?.focus();
  });
});
</script>

<template>
  <section class="chat new-session" aria-label="New session">
    <header class="chat-head">
      <button type="button" class="icon-btn back" aria-label="Back to sessions" :disabled="busy" @click="emit('close')">
        <Icon name="back" :size="18" />
      </button>
      <ProjectIcon v-if="projectName" :name="projectName" :source="iconSource" :size="20" />
      <h1 class="chat-title">{{ workspaceId ? "New agent" : "New session" }}</h1>
      <span v-if="projectName" class="chat-context hide-sm" :title="[projectName, selectedHost?.label, cwd].filter(Boolean).join(' · ')">
        {{ projectName }}<template v-if="connected.length > 1 && selectedHost"> · {{ selectedHost.label }}</template>
      </span>
      <span class="grow"></span>
      <button type="button" class="icon-btn head-tool" aria-label="Close new session" title="Close" :disabled="busy" @click="emit('close')">
        <Icon name="close" :size="16" />
      </button>
    </header>

    <div class="new-session-body">
      <div v-if="!connected.length" class="new-session-card">
        <p class="sheet-note">No connected hosts. Connect a host first.</p>
      </div>
      <div v-else class="new-session-card">
        <ProjectIcon v-if="projectName" :name="projectName" :source="iconSource" :size="44" />
        <div v-else class="empty-mark"><Icon name="chat" :size="24" /></div>
        <h2>{{ workspaceId ? (workspaceName || projectName || "New agent") : (projectName || "New session") }}</h2>
        <p v-if="cwd && project !== CUSTOM" class="new-session-path" :title="cwd">
          <Icon name="folder" :size="13" />{{ tildeHome(cwd) }}
        </p>

        <div v-if="!workspaceId" class="new-session-targets">
          <label v-if="connected.length > 1" class="target-chip" :title="'Host: ' + (selectedHost?.label ?? '')">
            <Icon name="server" :size="14" />
            <span class="target-text">{{ selectedHost?.label ?? "Host" }}</span>
            <Icon name="chevron" :size="11" class="target-caret" />
            <select v-model="hostId" aria-label="Host" :disabled="busy">
              <option v-for="h in connected" :key="h.id" :value="h.id">{{ h.label }}</option>
            </select>
          </label>
          <label class="target-chip" :title="projectName ? 'Project: ' + projectName : 'Project'">
            <Icon name="folder" :size="14" />
            <span class="target-text">{{ !projects ? "Loading…" : project === CUSTOM ? "Another folder…" : projectName || "Project" }}</span>
            <Icon name="chevron" :size="11" class="target-caret" />
            <select v-model="project" aria-label="Project" :disabled="busy || !projects">
              <option v-if="!projects" value="">Loading…</option>
              <option v-for="p in projects ?? []" :key="p.key" :value="p.rootPath">{{ p.name }}</option>
              <option :value="CUSTOM">Another folder…</option>
            </select>
          </label>
          <button
            type="button"
            class="target-chip target-toggle"
            :class="{ chosen: useWorktree }"
            :aria-pressed="useWorktree"
            :disabled="busy"
            title="Work in a new git worktree"
            @click="useWorktree = !useWorktree"
          >
            <Icon name="branch" :size="14" />
            <span>Worktree</span>
          </button>
        </div>

        <input
          v-if="project === CUSTOM"
          v-model="customPath"
          class="new-session-input"
          :aria-label="'Folder on ' + (selectedHost?.label ?? 'host')"
          placeholder="/home/me/code/project"
          autocomplete="off"
          spellcheck="false"
          :disabled="busy"
        />
        <div v-if="!workspaceId && useWorktree" class="new-session-worktree">
          <div class="segmented segmented-sm" role="radiogroup" aria-label="Worktree source">
            <button type="button" role="radio" :aria-checked="worktreeKind === 'new'" :class="{ chosen: worktreeKind === 'new' }" @click="worktreeKind = 'new'">New branch</button>
            <button type="button" role="radio" :aria-checked="worktreeKind === 'existing'" :class="{ chosen: worktreeKind === 'existing' }" @click="worktreeKind = 'existing'">Existing worktree</button>
          </div>
          <input
            v-if="worktreeKind === 'new'"
            v-model="branch"
            class="new-session-input"
            aria-label="New branch"
            placeholder="feature/my-change"
            autocomplete="off"
            spellcheck="false"
            :disabled="busy"
          />
          <select
            v-else
            v-model="selectedWorktreePath"
            class="new-session-input"
            aria-label="Existing worktree"
            :disabled="busy || loadingWorktrees || !existingWorktrees.length"
          >
            <option v-if="loadingWorktrees" value="">Loading worktrees…</option>
            <option v-else-if="!existingWorktrees.length" value="">No existing worktrees found</option>
            <option v-for="wt in existingWorktrees" :key="wt.path" :value="wt.path">
              {{ wt.branchName || "(detached)" }} — {{ tildeHome(wt.path) }}
            </option>
          </select>
        </div>
      </div>
    </div>

    <div v-if="connected.length" class="dock">
      <div class="dock-inner">
        <p v-if="notice" class="composer-notice" role="status">
          <Icon name="alert" :size="13" />{{ notice }}
          <button type="button" class="icon-btn" aria-label="Dismiss" @click="notice = ''"><Icon name="close" :size="12" /></button>
        </p>
        <p v-if="loadError" class="composer-notice is-warn" role="alert"><Icon name="alert" :size="13" />{{ loadError }}</p>
        <p v-if="selectedProvider?.error" class="composer-notice is-warn" role="alert"><Icon name="alert" :size="13" />{{ selectedProvider.error }}</p>
        <p v-if="error" class="composer-notice is-warn" role="alert"><Icon name="alert" :size="13" />{{ error }}</p>

        <form class="composer" @submit.prevent="create">
          <div v-if="dictationPreview" ref="dictationPreviewElement" class="dictation-preview" role="status" aria-live="polite">
            {{ dictationPreview }}
          </div>
          <textarea
            ref="promptElement"
            v-model="prompt"
            rows="1"
            aria-label="First message"
            :placeholder="projectName ? `Message ${projectName}…` : 'What should the agent do?'"
            :disabled="busy"
            @input="autosize"
            @keydown="onKey"
          ></textarea>
          <div class="composer-bar">
            <div class="agent-controls">
              <label
                class="chip"
                :class="{ 'is-disabled': busy || !providers }"
                :title="'Agent: ' + (selectedProvider?.label ?? 'Loading…')"
              >
                <ProviderIcon v-if="provider" :provider="provider" />
                <Icon v-else name="bot" :size="16" />
                <span class="chip-text">{{ selectedProvider?.label ?? (providers ? "Agent" : "Loading…") }}</span>
                <Icon name="chevron" :size="11" class="chip-caret" />
                <select v-model="provider" aria-label="Agent" :disabled="busy || !providers">
                  <option v-if="!providers" value="">Loading…</option>
                  <option v-for="p in providers ?? []" :key="p.id" :value="p.id" :disabled="p.status === 'error'">
                    {{ p.label }}{{ p.status === "loading" ? " (starting)" : p.status === "error" ? " (error)" : "" }}
                  </option>
                </select>
              </label>

              <label
                class="chip"
                :class="{ 'is-disabled': busy || !models.length }"
                :title="'Model: ' + (selectedModel?.label ?? 'Default')"
              >
                <span class="chip-text">{{ selectedModel?.label ?? "Default" }}</span>
                <Icon name="chevron" :size="11" class="chip-caret" />
                <select v-model="model" aria-label="Model" :disabled="busy || !models.length">
                  <option v-if="!models.length" value="">Default</option>
                  <option v-for="m in models" :key="m.id" :value="m.id">{{ m.label }}</option>
                </select>
              </label>

              <label
                v-if="thinkingOptions.length"
                class="chip"
                :class="{ 'is-disabled': busy }"
                :title="'Thinking: ' + thinkingLabel"
              >
                <Icon name="brain" :size="18" />
                <span class="chip-text">{{ thinkingLabel }}</span>
                <Icon name="chevron" :size="11" class="chip-caret" />
                <select v-model="thinking" aria-label="Thinking" :disabled="busy">
                  <option v-for="t in thinkingOptions" :key="t.id" :value="t.id">{{ t.label }}</option>
                </select>
              </label>

              <label
                v-if="modes.length"
                class="chip"
                :class="{ 'is-disabled': busy }"
                :title="'Mode: ' + modeLabel"
              >
                <Icon :name="fullAccess ? 'shield-off' : 'shield'" :size="18" />
                <span class="chip-text">{{ modeLabel }}</span>
                <Icon name="chevron" :size="11" class="chip-caret" />
                <select v-model="mode" aria-label="Mode" :disabled="busy">
                  <option v-for="m in modes" :key="m.id" :value="m.id" :title="m.description">{{ m.label }}</option>
                </select>
              </label>

              <label
                v-if="profiles.length"
                class="chip"
                :class="{ 'is-disabled': busy }"
                title="Apply agent profile"
              >
                <Icon name="sliders" :size="15" />
                <span class="chip-text">Profile</span>
                <Icon name="chevron" :size="11" class="chip-caret" />
                <select
                  aria-label="Apply agent profile"
                  :disabled="busy"
                  value=""
                  @change="applyProfile(($event.target as HTMLSelectElement).value)"
                >
                  <option value="">Choose profile…</option>
                  <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
              </label>
            </div>

            <div class="composer-actions">
              <DictationButton
                v-if="dictationReady"
                :disabled="busy"
                @text="insertDictation"
                @preview="dictationPreview = $event"
                @notice="showNotice"
              />
              <button
                class="disc disc-send"
                aria-label="Start session"
                :title="busy ? 'Starting…' : error ? 'Retry' : 'Start session (Enter) · Shift+Enter for a new line'"
                :disabled="!canCreate"
              >
                <span v-if="busy" class="spinner spinner-sm spinner-on-accent"></span>
                <Icon v-else name="send" :size="17" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<style scoped>
.new-session-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  place-items: center;
  padding: 24px;
}
.new-session-card {
  width: min(520px, 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
}
.new-session-card h2 {
  margin: 4px 0 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.new-session-path {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  margin: 0;
  font: 12.5px/1.4 var(--mono);
  color: var(--fg-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.new-session-targets {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
}
.target-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  max-width: 240px;
  padding: 0 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-1);
  color: var(--fg-muted);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.target-chip:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.target-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
.target-caret {
  flex: none;
  transform: rotate(90deg);
  opacity: 0.7;
}
.target-chip select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: inherit;
  font-size: 16px;
}
.target-toggle.chosen {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: var(--accent-soft);
  color: var(--accent);
}
@media (hover: hover) {
  .target-chip:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .target-toggle.chosen:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }
}
.new-session-input {
  width: min(380px, 100%);
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-1);
  color: var(--fg);
  font: 13px/1.4 var(--mono);
}
.new-session-input:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

/* Composer chips: identical to AgentControls.vue */
.agent-controls {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.agent-controls::-webkit-scrollbar {
  display: none;
}
.chip {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  max-width: 220px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 400;
  color: var(--fg-muted);
  cursor: pointer;
  white-space: nowrap;
}
.chip :deep(.icon) {
  flex-shrink: 0;
}
.chip:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip-caret {
  flex: none;
  transform: rotate(90deg);
  opacity: 0.7;
}
@media (hover: hover) {
  .chip:hover:not(.is-disabled) {
    background: var(--hover);
    color: var(--fg);
  }
}
.chip.is-disabled {
  cursor: default;
  opacity: 0.6;
}
.chip select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: inherit;
  font-size: 16px;
}
</style>
