<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { HostState, ProjectOption, ProviderOption } from "../shared/wire.ts";
import Icon from "./Icon.vue";
import { useDialog } from "./use-dialog.ts";
import { newId } from "./id.ts";
import { safeGetItem, safeSetItem } from "./safe-storage.ts";

const props = defineProps<{
  hosts: HostState[];
  initialHostId: string | null;
  initialCwd: string | null;
  /** Project to preselect, matched against the host's projects by key, then by name. */
  initialProject: { key: string | null; name: string } | null;
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

const connected = computed(() => props.hosts.filter((h) => h.state === "connected"));
const hostId = ref(
  connected.value.find((h) => h.id === props.initialHostId)?.id ?? connected.value[0]?.id ?? "",
);
const providers = ref<ProviderOption[] | null>(null);
const profiles = ref<any[]>([]);
const featureValues = ref<Record<string, unknown>>({});
let profileSelection = 0;
async function applyProfile(id: string) {
  const p = profiles.value.find(p => p.id === id);
  if (!p) return;
  if (!providers.value?.some(provider => provider.id === p.provider)) {
    error.value = "This profile's provider is unavailable on this host.";
    return;
  }
  const selection = ++profileSelection, host = hostId.value;
  provider.value = p.provider;
  await nextTick();
  if (selection !== profileSelection || host !== hostId.value) return;
  model.value = p.model ?? models.value.find(m => m.isDefault)?.id ?? models.value[0]?.id ?? "";
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
const branch = ref("");
const prompt = ref("");
const busy = ref(false);
const error = ref("");
const promptElement = ref<HTMLTextAreaElement | null>(null);
/** Reused for retries of the same request; any edit makes a new request with a new key. */
let idempotencyKey = newId();

const selectedProvider = computed(() => providers.value?.find((p) => p.id === provider.value));
const models = computed(() => selectedProvider.value?.models ?? []);
const selectedModel = computed(() => models.value.find((m) => m.id === model.value));
const cwd = computed(() => (project.value === CUSTOM ? customPath.value.trim() : project.value));
const projectName = computed(
  () => projects.value?.find((p) => p.rootPath === project.value)?.name ?? cwd.value.split("/").pop() ?? "",
);
const canCreate = computed(
  () => !!hostId.value && !!cwd.value && !!provider.value && !busy.value && (!useWorktree.value || !!branch.value.trim()),
);

async function load(id: string) {
  ++profileSelection;
  providers.value = projects.value = null; profiles.value = []; featureValues.value = {};
  void props.request(`/hosts/${encodeURIComponent(id)}/settings`).then(r => { if (id === hostId.value) profiles.value = r.features.agentProfiles ? r.config.agentProfiles ?? [] : []; }).catch(() => {});
  loadError.value = "";
  if (!id) return;
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
  const chosen = list.find((p) => p.id === saved.provider && p.status !== "error") ?? list.find((p) => p.status === "ready") ?? list[0];
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
watch([hostId, project, customPath, provider, model, thinking, mode, featureValues, useWorktree, branch, prompt], () => {
  if (error.value) idempotencyKey = newId();
  error.value = "";
});

async function create() {
  if (!canCreate.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await props.request(
      `/hosts/${encodeURIComponent(hostId.value)}/agents`,
      "POST",
      {
        idempotencyKey,
        cwd: cwd.value,
        provider: provider.value,
        ...(Object.keys(featureValues.value).length ? { featureValues: featureValues.value } : {}),
        ...(model.value ? { model: model.value } : {}),
        ...(mode.value ? { modeId: mode.value } : {}),
        ...(thinking.value ? { thinkingOptionId: thinking.value } : {}),
        ...(prompt.value.trim() ? { prompt: prompt.value } : {}),
        ...(useWorktree.value ? { worktreeBranch: branch.value.trim() } : {}),
      },
      120_000,
    );
    prefs[hostId.value] = { provider: provider.value, model: model.value, thinking: thinking.value, mode: mode.value };
    // Preferences are a convenience: a full or blocked storage must not fail a created session.
    safeSetItem(PREFS, JSON.stringify(prefs));
    emit("created", result.key);
  } catch (e) {
    // Keep the key: retrying the identical request is deduplicated by the daemon.
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

const sheet = ref<HTMLElement | null>(null);
useDialog(sheet, () => !busy.value && emit("close"));
function onKey(event: KeyboardEvent) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void create();
  }
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  void load(hostId.value);
  void nextTick(() => promptElement.value?.focus());
});
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="overlay" @mousedown.self="!busy && emit('close')">
    <form ref="sheet" class="sheet" role="dialog" aria-modal="true" aria-label="New session" tabindex="-1" @submit.prevent="create">
      <header class="sheet-head">
        <h2>New session</h2>
        <button type="button" class="icon-btn" aria-label="Close" :disabled="busy" @click="emit('close')">
          <Icon name="close" :size="16" />
        </button>
      </header>

      <div class="sheet-body">
        <p v-if="!connected.length" class="sheet-note">No connected hosts. Connect a host first.</p>
        <template v-else>
          <div class="field-grid">
            <label class="field">
              <span>Host</span>
              <select v-model="hostId" :disabled="busy">
                <option v-for="h in connected" :key="h.id" :value="h.id">{{ h.label }}</option>
              </select>
            </label>
            <label class="field">
              <span>Project</span>
              <select v-model="project" :disabled="busy || !projects">
                <option v-if="!projects" value="">Loading…</option>
                <option v-for="p in projects ?? []" :key="p.key" :value="p.rootPath">{{ p.name }}</option>
                <option :value="CUSTOM">Another folder…</option>
              </select>
            </label>
          </div>
          <label v-if="project === CUSTOM" class="field">
            <span>Folder on {{ connected.find((h) => h.id === hostId)?.label }}</span>
            <input v-model="customPath" placeholder="/home/me/code/project" autocomplete="off" spellcheck="false" />
          </label>
          <p v-else-if="cwd" class="path-hint" :title="cwd"><Icon name="folder" :size="13" />{{ cwd }}</p>

          <label class="field">
            <span>First message</span>
            <textarea
              ref="promptElement"
              v-model="prompt"
              rows="5"
              :placeholder="projectName ? `What should the agent do in ${projectName}?` : 'What should the agent do?'"
              :disabled="busy"
            ></textarea>
          </label>
          <div class="field-grid three">
            <label v-if="profiles.length" class="field"><span>Apply agent profile</span><select :disabled="busy" value="" @change="applyProfile(($event.target as HTMLSelectElement).value)"><option value="">Choose profile…</option><option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
            <label class="field field-agent">
              <span>Agent</span>
              <select v-model="provider" :disabled="busy || !providers">
                <option v-if="!providers" value="">Loading…</option>
                <option v-for="p in providers ?? []" :key="p.id" :value="p.id" :disabled="p.status === 'error'">
                  {{ p.label }}{{ p.status === "loading" ? " (starting)" : p.status === "error" ? " (error)" : "" }}
                </option>
              </select>
            </label>
            <label class="field field-model">
              <span>Model</span>
              <select v-model="model" :disabled="busy || !models.length">
                <option v-if="!models.length" value="">Default</option>
                <option v-for="m in models" :key="m.id" :value="m.id">{{ m.label }}</option>
              </select>
            </label>
            <label class="field field-thinking">
              <span>Thinking</span>
              <select v-model="thinking" :disabled="busy || !selectedModel?.thinking.length">
                <option v-if="!selectedModel?.thinking.length" value="">Default</option>
                <option v-for="t in selectedModel?.thinking ?? []" :key="t.id" :value="t.id">{{ t.label }}</option>
              </select>
            </label>
          </div>
          <label v-if="selectedProvider?.modes.length" class="field">
            <span>Mode</span>
            <select v-model="mode" :disabled="busy">
              <option v-for="m in selectedProvider.modes" :key="m.id" :value="m.id">{{ m.label }}</option>
            </select>
          </label>

          <label class="toggle">
            <input v-model="useWorktree" type="checkbox" :disabled="busy" />
            <span>Work in a new git worktree</span>
          </label>
          <label v-if="useWorktree" class="field">
            <span>New branch</span>
            <input v-model="branch" placeholder="feature/my-change" autocomplete="off" spellcheck="false" />
          </label>

          <p v-if="loadError" class="sheet-error"><Icon name="alert" :size="14" />{{ loadError }}</p>
          <p v-if="selectedProvider?.error" class="sheet-error"><Icon name="alert" :size="14" />{{ selectedProvider.error }}</p>
          <p v-if="error" class="sheet-error" role="alert">
            <Icon name="alert" :size="14" /><span>{{ error }}</span>
          </p>
        </template>
      </div>

      <footer class="sheet-foot">
        <span class="sheet-hint hide-sm">Ctrl/⌘ + Enter to start</span>
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="!canCreate">
          <span v-if="busy" class="spinner spinner-on-accent"></span>
          {{ busy ? "Starting…" : error ? "Retry" : "Start session" }}
        </button>
      </footer>
    </form>
  </div>
</template>
