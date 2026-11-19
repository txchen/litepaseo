<script setup lang="ts">
import { ref } from "vue";
import type { HostProviderInfo } from "../shared/wire.ts";
import { confirmAction } from "./confirm.ts";
import {
  BASE_PROVIDERS,
  PROVIDER_ID,
  ago,
  restoreMetadataProviders,
  toDraft,
  type Config,
  type Draft,
  type ProviderDraft,
  type ProviderRow as Row,
} from "./host-settings-form.ts";
import Icon from "./Icon.vue";
import ProviderIcon from "./ProviderIcon.vue";
import type { Api } from "./use-api.ts";

/**
 * Host settings · Providers: what the host reports (models, status, diagnostics) and the draft's
 * provider edits (enable, command, extra models, custom providers). Edits the draft in place;
 * model refreshes go to the host at once and come back as `refreshed`.
 */
const props = defineProps<{
  api: Api;
  /** The host's `/api` path. */
  base: string;
  draft: Draft;
  saved: Config | null;
  features: Record<string, boolean>;
  providers: HostProviderInfo[];
  rows: Row[];
  providersError: string;
  providersLoaded: boolean;
}>();
const emit = defineEmits<{ refreshed: [providers: HostProviderInfo[]] }>();
const message = (e: unknown) => (e as Error).message || "Request failed";

const refreshing = ref<string[]>([]);
const refreshNotes = ref<Record<string, { text: string; error?: boolean }>>({});
const refreshSummary = ref<{ text: string; error?: boolean } | null>(null);
const diagnostics = ref<Record<string, string>>({});
const diagnosing = ref<string[]>([]);
const openProviders = ref<Record<string, boolean>>({});
const newProviderId = ref("");
const newProviderBase = ref("codex");
const newProviderError = ref("");

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
  const targets = ids ?? props.providers.filter((p) => p.enabled).map((p) => p.id);
  if (!targets.length) return;
  const before = new Map(props.providers.map((p) => [p.id, new Set(p.models.map((m) => m.id))]));
  refreshing.value = [...refreshing.value, ...targets];
  if (!ids) refreshSummary.value = null;
  try {
    const next: HostProviderInfo[] = await props.api(props.base + "/settings/providers/refresh", "POST", ids ? { providers: ids } : {}, 150_000);
    emit("refreshed", next);
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
    const result = await props.api(props.base + "/provider-diagnostic/" + encodeURIComponent(id), "GET", undefined, 60_000);
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
  return (props.draft.providers[id] ??= { commandText: "", additionalModels: [] });
}
function toggleProvider(id: string) {
  if (!openProviders.value[id]) providerDraft(id);
  openProviders.value[id] = !openProviders.value[id];
}
function setEnabled(row: Row, enabled: boolean) {
  const conf = providerDraft(row.id);
  // Switching back to what the host already has leaves no change behind.
  if (props.saved?.providers?.[row.id]?.enabled === undefined && row.reported && enabled === row.reported.enabled)
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
  if (props.rows.some((r) => r.id === id)) {
    newProviderError.value = `${id} already exists on this host.`;
    return;
  }
  props.draft.providers[id] = { extends: newProviderBase.value, label: id, enabled: true, commandText: "", additionalModels: [] };
  openProviders.value[id] = true;
  newProviderId.value = "";
}
async function removeProvider(row: Row) {
  const d = props.draft;
  if (!row.saved) {
    delete d.providers[row.id];
    return;
  }
  const ok = await confirmAction({ title: `Remove ${row.label} from this host?`, message: "It is removed when you save. Metadata generation stops using it.", confirmLabel: "Remove", danger: true });
  if (!ok || props.draft !== d || d.removeProviders.includes(row.id)) return;
  d.removeProviders.push(row.id);
  // The daemon drops metadata entries for a removed provider; mirror that so the save verifies.
  if (d.metadataProviders) d.metadataProviders = d.metadataProviders.filter((p) => p.provider !== row.id);
  openProviders.value[row.id] = false;
}
function restoreProvider(id: string) {
  const d = props.draft;
  d.removeProviders = d.removeProviders.filter((x) => x !== id);
  if (props.saved) d.metadataProviders = restoreMetadataProviders(d.metadataProviders, toDraft(props.saved).metadataProviders, id);
}
</script>

<template>
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
    <div v-for="row in rows" :key="row.id" class="hs-provider" :class="{ 'is-open': openProviders[row.id], 'is-removed': row.removed }">
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
</template>
