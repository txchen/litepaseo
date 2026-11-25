<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { confirmAction } from "./confirm.ts";
import type { HostProviderInfo } from "../shared/wire.ts";
import { buildPatch, problems, providerRows, toDraft, type Config, type Draft } from "./host-settings-form.ts";
import HostSettingsDaemon from "./HostSettingsDaemon.vue";
import HostSettingsExtensions from "./HostSettingsExtensions.vue";
import HostSettingsGeneral from "./HostSettingsGeneral.vue";
import HostSettingsProfiles from "./HostSettingsProfiles.vue";
import HostSettingsProviders from "./HostSettingsProviders.vue";
import type { Api } from "./use-api.ts";

/**
 * One host's daemon settings. This page reads and saves them (as the smallest patch), tracks
 * unsaved edits and runs daemon restarts; the sections edit the shared draft in place.
 */
const props = defineProps<{
  host: { id: string; label: string };
  api: Api;
}>();
const emit = defineEmits<{ back: [] }>();
const base = `/hosts/${encodeURIComponent(props.host.id)}`;
const discardHost = () => confirmAction({ title: "Discard unsaved host settings?", confirmLabel: "Discard", danger: true });
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
/** Counts the settings reads; skills and plugins are read again with each. */
const loads = ref(0);
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
  if (ask && dirty.value && !(await discardHost())) return;
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
  loads.value++;
  await loadProviders();
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
async function back() {
  if (!dirty.value || (await discardHost())) emit("back");
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

// ---- Providers: what the host reports, shared by the providers and profiles sections -----------
const providers = ref<HostProviderInfo[]>([]);
const providersError = ref("");
const providersLoaded = ref(false);
async function loadProviders() {
  try {
    receiveProviders(await props.api(base + "/settings/providers"));
  } catch (e) {
    providersError.value = message(e);
  } finally {
    providersLoaded.value = true;
  }
}
function receiveProviders(list: HostProviderInfo[]) {
  providers.value = list;
  providersError.value = "";
}
const rows = computed(() => (draft.value ? providerRows(providers.value, draft.value, saved.value) : []));

// ---- Daemon lifecycle: restart and self-update, followed until the daemon is back --------------
const lifecycleError = ref("");
let lifecycleTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
async function pollLifecycle() {
  clearTimeout(lifecycleTimer);
  lifecycleTimer = undefined;
  if (disposed || document.hidden) return;
  try {
    const result = await props.api(base + "/lifecycle");
    if (disposed) return;
    const wasRunning = lifecycleJob.value?.state === "running";
    lifecycleJob.value = result;
    if (result?.state === "running" && !document.hidden) lifecycleTimer = setTimeout(() => void pollLifecycle(), 2000);
    else if (wasRunning && result?.state === "complete") {
      if (result.version) version.value = result.version;
      // The daemon came back: show what it now reports, unless edits are waiting.
      if (!dirty.value) void load(false);
    }
  } catch {
    if (!disposed) lifecycleError.value = "Could not check the operation. Reopen this page to see its outcome.";
  }
}
function onLifecycleVisibility() {
  if (document.hidden) {
    clearTimeout(lifecycleTimer);
    lifecycleTimer = undefined;
  } else if (lifecycleJob.value?.state === "running") {
    void pollLifecycle();
  }
}
async function lifecycle(action: "restart" | "update") {
  const verb = action === "restart" ? "Restart" : "Update and restart";
  const ok = await confirmAction({
    title: `${verb} the daemon on ${props.host.label}?`,
    message: "Running agents may be interrupted and the host disconnects briefly.",
    confirmLabel: verb,
    danger: true,
  });
  if (!ok) return;
  lifecycleError.value = "";
  try {
    lifecycleJob.value = await props.api(base + "/lifecycle/" + action, "POST", {});
    void pollLifecycle();
  } catch (e) {
    lifecycleError.value = message(e) + ". Check the host's status before retrying.";
  }
}

// ---- Page navigation ----------------------------------------------------------------------------
const skillsShown = ref(false);
const sections = computed(() =>
  [
    ["general", "General", true],
    ["providers", "Providers", true],
    ["profiles", "Agent profiles", !!features.value.agentProfiles],
    ["metadata", "Metadata", !!draft.value?.metadataProviders],
    ["terminals", "Terminals", true],
    ["skills", "Skills", skillsShown.value],
    ["plugins", "Plugins", !!features.value.pluginManagement],
    ["relay", "Relay", !!draft.value?.values.relay && !!features.value.relayConfig],
    ["daemon", "Daemon", true],
  ].filter(([, , shown]) => shown) as [string, string, boolean][],
);
function jump(id: string) {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById("hs-" + id)?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
}

onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  document.addEventListener("visibilitychange", onLifecycleVisibility);
  void load(false);
  void pollLifecycle();
});
onUnmounted(() => {
  disposed = true;
  clearTimeout(lifecycleTimer);
  document.removeEventListener("visibilitychange", onLifecycleVisibility);
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
          <HostSettingsGeneral :draft="draft" :features="features" />
          <HostSettingsProviders
            :api="api"
            :base="base"
            :draft="draft"
            :saved="saved"
            :features="features"
            :providers="providers"
            :rows="rows"
            :providers-error="providersError"
            :providers-loaded="providersLoaded"
            @refreshed="receiveProviders"
          />
          <HostSettingsProfiles :draft="draft" :features="features" :providers="providers" :rows="rows" />

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

        <HostSettingsExtensions :api="api" :base="base" :features="features" :loads="loads" @skills="(shown) => (skillsShown = shown)" />
        <HostSettingsDaemon
          v-model:error="lifecycleError"
          :api="api"
          :base="base"
          :version="version"
          :desktop-managed="desktopManaged"
          :features="features"
          :dirty="dirty"
          :locked="locked"
          :restarting="restarting"
          :lifecycle-job="lifecycleJob"
          @lifecycle="lifecycle"
        />
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
/* The sections are components of their own: rules for their elements reach into them with :deep(). */
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
:deep(.hs-head) {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin: 28px 0 10px;
}
:deep(.hs-head .section-label) {
  margin: 0;
}
:deep(.hs-hint) {
  margin: -4px 0 10px;
  font-size: 12.5px;
}
:deep(.section-label) {
  scroll-margin-top: 12px;
}
:deep(.card + .card) {
  margin-top: 12px;
}
:deep(.hs-grid) {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr));
  gap: 12px;
}
:deep(.hs-actions),
:deep(.hs-row-actions) {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
:deep(.hs-row-actions) {
  flex: none;
  gap: 6px;
}
:deep(.hs-danger) {
  color: var(--danger);
}
:deep(.hs-mono) {
  font-family: var(--mono);
  font-size: 13px;
}
:deep(.hs-tag) {
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
:deep(.hs-check) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
:deep(.hs-check input) {
  width: auto;
  margin: 0;
  accent-color: var(--accent);
}
:deep(.field small) {
  font-weight: 400;
}
:deep(input[aria-invalid="true"]) {
  border-color: color-mix(in srgb, var(--danger) 55%, var(--border-strong));
}

/* Providers */
:deep(.hs-provider + .hs-provider),
:deep(.hs-item + .hs-item),
:deep(.card > .hs-add),
:deep(.card > p + .hs-provider),
:deep(.card > p + .hs-item) {
  border-top: 1px solid var(--border);
}
:deep(.hs-provider-row) {
  padding-top: 8px;
  padding-bottom: 8px;
  gap: 8px;
}
:deep(.hs-provider-main),
:deep(.hs-item-head) {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  text-align: left;
  border-radius: var(--radius-sm);
}
:deep(.hs-provider-main) {
  padding: 5px 0;
}
:deep(.hs-provider-main .row-title),
:deep(.hs-provider-main .row-sub),
:deep(.hs-item-head .row-title),
:deep(.hs-item-head .row-sub) {
  display: block;
}
:deep(.hs-item-head .row-sub) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:deep(.hs-item-head) {
  width: 100%;
}
:deep(.hs-chevron) {
  flex: none;
  color: var(--fg-faint);
  transition: transform 0.15s;
}
:deep(.is-open > * > .hs-chevron),
:deep(.is-open > .hs-provider-row .hs-chevron) {
  transform: rotate(90deg);
}
:deep(.hs-status.is-ok) {
  color: var(--fg-muted);
}
:deep(.hs-status.is-warn) {
  color: var(--warn);
}
:deep(.hs-status.is-error) {
  color: var(--danger);
}
:deep(.hs-status.is-running) {
  color: var(--running);
}
:deep(.hs-status.is-muted) {
  color: var(--fg-faint);
}
:deep(.is-removed .row-title) {
  text-decoration: line-through;
  color: var(--fg-muted);
}
:deep(.hs-provider-body),
:deep(.hs-item-body) {
  display: grid;
  gap: 14px;
  padding: 4px 16px 18px 46px;
}
:deep(.hs-item-body) {
  padding-left: 16px;
}
:deep(.hs-provider-body .setting-note) {
  margin: 0;
}
:deep(.hs-models) {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
:deep(.hs-models li) {
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 12.5px;
}
:deep(.hs-inline-switch) {
  display: flex;
  align-items: center;
  gap: 12px;
}
:deep(.hs-inline-switch .row-title),
:deep(.hs-inline-switch .row-sub) {
  display: block;
}
:deep(.hs-model-row) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
:deep(.hs-add) {
  flex-wrap: wrap;
  gap: 8px;
}
:deep(.hs-add input) {
  flex: 1 1 200px;
  min-width: 0;
  height: 34px;
}
:deep(.hs-add select) {
  flex: 0 1 170px;
  height: 34px;
  padding-top: 0;
  padding-bottom: 0;
}
:deep(.hs-output-wrap) {
  display: grid;
  gap: 6px;
  justify-items: start;
}
:deep(.hs-output) {
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
:deep(.page-body > .hs-output) {
  margin-top: 12px;
}

/* Metadata */
:deep(.hs-meta-row) {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 8px;
}
:deep(.hs-meta-row select) {
  height: 34px;
  padding-top: 0;
  padding-bottom: 0;
}
:deep(.hs-order) {
  width: 20px;
  text-align: center;
  color: var(--fg-faint);
  font-variant-numeric: tabular-nums;
  font-size: 12.5px;
}
:deep(.hs-up svg) {
  transform: rotate(-90deg);
}

/* Skills, plugins, daemon */
:deep(.hs-skill-list) {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr));
  gap: 8px 16px;
}
:deep(.hs-plugin .row-title .badge) {
  margin-left: 6px;
  vertical-align: 1px;
}
:deep(.hs-plugin),
:deep(.hs-daemon) {
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
  :deep(.hs-provider-body) {
    padding-left: 16px;
  }
  :deep(.hs-model-row) {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  :deep(.hs-meta-row) {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  :deep(.hs-meta-row select) {
    grid-column: 2;
  }
  :deep(.hs-meta-row .hs-row-actions) {
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
