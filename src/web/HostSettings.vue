<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import ProviderIcon from "./ProviderIcon.vue";
import type { HostProviderInfo } from "../shared/wire.ts";
import {
  BASE_PROVIDERS,
  PROVIDER_ID,
  ago,
  buildPatch,
  canonical,
  newAgentProfile,
  newMetadataProvider,
  newTerminalProfile,
  problems,
  toDraft,
  type Config,
  type Draft,
  type ProviderDraft,
} from "./host-settings-form.ts";

const props = defineProps<{
  host: { id: string; label: string };
  api: (path: string, method?: string, body?: unknown, timeoutMs?: number) => Promise<any>;
}>();
const emit = defineEmits<{ back: [] }>();
const base = `/hosts/${encodeURIComponent(props.host.id)}`;
const message = (e: unknown) => (e as Error).message || "Request failed";

// ---- Settings: the daemon's copy, the draft being edited, and the patch between them ----------
const saved = ref<Config | null>(null);
const draft = ref<Draft | null>(null);
const revision = ref("");
const features = ref<Record<string, boolean>>({});
const version = ref("");
const desktopManaged = ref(false);
const loading = ref(true);
const loadError = ref("");
const saving = ref(false);
const saveError = ref("");
const savedNote = ref(false);
const lifecycleJob = ref<any>(null);

const patch = computed(() => (saved.value && draft.value ? buildPatch(saved.value, draft.value) : {}));
const dirty = computed(() => Object.keys(patch.value).length > 0);
const issues = computed(() => (saved.value && draft.value ? problems(saved.value, draft.value) : []));
const restarting = computed(() => lifecycleJob.value?.state === "running");
const locked = computed(() => saving.value || restarting.value);
watch(dirty, (now) => {
  if (now) savedNote.value = false;
});

function receive(result: any) {
  saved.value = result.config;
  draft.value = toDraft(result.config);
  revision.value = result.revision;
  features.value = result.features ?? {};
  if (result.desktopManaged !== undefined) desktopManaged.value = result.desktopManaged;
  if (result.version) version.value = result.version;
}
async function load(ask = true) {
  if (ask && dirty.value && !confirm("Discard unsaved host settings?")) return;
  loading.value = true;
  loadError.value = saveError.value = "";
  savedNote.value = false;
  try {
    receive(await props.api(base + "/settings"));
  } catch (e) {
    loadError.value = message(e);
    return;
  } finally {
    loading.value = false;
  }
  await Promise.all([loadProviders(), loadSkills(), loadPlugins()]);
}
async function save() {
  if (!dirty.value || issues.value.length || locked.value) return;
  saving.value = true;
  saveError.value = "";
  try {
    receive(await props.api(base + "/settings", "PATCH", { revision: revision.value, patch: patch.value }));
    savedNote.value = true;
    // Enabling, disabling or adding providers changes what the host reports.
    void loadProviders();
  } catch (e) {
    saveError.value = message(e);
  } finally {
    saving.value = false;
  }
}
function discard() {
  if (saved.value) draft.value = toDraft(saved.value);
  saveError.value = "";
}
function back() {
  if (!dirty.value || confirm("Discard unsaved host settings?")) emit("back");
}
function onKey(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void save();
  }
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) event.preventDefault();
}

// ---- General toggles ----------------------------------------------------------------------------
/** [key, title, description, feature gate]: gated settings show only on hosts that support them. */
const flags: [string, string, string, string][] = [
  ["idleRuntimeCleanup", "Release idle agents", "Free memory held by idle agents that can be resumed later.", "idleRuntimeCleanupSetting"],
  ["resumeOnStartup", "Resume agents after restart", "Continue interrupted agents when the daemon starts.", "resumeOnStartupSetting"],
  ["autoArchiveAfterMerge", "Archive merged workspaces", "Archive a workspace once its changes are merged.", ""],
  ["enableTerminalAgentHooks", "Terminal agent hooks", "Track supported agents launched from terminals.", ""],
  ["pluginsEnabled", "Host plugins", "Run the plugins configured on this host.", "plugins"],
];
const shownFlags = computed(() => {
  const v = draft.value?.values ?? {};
  return flags.filter(([key, , , gate]) => (gate ? features.value[gate] : key in v));
});

// ---- Providers ----------------------------------------------------------------------------------
const providers = ref<HostProviderInfo[]>([]);
const providersError = ref("");
const providersLoaded = ref(false);
const refreshing = ref<string[]>([]);
const refreshNotes = ref<Record<string, { text: string; error?: boolean }>>({});
const refreshSummary = ref<{ text: string; error?: boolean } | null>(null);
const diagnostics = ref<Record<string, string>>({});
const diagnosing = ref<string[]>([]);
const openProviders = ref<Record<string, boolean>>({});
const newProviderId = ref("");
const newProviderBase = ref("codex");
const newProviderError = ref("");

async function loadProviders() {
  try {
    providers.value = await props.api(base + "/settings/providers");
    providersError.value = "";
  } catch (e) {
    providersError.value = message(e);
  } finally {
    providersLoaded.value = true;
  }
}
const info = (id: string) => providers.value.find((p) => p.id === id);
const providerRows = computed(() => {
  const d = draft.value;
  if (!d) return [];
  const ids = [...providers.value.map((p) => p.id), ...Object.keys(d.providers).filter((id) => !info(id))];
  return ids.map((id) => {
    const reported = info(id);
    const conf = d.providers[id];
    const removed = d.removeProviders.includes(id);
    const enabled = conf?.enabled ?? reported?.enabled ?? true;
    return {
      id,
      reported,
      conf,
      removed,
      enabled,
      custom: conf?.extends !== undefined || reported?.source === "custom",
      saved: !!saved.value?.providers?.[id] || !!reported,
      label: conf?.label?.trim() || reported?.label || id,
      pendingToggle: reported ? enabled !== reported.enabled : false,
    };
  });
});
type Row = (typeof providerRows.value)[number];
function statusOf(row: Row): { text: string; tone: string } {
  const p = row.reported;
  if (row.removed) return { text: "Removed when you save", tone: "warn" };
  if (!p) return { text: "New · save to load its models", tone: "warn" };
  if (row.pendingToggle) return { text: row.enabled ? "Enabled when you save" : "Disabled when you save", tone: "warn" };
  if (!p.enabled) return { text: "Disabled", tone: "muted" };
  if (refreshing.value.includes(row.id) || p.status === "loading") return { text: "Loading models…", tone: "running" };
  if (p.status === "unavailable") return { text: "Not installed on this host", tone: "muted" };
  if (p.status === "error") return { text: "Could not load models", tone: "error" };
  const n = p.models.length;
  return { text: `${n} model${n === 1 ? "" : "s"} · updated ${ago(p.fetchedAt)}`, tone: "ok" };
}
const canRefresh = (row: Row) => !!row.reported && row.reported.enabled && !row.pendingToggle && !row.removed;
async function refresh(ids?: string[]) {
  const targets = ids ?? providers.value.filter((p) => p.enabled).map((p) => p.id);
  if (!targets.length) return;
  const before = new Map(providers.value.map((p) => [p.id, new Set(p.models.map((m) => m.id))]));
  refreshing.value = [...refreshing.value, ...targets];
  if (!ids) refreshSummary.value = null;
  try {
    const next: HostProviderInfo[] = await props.api(base + "/settings/providers/refresh", "POST", ids ? { providers: ids } : {}, 150_000);
    providers.value = next;
    providersError.value = "";
    let added = 0,
      failed = 0;
    for (const id of targets) {
      const p = next.find((x) => x.id === id);
      if (!p || !p.enabled) continue;
      if (p.status === "error") {
        failed++;
        refreshNotes.value[id] = { text: p.error ?? "Could not load models", error: true };
        continue;
      }
      const fresh = p.models.filter((m) => !before.get(id)?.has(m.id));
      added += fresh.length;
      refreshNotes.value[id] = {
        text: fresh.length ? `New: ${fresh.map((m) => m.label).join(", ")}` : "Model list is up to date",
      };
    }
    if (!ids)
      refreshSummary.value = failed
        ? { text: `${failed} provider${failed === 1 ? "" : "s"} could not load models.`, error: true }
        : { text: added ? `Found ${added} new model${added === 1 ? "" : "s"}.` : "Every model list is up to date." };
  } catch (e) {
    const note = { text: "Refresh failed: " + message(e), error: true };
    if (ids) for (const id of ids) refreshNotes.value[id] = note;
    else refreshSummary.value = note;
  } finally {
    refreshing.value = refreshing.value.filter((id) => !targets.includes(id));
  }
}
async function diagnose(id: string) {
  diagnosing.value = [...diagnosing.value, id];
  try {
    const result = await props.api(base + "/provider-diagnostic/" + encodeURIComponent(id), "GET", undefined, 60_000);
    diagnostics.value[id] = result.diagnostic ?? JSON.stringify(result, null, 2);
  } catch (e) {
    diagnostics.value[id] = "Diagnostic failed: " + message(e);
  } finally {
    diagnosing.value = diagnosing.value.filter((x) => x !== id);
  }
}
function hideDiagnostic(id: string) {
  delete diagnostics.value[id];
}
function providerDraft(id: string): ProviderDraft {
  return (draft.value!.providers[id] ??= { commandText: "", additionalModels: [] });
}
function toggleProvider(id: string) {
  if (!openProviders.value[id]) providerDraft(id);
  openProviders.value[id] = !openProviders.value[id];
}
function setEnabled(row: Row, enabled: boolean) {
  const conf = providerDraft(row.id);
  // Switching back to what the host already has leaves no change behind.
  if (saved.value?.providers?.[row.id]?.enabled === undefined && row.reported && enabled === row.reported.enabled)
    delete conf.enabled;
  else conf.enabled = enabled;
}
function setPaseoTools(id: string, enabled: boolean) {
  const conf = providerDraft(id);
  conf.paseoTools = { ...conf.paseoTools, enabled };
}
function addProvider() {
  const id = newProviderId.value.trim();
  newProviderError.value = "";
  if (!PROVIDER_ID.test(id)) {
    newProviderError.value = "Use lowercase letters, digits and hyphens, starting with a letter.";
    return;
  }
  if (providerRows.value.some((r) => r.id === id)) {
    newProviderError.value = `${id} already exists on this host.`;
    return;
  }
  draft.value!.providers[id] = { extends: newProviderBase.value, label: id, enabled: true, commandText: "", additionalModels: [] };
  openProviders.value[id] = true;
  newProviderId.value = "";
}
function removeProvider(row: Row) {
  const d = draft.value!;
  if (!row.saved) {
    delete d.providers[row.id];
    return;
  }
  if (!confirm(`Remove ${row.label} from this host when you save? Metadata generation stops using it.`)) return;
  d.removeProviders.push(row.id);
  // The daemon drops metadata entries for a removed provider; mirror that so the save verifies.
  if (d.metadataProviders) d.metadataProviders = d.metadataProviders.filter((p) => p.provider !== row.id);
  openProviders.value[row.id] = false;
}
function restoreProvider(id: string) {
  const d = draft.value!;
  d.removeProviders = d.removeProviders.filter((x) => x !== id);
  if (saved.value) d.metadataProviders = toDraft(saved.value).metadataProviders;
}

// ---- Model pickers shared by agent profiles and metadata generation ---------------------------
const launchProviders = computed(() =>
  providerRows.value.filter((r) => !r.removed && r.enabled).map((r) => ({ id: r.id, label: r.label })),
);
const modelsFor = (provider: string) => info(provider)?.models ?? [];
const modesFor = (provider: string) => info(provider)?.modes ?? [];
function thinkingFor(provider: string, model: string) {
  const models = modelsFor(provider);
  return (models.find((m) => m.id === model) ?? models.find((m) => m.isDefault) ?? models[0])?.thinking ?? [];
}
const labelOf = (list: { id: string; label: string }[], id: string) => list.find((x) => x.id === id)?.label ?? id;
function changeProvider(p: { model: string; thinkingOptionId: string; modeId?: string }) {
  p.model = p.thinkingOptionId = "";
  if (p.modeId !== undefined) p.modeId = "";
}
function changeModel(p: { provider: string; model: string; thinkingOptionId: string }) {
  if (p.thinkingOptionId && !thinkingFor(p.provider, p.model).some((t) => t.id === p.thinkingOptionId)) p.thinkingOptionId = "";
}

// ---- Lists: agent profiles, terminal profiles, metadata generation ----------------------------
const openItems = ref<Record<string, boolean>>({});
function move<T>(list: T[], i: number, by: number) {
  const j = i + by;
  if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j]!, list[i]!];
}
function addAgentProfile() {
  const p = newAgentProfile(launchProviders.value[0]?.id ?? "codex");
  (draft.value!.agentProfiles ??= []).push(p);
  openItems.value[p.key] = true;
}
function addTerminalProfile() {
  const p = newTerminalProfile();
  (draft.value!.terminalProfiles ??= []).push(p);
  openItems.value[p.key] = true;
}
function addMetadataProvider() {
  (draft.value!.metadataProviders ??= []).push(newMetadataProvider(launchProviders.value[0]?.id ?? "codex"));
}
function removeItem<T extends { name?: string }>(list: T[], i: number, what: string) {
  const name = list[i]?.name?.trim();
  if (name && !confirm(`Remove ${what} ${name}?`)) return;
  list.splice(i, 1);
}
function profileSummary(p: { provider: string; model: string; modeId: string; thinkingOptionId: string }) {
  const parts = [labelOf(launchProviders.value, p.provider) || "No provider", p.model ? labelOf(modelsFor(p.provider), p.model) : "Default model"];
  if (p.thinkingOptionId) parts.push(labelOf(thinkingFor(p.provider, p.model), p.thinkingOptionId));
  if (p.modeId) parts.push(labelOf(modesFor(p.provider), p.modeId));
  return parts.join(" · ");
}

// ---- Skills -------------------------------------------------------------------------------------
const skills = ref<any>(null);
const skillsSaved = ref("");
const skillsBusy = ref(false);
const skillsNote = ref<{ text: string; error?: boolean } | null>(null);
const skillsDirty = computed(() => !!skills.value && canonical(selection()) !== skillsSaved.value);
function selection() {
  const s = skills.value.selection;
  return s.mode === "all" ? { mode: "all" } : { mode: "custom", skills: [...(s.skills ?? [])].sort() };
}
async function loadSkills() {
  if (!features.value.skillManagement) return;
  try {
    skills.value = await props.api(base + "/skills");
    skillsSaved.value = canonical(selection());
  } catch (e) {
    skillsNote.value = { text: message(e), error: true };
  }
}
function setSkillMode(mode: string) {
  skills.value.selection = mode === "custom" ? { mode, skills: skills.value.selection.skills ?? [...skills.value.installed] } : { mode };
}
async function saveSkills() {
  skillsBusy.value = true;
  skillsNote.value = null;
  try {
    let result = await props.api(base + "/skills", "PUT", { selection: selection() });
    if (result.confirmationRequired) {
      if (!confirm("Remove these Paseo skills from this host? " + result.confirmationRequired.removals.join(", "))) return;
      result = await props.api(base + "/skills", "PUT", {
        selection: selection(),
        confirmedRemovals: result.confirmationRequired.removals,
      });
    }
    skills.value = result;
    skillsSaved.value = canonical(selection());
    skillsNote.value = { text: "Skill selection applied." };
  } catch (e) {
    skillsNote.value = { text: message(e), error: true };
  } finally {
    skillsBusy.value = false;
  }
}

// ---- Plugins ------------------------------------------------------------------------------------
const plugins = ref<any[]>([]);
const pluginSource = ref("");
const pluginBusy = ref<string | null>(null);
const pluginNote = ref<{ text: string; error?: boolean } | null>(null);
const pluginsShown = computed(() => !!features.value.pluginManagement);
async function loadPlugins() {
  if (!pluginsShown.value) return;
  try {
    plugins.value = await props.api(base + "/plugins");
  } catch (e) {
    pluginNote.value = { text: message(e), error: true };
  }
}
async function managePlugin(id: string, action: string) {
  const name = plugins.value.find((p) => p.id === id)?.name ?? id;
  if (action === "remove" && !confirm(`Remove plugin ${name} from this host?`)) return;
  pluginBusy.value = id || "install";
  pluginNote.value = null;
  try {
    await props.api(
      base + "/plugins" + (id ? "/" + encodeURIComponent(id) + "/" + action : ""),
      "POST",
      id ? {} : { source: pluginSource.value.trim() },
      120_000,
    );
    if (!id) pluginSource.value = "";
    pluginNote.value = { text: id ? `${name}: ${action === "remove" ? "removed" : action + "d"}.` : "Plugin installed." };
    plugins.value = await props.api(base + "/plugins");
  } catch (e) {
    pluginNote.value = { text: message(e), error: true };
  } finally {
    pluginBusy.value = null;
  }
}

// ---- Daemon -------------------------------------------------------------------------------------
const status = ref("");
const statusBusy = ref(false);
const lifecycleError = ref("");
let lifecycleTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
async function pollLifecycle() {
  clearTimeout(lifecycleTimer);
  try {
    const result = await props.api(base + "/lifecycle");
    if (disposed) return;
    const wasRunning = lifecycleJob.value?.state === "running";
    lifecycleJob.value = result;
    if (result?.state === "running") lifecycleTimer = setTimeout(() => void pollLifecycle(), 2000);
    else if (wasRunning && result?.state === "complete") {
      if (result.version) version.value = result.version;
      // The daemon came back: show what it now reports, unless edits are waiting.
      if (!dirty.value) void load(false);
    }
  } catch {
    if (!disposed) lifecycleError.value = "Could not check the operation. Reopen this page to see its outcome.";
  }
}
async function lifecycle(action: "restart" | "update") {
  const verb = action === "restart" ? "Restart" : "Update and restart";
  if (!confirm(`${verb} the daemon on ${props.host.label}? Running agents may be interrupted and the host disconnects briefly.`)) return;
  lifecycleError.value = "";
  try {
    lifecycleJob.value = await props.api(base + "/lifecycle/" + action, "POST", {});
    void pollLifecycle();
  } catch (e) {
    lifecycleError.value = message(e) + ". Check the host's status before retrying.";
  }
}
async function showStatus() {
  if (status.value) {
    status.value = "";
    return;
  }
  statusBusy.value = true;
  try {
    status.value = JSON.stringify(await props.api(base + "/status"), null, 2);
  } catch (e) {
    lifecycleError.value = message(e);
  } finally {
    statusBusy.value = false;
  }
}

// ---- Page navigation ----------------------------------------------------------------------------
const sections = computed(() =>
  [
    ["general", "General", true],
    ["providers", "Providers", true],
    ["profiles", "Agent profiles", !!features.value.agentProfiles],
    ["metadata", "Metadata", !!draft.value?.metadataProviders],
    ["terminals", "Terminals", true],
    ["skills", "Skills", !!skills.value],
    ["plugins", "Plugins", pluginsShown.value],
    ["relay", "Relay", !!draft.value?.values.relay && !!features.value.relayConfig],
    ["daemon", "Daemon", true],
  ].filter(([, , shown]) => shown) as [string, string, boolean][],
);
function jump(id: string) {
  document.getElementById("hs-" + id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  void load(false);
  void pollLifecycle();
});
onUnmounted(() => {
  disposed = true;
  clearTimeout(lifecycleTimer);
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>

<template>
  <section class="page host-settings" @keydown="onKey">
    <header class="page-head">
      <button class="icon-btn" aria-label="Back to hosts" @click="back">
        <Icon name="back" :size="18" />
      </button>
      <div class="grow">
        <h1>{{ host.label }}</h1>
        <p class="subtle">
          Host settings · apply to every client of this daemon<span v-if="version"> · Paseo {{ version }}</span>
        </p>
      </div>
      <button class="btn btn-outline btn-sm hs-reload" :disabled="loading || locked" @click="load()">
        <Icon name="refresh" :size="13" />Reload
      </button>
    </header>
    <div class="page-body">
      <p v-if="loading && !draft" class="subtle hs-loading"><span class="spinner"></span> Reading host settings…</p>
      <div v-else-if="loadError" class="ps-callout is-error" role="alert">
        <p><Icon name="alert" :size="14" />Could not read this host's settings: {{ loadError }}</p>
        <button class="btn btn-outline" @click="load(false)">Try again</button>
      </div>

      <template v-if="draft && !loadError">
        <nav class="hs-nav" aria-label="Host settings sections">
          <button v-for="[id, label] in sections" :key="id" type="button" class="hs-chip" @click="jump(id)">{{ label }}</button>
        </nav>
        <div v-if="restarting" class="ps-callout is-warn" role="status">
          <p><span class="spinner"></span>{{ lifecycleJob.phase }}… settings are locked until the daemon is back.</p>
        </div>

        <fieldset :disabled="locked" class="hs-fields">
          <!-- General ------------------------------------------------------------------------>
          <h2 id="hs-general" class="section-label">General</h2>
          <div class="card">
            <label v-for="[key, title, hint] in shownFlags" :key="key" class="card-row switch-row">
              <div class="grow">
                <div class="row-title">{{ title }}</div>
                <div class="row-sub">{{ hint }}</div>
              </div>
              <input v-model="draft.values[key]" type="checkbox" class="switch" :aria-label="title" />
            </label>
            <label v-if="draft.values.mcp" class="card-row switch-row">
              <div class="grow">
                <div class="row-title">Paseo orchestration tools</div>
                <div class="row-sub">Give agents Paseo's tools for starting and managing other agents.</div>
              </div>
              <input v-model="draft.values.mcp.injectIntoAgents" type="checkbox" class="switch" aria-label="Paseo orchestration tools" />
            </label>
            <label v-if="draft.values.browserTools" class="card-row switch-row">
              <div class="grow">
                <div class="row-title">Browser tools</div>
                <div class="row-sub">Let agents automate a browser on this host.</div>
              </div>
              <input v-model="draft.values.browserTools.enabled" type="checkbox" class="switch" aria-label="Browser tools" />
            </label>
            <label v-if="draft.values.usage" class="card-row switch-row">
              <div class="grow">
                <div class="row-title">Provider usage</div>
                <div class="row-sub">Collect usage limits from providers for the usage panel.</div>
              </div>
              <input v-model="draft.values.usage.enabled" type="checkbox" class="switch" aria-label="Provider usage" />
            </label>
          </div>
          <div class="card form-card">
            <label class="field">
              <span>Additional system instructions</span>
              <textarea v-model="draft.values.appendSystemPrompt" rows="4" placeholder="Appended to every agent's instructions on this host"></textarea>
            </label>
            <label v-if="features.resumeOnStartupSetting" class="field">
              <span>Restart recovery prompt</span>
              <textarea v-model="draft.values.resumePrompt" rows="2" placeholder="Sent to agents resumed after a restart"></textarea>
            </label>
          </div>

          <!-- Providers ---------------------------------------------------------------------->
          <div class="hs-head">
            <h2 id="hs-providers" class="section-label">Providers</h2>
            <button
              type="button"
              class="btn btn-outline btn-sm"
              :disabled="!!refreshing.length || !providers.some((p) => p.enabled)"
              @click="refresh()"
            >
              <span v-if="refreshing.length" class="spinner"></span><Icon v-else name="refresh" :size="13" />
              {{ refreshing.length ? "Refreshing…" : "Refresh models" }}
            </button>
          </div>
          <p class="subtle hs-hint">
            The daemon caches each provider's model list. Refresh to pick up models released since it last checked.
          </p>
          <p v-if="refreshSummary" class="setting-note" :class="{ 'is-error': refreshSummary.error }" role="status">{{ refreshSummary.text }}</p>
          <p v-if="providersError" class="setting-note is-error" role="alert">Could not read providers: {{ providersError }}</p>
          <div class="card">
            <p v-if="!providersLoaded" class="card-row subtle"><span class="spinner"></span> Reading providers…</p>
            <div v-for="row in providerRows" :key="row.id" class="hs-provider" :class="{ 'is-open': openProviders[row.id], 'is-removed': row.removed }">
              <div class="card-row hs-provider-row">
                <button
                  type="button"
                  class="hs-provider-main"
                  :aria-expanded="!!openProviders[row.id]"
                  :aria-label="(openProviders[row.id] ? 'Collapse ' : 'Configure ') + row.label"
                  @click="toggleProvider(row.id)"
                >
                  <ProviderIcon :provider="row.conf?.extends ?? row.id" />
                  <span class="grow">
                    <span class="row-title">{{ row.label }}<span v-if="row.custom" class="hs-tag">custom</span></span>
                    <span class="row-sub hs-status" :class="'is-' + statusOf(row).tone">{{ statusOf(row).text }}</span>
                  </span>
                  <Icon name="chevron" :size="15" class="hs-chevron" />
                </button>
                <button
                  v-if="canRefresh(row)"
                  type="button"
                  class="icon-btn"
                  :disabled="refreshing.includes(row.id)"
                  :aria-label="'Refresh ' + row.label + ' models'"
                  :title="'Refresh ' + row.label + ' models'"
                  @click="refresh([row.id])"
                >
                  <span v-if="refreshing.includes(row.id)" class="spinner"></span><Icon v-else name="refresh" :size="15" />
                </button>
                <button v-if="row.removed" type="button" class="btn btn-outline btn-sm" @click="restoreProvider(row.id)">Undo</button>
                <input
                  v-else
                  type="checkbox"
                  class="switch"
                  :checked="row.enabled"
                  :aria-label="'Enable ' + row.label"
                  @change="setEnabled(row, ($event.target as HTMLInputElement).checked)"
                />
              </div>
              <div v-if="openProviders[row.id] && row.conf && !row.removed" class="hs-provider-body">
                <p v-if="refreshNotes[row.id]" class="setting-note" :class="{ 'is-error': refreshNotes[row.id]!.error }" role="status">
                  {{ refreshNotes[row.id]!.text }}
                </p>
                <div v-if="row.reported?.status === 'error' && row.reported.error" class="ps-callout is-error">
                  <p><Icon name="alert" :size="14" />{{ row.reported.error }}</p>
                </div>
                <div v-if="row.reported?.models.length" class="field">
                  <span>Models reported by the host</span>
                  <ul class="hs-models">
                    <li v-for="m in row.reported.models" :key="m.id" :title="m.description || m.id">
                      {{ m.label }}<span v-if="m.isDefault" class="hs-tag">default</span>
                    </li>
                  </ul>
                </div>
                <div class="hs-actions">
                  <button
                    v-if="canRefresh(row)"
                    type="button"
                    class="btn btn-outline btn-sm"
                    :disabled="refreshing.includes(row.id)"
                    @click="refresh([row.id])"
                  >
                    <Icon name="refresh" :size="13" />{{ refreshing.includes(row.id) ? "Refreshing…" : "Refresh models" }}
                  </button>
                  <button v-if="row.reported" type="button" class="btn btn-outline btn-sm" :disabled="diagnosing.includes(row.id)" @click="diagnose(row.id)">
                    {{ diagnosing.includes(row.id) ? "Checking…" : "Run diagnostic" }}
                  </button>
                  <button
                    v-if="row.custom && (!row.saved || features.providerRemoval)"
                    type="button"
                    class="btn btn-outline btn-sm hs-danger"
                    @click="removeProvider(row)"
                  >
                    <Icon name="trash" :size="13" />Remove provider
                  </button>
                </div>
                <div v-if="diagnostics[row.id]" class="hs-output-wrap">
                  <pre class="hs-output">{{ diagnostics[row.id] }}</pre>
                  <button type="button" class="link-btn" @click="hideDiagnostic(row.id)">Hide diagnostic</button>
                </div>
                <div v-if="row.conf.extends !== undefined" class="hs-grid">
                  <label class="field">
                    <span>Display name</span>
                    <input v-model="row.conf.label" :aria-invalid="!row.conf.label?.trim()" />
                  </label>
                  <label class="field">
                    <span>Based on</span>
                    <select v-model="row.conf.extends" aria-label="Based on">
                      <option v-for="name in BASE_PROVIDERS" :key="name" :value="name">{{ name }}</option>
                    </select>
                  </label>
                </div>
                <label class="field">
                  <span>Command override <small class="subtle">· optional, one argument per line</small></span>
                  <textarea v-model="row.conf.commandText" rows="2" class="hs-mono" spellcheck="false" placeholder="Uses the provider's default command"></textarea>
                </label>
                <label class="switch-row hs-inline-switch">
                  <span class="grow">
                    <span class="row-title">Paseo tools</span>
                    <span class="row-sub">Offer Paseo's orchestration tools to agents of this provider.</span>
                  </span>
                  <input
                    type="checkbox"
                    class="switch"
                    :checked="row.conf.paseoTools?.enabled !== false"
                    :aria-label="'Paseo tools for ' + row.label"
                    @change="setPaseoTools(row.id, ($event.target as HTMLInputElement).checked)"
                  />
                </label>
                <div class="field">
                  <span>Additional models <small class="subtle">· offered even if the provider does not list them</small></span>
                  <div v-for="(m, i) in row.conf.additionalModels" :key="i" class="hs-model-row">
                    <input v-model="m.id" placeholder="Model ID" :aria-label="'Model ID ' + (i + 1)" :aria-invalid="!m.id.trim()" />
                    <input v-model="m.label" placeholder="Label" :aria-label="'Model label ' + (i + 1)" :aria-invalid="!m.label.trim()" />
                    <label class="hs-check"><input v-model="m.isDefault" type="checkbox" />Default</label>
                    <button type="button" class="icon-btn" :aria-label="'Remove model ' + (m.id || i + 1)" @click="row.conf.additionalModels.splice(i, 1)">
                      <Icon name="close" :size="14" />
                    </button>
                  </div>
                  <button type="button" class="link-btn" @click="row.conf.additionalModels.push({ id: '', label: '', isDefault: false, rest: {} })">
                    <Icon name="plus" :size="13" />Add model
                  </button>
                </div>
              </div>
            </div>
            <div class="card-row hs-add">
              <input v-model="newProviderId" placeholder="New custom provider ID, e.g. my-codex" aria-label="New custom provider ID" @keydown.enter.prevent="addProvider" />
              <select v-model="newProviderBase" aria-label="New provider based on">
                <option v-for="name in BASE_PROVIDERS" :key="name" :value="name">based on {{ name }}</option>
              </select>
              <button type="button" class="btn btn-outline btn-sm" :disabled="!newProviderId.trim()" @click="addProvider">Add</button>
            </div>
          </div>
          <p v-if="newProviderError" class="setting-note is-error" role="alert">{{ newProviderError }}</p>

          <!-- Agent profiles ----------------------------------------------------------------->
          <template v-if="features.agentProfiles">
            <div class="hs-head">
              <h2 id="hs-profiles" class="section-label">Agent profiles</h2>
              <button type="button" class="btn btn-outline btn-sm" @click="addAgentProfile"><Icon name="plus" :size="13" />Add agent profile</button>
            </div>
            <p class="subtle hs-hint">Named launch settings, also offered to orchestrating agents.</p>
            <div class="card">
              <p v-if="!draft.agentProfiles?.length" class="card-row subtle">No agent profiles yet.</p>
              <div v-for="(p, i) in draft.agentProfiles ?? []" :key="p.key" class="hs-item" :class="{ 'is-open': openItems[p.key] }">
                <button type="button" class="card-row hs-item-head" :aria-expanded="!!openItems[p.key]" @click="openItems[p.key] = !openItems[p.key]">
                  <span class="grow">
                    <span class="row-title">{{ p.name.trim() || "Untitled profile" }}</span>
                    <span class="row-sub">{{ profileSummary(p) }}</span>
                  </span>
                  <Icon name="chevron" :size="15" class="hs-chevron" />
                </button>
                <div v-if="openItems[p.key]" class="hs-item-body">
                  <div class="hs-grid">
                    <label class="field">
                      <span>Name</span>
                      <input v-model="p.name" :aria-invalid="!p.name.trim()" placeholder="Review" />
                    </label>
                    <label class="field">
                      <span>Provider</span>
                      <select v-model="p.provider" aria-label="Provider" @change="changeProvider(p)">
                        <option v-if="p.provider && !launchProviders.some((x) => x.id === p.provider)" :value="p.provider">{{ p.provider }} (not enabled)</option>
                        <option v-for="x in launchProviders" :key="x.id" :value="x.id">{{ x.label }}</option>
                      </select>
                    </label>
                    <label class="field">
                      <span>Model</span>
                      <select v-model="p.model" aria-label="Model" @change="changeModel(p)">
                        <option value="">Provider default</option>
                        <option v-if="p.model && !modelsFor(p.provider).some((m) => m.id === p.model)" :value="p.model">{{ p.model }} (not reported)</option>
                        <option v-for="m in modelsFor(p.provider)" :key="m.id" :value="m.id">{{ m.label }}</option>
                      </select>
                    </label>
                    <label class="field">
                      <span>Thinking</span>
                      <select v-model="p.thinkingOptionId" aria-label="Thinking">
                        <option value="">Model default</option>
                        <option v-if="p.thinkingOptionId && !thinkingFor(p.provider, p.model).some((t) => t.id === p.thinkingOptionId)" :value="p.thinkingOptionId">
                          {{ p.thinkingOptionId }} (not reported)
                        </option>
                        <option v-for="t in thinkingFor(p.provider, p.model)" :key="t.id" :value="t.id">{{ t.label }}</option>
                      </select>
                    </label>
                    <label class="field">
                      <span>Mode</span>
                      <select v-model="p.modeId" aria-label="Mode">
                        <option value="">Provider default</option>
                        <option v-if="p.modeId && !modesFor(p.provider).some((m) => m.id === p.modeId)" :value="p.modeId">{{ p.modeId }} (not reported)</option>
                        <option v-for="m in modesFor(p.provider)" :key="m.id" :value="m.id">{{ m.label }}</option>
                      </select>
                    </label>
                  </div>
                  <label class="field">
                    <span>When to use</span>
                    <textarea v-model="p.notes" rows="4" placeholder="Shown to orchestrating agents choosing a profile"></textarea>
                  </label>
                  <div class="hs-actions">
                    <button type="button" class="btn btn-outline btn-sm" :disabled="i === 0" @click="move(draft.agentProfiles!, i, -1)">Move up</button>
                    <button type="button" class="btn btn-outline btn-sm" :disabled="i === draft.agentProfiles!.length - 1" @click="move(draft.agentProfiles!, i, 1)">
                      Move down
                    </button>
                    <button type="button" class="btn btn-outline btn-sm hs-danger" @click="removeItem(draft.agentProfiles!, i, 'agent profile')">
                      <Icon name="trash" :size="13" />Remove
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- Metadata generation ------------------------------------------------------------>
          <template v-if="draft.metadataProviders">
            <div class="hs-head">
              <h2 id="hs-metadata" class="section-label">Metadata generation</h2>
              <button type="button" class="btn btn-outline btn-sm" @click="addMetadataProvider"><Icon name="plus" :size="13" />Add provider</button>
            </div>
            <p class="subtle hs-hint">Providers tried in order for branch names, commit messages and pull requests. None: Paseo picks automatically.</p>
            <div class="card">
              <p v-if="!draft.metadataProviders.length" class="card-row subtle">Automatic selection.</p>
              <div v-for="(p, i) in draft.metadataProviders" :key="p.key" class="card-row hs-meta-row">
                <span class="hs-order">{{ i + 1 }}</span>
                <select v-model="p.provider" :aria-label="'Metadata provider ' + (i + 1)" @change="changeProvider(p)">
                  <option v-if="p.provider && !launchProviders.some((x) => x.id === p.provider)" :value="p.provider">{{ p.provider }} (not enabled)</option>
                  <option v-for="x in launchProviders" :key="x.id" :value="x.id">{{ x.label }}</option>
                </select>
                <select v-model="p.model" :aria-label="'Metadata model ' + (i + 1)" @change="changeModel(p)">
                  <option value="">Default model</option>
                  <option v-if="p.model && !modelsFor(p.provider).some((m) => m.id === p.model)" :value="p.model">{{ p.model }} (not reported)</option>
                  <option v-for="m in modelsFor(p.provider)" :key="m.id" :value="m.id">{{ m.label }}</option>
                </select>
                <select v-model="p.thinkingOptionId" :aria-label="'Metadata thinking ' + (i + 1)">
                  <option value="">Default thinking</option>
                  <option v-if="p.thinkingOptionId && !thinkingFor(p.provider, p.model).some((t) => t.id === p.thinkingOptionId)" :value="p.thinkingOptionId">
                    {{ p.thinkingOptionId }}
                  </option>
                  <option v-for="t in thinkingFor(p.provider, p.model)" :key="t.id" :value="t.id">{{ t.label }}</option>
                </select>
                <span class="hs-row-actions">
                  <button type="button" class="icon-btn hs-up" :disabled="i === 0" aria-label="Move up" title="Move up" @click="move(draft.metadataProviders, i, -1)">
                    <Icon name="chevron" :size="14" />
                  </button>
                  <button type="button" class="icon-btn" aria-label="Remove" title="Remove" @click="draft.metadataProviders.splice(i, 1)">
                    <Icon name="close" :size="14" />
                  </button>
                </span>
              </div>
            </div>
          </template>

          <!-- Terminal profiles -------------------------------------------------------------->
          <div class="hs-head">
            <h2 id="hs-terminals" class="section-label">Terminal profiles</h2>
            <button type="button" class="btn btn-outline btn-sm" @click="addTerminalProfile"><Icon name="plus" :size="13" />Add terminal profile</button>
          </div>
          <p class="subtle hs-hint">Commands offered when opening a new terminal on this host.</p>
          <div class="card">
            <p v-if="!draft.terminalProfiles?.length" class="card-row subtle">No terminal profiles yet.</p>
            <div v-for="(p, i) in draft.terminalProfiles ?? []" :key="p.key" class="hs-item" :class="{ 'is-open': openItems[p.key] }">
              <button type="button" class="card-row hs-item-head" :aria-expanded="!!openItems[p.key]" @click="openItems[p.key] = !openItems[p.key]">
                <span class="grow">
                  <span class="row-title">{{ p.name.trim() || "Untitled terminal" }}</span>
                  <span class="row-sub hs-mono">{{ [p.command, ...p.argsText.split("\n")].filter((x) => x.trim()).join(" ") || "No command" }}</span>
                </span>
                <Icon name="chevron" :size="15" class="hs-chevron" />
              </button>
              <div v-if="openItems[p.key]" class="hs-item-body">
                <div class="hs-grid">
                  <label class="field">
                    <span>Name</span>
                    <input v-model="p.name" :aria-invalid="!p.name.trim()" placeholder="Shell" />
                  </label>
                  <label class="field">
                    <span>Command</span>
                    <input v-model="p.command" class="hs-mono" :aria-invalid="!p.command.trim()" placeholder="/bin/bash" spellcheck="false" />
                  </label>
                </div>
                <label class="field">
                  <span>Arguments <small class="subtle">· one per line</small></span>
                  <textarea v-model="p.argsText" rows="2" class="hs-mono" spellcheck="false"></textarea>
                </label>
                <div class="hs-actions">
                  <button type="button" class="btn btn-outline btn-sm" :disabled="i === 0" @click="move(draft.terminalProfiles!, i, -1)">Move up</button>
                  <button type="button" class="btn btn-outline btn-sm" :disabled="i === draft.terminalProfiles!.length - 1" @click="move(draft.terminalProfiles!, i, 1)">
                    Move down
                  </button>
                  <button type="button" class="btn btn-outline btn-sm hs-danger" @click="removeItem(draft.terminalProfiles!, i, 'terminal profile')">
                    <Icon name="trash" :size="13" />Remove
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Relay -------------------------------------------------------------------------->
          <template v-if="draft.values.relay && features.relayConfig">
            <h2 id="hs-relay" class="section-label">Relay</h2>
            <div class="card">
              <label class="card-row switch-row">
                <div class="grow">
                  <div class="row-title">Relay connections</div>
                  <div class="row-sub">Reach this host through Paseo's relay. Turning it off disconnects relay clients.</div>
                </div>
                <input v-model="draft.values.relay.enabled" type="checkbox" class="switch" aria-label="Relay connections" />
              </label>
              <label v-if="draft.values.relay.requireProtectedSecurity !== undefined" class="card-row switch-row">
                <div class="grow">
                  <div class="row-title">Require protected relay sessions</div>
                  <div class="row-sub">Admit only relay sessions with end-to-end endpoint security.</div>
                </div>
                <input v-model="draft.values.relay.requireProtectedSecurity" type="checkbox" class="switch" aria-label="Require protected relay sessions" />
              </label>
            </div>
          </template>
        </fieldset>

        <!-- Skills: applied on their own, not with Save -------------------------------------->
        <template v-if="skills">
          <h2 id="hs-skills" class="section-label">Paseo skills</h2>
          <p class="subtle hs-hint">Skills Paseo installs for agents on this host. Applied immediately, separately from Save.</p>
          <div class="card form-card">
            <label class="field">
              <span>Installed skills · {{ skills.state }}</span>
              <select :value="skills.selection.mode" :disabled="skillsBusy" @change="setSkillMode(($event.target as HTMLSelectElement).value)">
                <option value="all">All Paseo skills</option>
                <option value="custom">Only the skills I choose</option>
              </select>
            </label>
            <div v-if="skills.selection.mode === 'custom'" class="hs-skill-list">
              <label v-for="name in skills.available" :key="name" class="hs-check">
                <input v-model="skills.selection.skills" type="checkbox" :value="name" :disabled="skillsBusy" />{{ name }}
              </label>
            </div>
            <div class="hs-actions">
              <button type="button" class="btn btn-outline btn-sm" :disabled="!skillsDirty || skillsBusy" @click="saveSkills">
                {{ skillsBusy ? "Applying…" : "Apply skill selection" }}
              </button>
              <span v-if="skillsNote" class="setting-note" :class="{ 'is-error': skillsNote.error }" role="status">{{ skillsNote.text }}</span>
            </div>
          </div>
        </template>

        <!-- Plugins: each action applies immediately ------------------------------------------>
        <template v-if="pluginsShown">
          <h2 id="hs-plugins" class="section-label">Host plugins</h2>
          <p class="subtle hs-hint">Plugin code runs on this host with its user's permissions. Actions apply immediately.</p>
          <p v-if="pluginNote" class="setting-note" :class="{ 'is-error': pluginNote.error }" role="status">{{ pluginNote.text }}</p>
          <div class="card">
            <p v-if="!plugins.length" class="card-row subtle">No plugins installed.</p>
            <div v-for="p in plugins" :key="p.id" class="card-row hs-plugin">
              <div class="grow">
                <div class="row-title">
                  {{ p.name ?? p.id }}
                  <span class="badge" :class="{ 'is-error': p.status === 'error' || p.error, 'is-running': p.status === 'running' }">{{ p.status }}</span>
                </div>
                <div v-if="p.description" class="row-sub">{{ p.description }}</div>
                <div v-if="p.error" class="row-sub is-error">{{ p.error }}</div>
              </div>
              <div class="hs-row-actions">
                <button type="button" class="btn btn-outline btn-sm" :disabled="!!pluginBusy" @click="managePlugin(p.id, p.enabled ? 'disable' : 'enable')">
                  {{ p.enabled ? "Disable" : "Enable" }}
                </button>
                <button type="button" class="btn btn-outline btn-sm" :disabled="!!pluginBusy" @click="managePlugin(p.id, 'reload')">Reload</button>
                <button type="button" class="icon-btn hs-danger" :disabled="!!pluginBusy" :aria-label="'Remove ' + (p.name ?? p.id)" title="Remove" @click="managePlugin(p.id, 'remove')">
                  <span v-if="pluginBusy === p.id" class="spinner"></span><Icon v-else name="trash" :size="14" />
                </button>
              </div>
            </div>
            <div v-if="features.pluginSourceInstallation" class="card-row hs-add">
              <input v-model="pluginSource" placeholder="npm package, Git URL or host directory" aria-label="Install trusted plugin" @keydown.enter.prevent="pluginSource.trim() && managePlugin('', 'install')" />
              <button type="button" class="btn btn-outline btn-sm" :disabled="!pluginSource.trim() || !!pluginBusy" @click="managePlugin('', 'install')">
                {{ pluginBusy === "install" ? "Installing…" : "Install" }}
              </button>
            </div>
          </div>
        </template>

        <!-- Daemon ---------------------------------------------------------------------------->
        <h2 id="hs-daemon" class="section-label">Daemon</h2>
        <div class="card">
          <div class="card-row hs-daemon">
            <div class="grow">
              <div class="row-title">Paseo {{ version || "version unknown" }}</div>
              <div class="row-sub">
                <template v-if="desktopManaged">Managed by Paseo Desktop. Update it through Desktop.</template>
                <template v-else-if="!features.daemonSelfUpdate">This installation cannot update itself remotely.</template>
                <template v-else-if="dirty">Save or discard your changes before restarting.</template>
                <template v-else>Restarting interrupts running agents briefly.</template>
              </div>
            </div>
            <div class="hs-row-actions">
              <button v-if="features.daemonStatusRpc" type="button" class="btn btn-outline btn-sm" :disabled="statusBusy" @click="showStatus">
                {{ status ? "Hide status" : "Status" }}
              </button>
              <button v-if="features.daemonStatusRpc" type="button" class="btn btn-outline btn-sm" :disabled="dirty || locked" @click="lifecycle('restart')">
                Restart…
              </button>
              <button
                v-if="features.daemonStatusRpc && features.daemonSelfUpdate && !desktopManaged"
                type="button"
                class="btn btn-outline btn-sm"
                :disabled="dirty || locked"
                @click="lifecycle('update')"
              >
                Update & restart…
              </button>
            </div>
          </div>
        </div>
        <p
          v-if="lifecycleJob && !restarting"
          role="status"
          class="setting-note"
          :class="{ 'is-error': lifecycleJob.state === 'failed' }"
        >
          {{ lifecycleJob.phase }}<span v-if="lifecycleJob.version"> · {{ lifecycleJob.version }}</span><span v-if="lifecycleJob.error">: {{ lifecycleJob.error }}</span>
        </p>
        <p v-if="lifecycleError" class="setting-note is-error" role="alert">{{ lifecycleError }}</p>
        <pre v-if="status" class="hs-output">{{ status }}</pre>
      </template>
    </div>

    <!-- Save bar: present whenever there is something to say about the draft -------------------->
    <div v-if="draft && (dirty || saving || saveError || savedNote)" class="hs-savebar" role="region" aria-label="Save host settings">
      <div class="hs-savebar-inner">
        <div class="grow hs-savebar-text">
          <template v-if="saveError">
            <span class="is-error" role="alert"><Icon name="alert" :size="14" />{{ saveError }}</span>
          </template>
          <template v-else-if="issues.length">
            <span class="is-error"><Icon name="alert" :size="14" />{{ issues[0] }}</span>
            <span v-if="issues.length > 1" class="subtle"> and {{ issues.length - 1 }} more</span>
          </template>
          <span v-else-if="savedNote && !dirty" class="is-ok" role="status"><Icon name="check" :size="14" />Saved. New agents and terminals use these settings.</span>
          <span v-else>Unsaved changes</span>
        </div>
        <button v-if="saveError && /changed elsewhere|reload/i.test(saveError)" type="button" class="btn btn-ghost btn-sm" @click="load()">Reload</button>
        <template v-if="dirty">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="saving" @click="discard">Discard</button>
          <button type="button" class="btn btn-primary btn-sm" :disabled="saving || !!issues.length || restarting" @click="save">
            {{ saving ? "Saving…" : "Save changes" }}
          </button>
        </template>
        <button v-else type="button" class="icon-btn" aria-label="Dismiss" @click="(savedNote = false), (saveError = '')"><Icon name="close" :size="14" /></button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.host-settings {
  display: flex;
  flex-direction: column;
}
.host-settings > .page-body {
  flex: 1 0 auto;
  width: 100%;
}
.hs-reload {
  margin-top: 4px;
}
.hs-loading {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hs-fields {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.hs-nav {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  margin: 0 -2px 4px;
  padding: 2px;
}
.hs-chip {
  flex: none;
  height: 28px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--fg-muted);
}
.hs-chip:hover {
  background: var(--hover);
  color: var(--fg);
}
.hs-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin: 28px 0 10px;
}
.hs-head .section-label {
  margin: 0;
}
.hs-hint {
  margin: -4px 0 10px;
  font-size: 12.5px;
}
.section-label {
  scroll-margin-top: 12px;
}
.card + .card {
  margin-top: 12px;
}
.hs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr));
  gap: 12px;
}
.hs-actions,
.hs-row-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.hs-row-actions {
  flex: none;
  gap: 6px;
}
.hs-danger {
  color: var(--danger);
}
.hs-mono {
  font-family: var(--mono);
  font-size: 13px;
}
.hs-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--fg-muted);
  font-size: 11px;
  font-weight: 500;
  vertical-align: 1px;
}
.hs-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.hs-check input {
  width: auto;
  margin: 0;
  accent-color: var(--accent);
}
.field small {
  font-weight: 400;
}
input[aria-invalid="true"] {
  border-color: color-mix(in srgb, var(--danger) 55%, var(--border-strong));
}

/* Providers */
.hs-provider + .hs-provider,
.hs-item + .hs-item,
.card > .hs-add,
.card > p + .hs-provider,
.card > p + .hs-item {
  border-top: 1px solid var(--border);
}
.hs-provider-row {
  padding-top: 8px;
  padding-bottom: 8px;
  gap: 8px;
}
.hs-provider-main,
.hs-item-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  text-align: left;
  border-radius: var(--radius-sm);
}
.hs-provider-main {
  padding: 5px 0;
}
.hs-provider-main .row-title,
.hs-provider-main .row-sub,
.hs-item-head .row-title,
.hs-item-head .row-sub {
  display: block;
}
.hs-item-head .row-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hs-item-head {
  width: 100%;
}
.hs-chevron {
  flex: none;
  color: var(--fg-faint);
  transition: transform 0.15s;
}
.is-open > * > .hs-chevron,
.is-open > .hs-provider-row .hs-chevron {
  transform: rotate(90deg);
}
.hs-status.is-ok {
  color: var(--fg-muted);
}
.hs-status.is-warn {
  color: var(--warn);
}
.hs-status.is-error {
  color: var(--danger);
}
.hs-status.is-running {
  color: var(--running);
}
.hs-status.is-muted {
  color: var(--fg-faint);
}
.is-removed .row-title {
  text-decoration: line-through;
  color: var(--fg-muted);
}
.hs-provider-body,
.hs-item-body {
  display: grid;
  gap: 14px;
  padding: 4px 16px 18px 46px;
}
.hs-item-body {
  padding-left: 16px;
}
.hs-provider-body .setting-note {
  margin: 0;
}
.hs-models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.hs-models li {
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 12.5px;
}
.hs-inline-switch {
  display: flex;
  align-items: center;
  gap: 12px;
}
.hs-inline-switch .row-title,
.hs-inline-switch .row-sub {
  display: block;
}
.hs-model-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.hs-add {
  flex-wrap: wrap;
  gap: 8px;
}
.hs-add input {
  flex: 1 1 200px;
  min-width: 0;
  height: 34px;
}
.hs-add select {
  flex: 0 1 170px;
  height: 34px;
  padding-top: 0;
  padding-bottom: 0;
}
.hs-output-wrap {
  display: grid;
  gap: 6px;
  justify-items: start;
}
.hs-output {
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  max-height: 360px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--mono);
  font-size: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.page-body > .hs-output {
  margin-top: 12px;
}

/* Metadata */
.hs-meta-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 8px;
}
.hs-meta-row select {
  height: 34px;
  padding-top: 0;
  padding-bottom: 0;
}
.hs-order {
  width: 20px;
  text-align: center;
  color: var(--fg-faint);
  font-variant-numeric: tabular-nums;
  font-size: 12.5px;
}
.hs-up :deep(svg) {
  transform: rotate(-90deg);
}

/* Skills, plugins, daemon */
.hs-skill-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr));
  gap: 8px 16px;
}
.hs-plugin .row-title .badge {
  margin-left: 6px;
  vertical-align: 1px;
}
.hs-plugin,
.hs-daemon {
  flex-wrap: wrap;
}

/* Save bar */
.hs-savebar {
  position: sticky;
  bottom: 0;
  z-index: 3;
  padding: 0 28px calc(12px + var(--safe-area-bottom));
  pointer-events: none;
}
.hs-savebar-inner {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 704px;
  margin: 0 auto;
  padding: 8px 8px 8px 16px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--surface-0);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  font-size: 13px;
}
.hs-savebar-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hs-savebar-text > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.hs-savebar .is-error {
  color: var(--danger);
}
.hs-savebar .is-ok {
  color: var(--accent);
}

@media (max-width: 560px) {
  .hs-provider-body {
    padding-left: 16px;
  }
  .hs-model-row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .hs-meta-row {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  .hs-meta-row select {
    grid-column: 2;
  }
  .hs-meta-row .hs-row-actions {
    grid-row: 1;
    grid-column: 3;
  }
  .hs-savebar {
    padding: 0 12px calc(10px + var(--safe-area-bottom));
  }
  .hs-savebar-inner {
    border-radius: var(--radius);
    flex-wrap: wrap;
  }
  .hs-savebar-text {
    flex-basis: 100%;
    white-space: normal;
  }
  .hs-savebar-text + * {
    margin-left: auto;
  }
}
</style>
