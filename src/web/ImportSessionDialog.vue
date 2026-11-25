<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { HostState, ImportableSessionEntry, ImportableSessionsResponse } from "../shared/wire.ts";
import Icon from "./Icon.vue";
import { tildeHome } from "./format.ts";
import { relativeAge } from "./timeline-display.ts";
import { useDialog } from "./use-dialog.ts";

const props = defineProps<{
  hosts: HostState[];
  initialHostId: string | null;
  api: (path: string, method?: string, body?: unknown, timeoutMs?: number) => Promise<any>;
}>();
const emit = defineEmits<{
  close: [];
  imported: [key: string];
}>();

const sheet = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
useDialog(sheet, () => emit("close"));

const connected = computed(() => props.hosts.filter((h) => h.state === "connected"));
const hostId = ref(connected.value.find((h) => h.id === props.initialHostId)?.id ?? connected.value[0]?.id ?? "");
const query = ref("");
const providerFilter = ref("");
const limit = ref(50);

const entries = ref<ImportableSessionEntry[]>([]);
const providerErrors = ref<{ provider: string; message: string }[]>([]);
const filteredCount = ref(0);
const loading = ref(false);
const error = ref("");
const importingKey = ref<string | null>(null);

const providerOptions = computed(() => {
  const map = new Map<string, string>();
  for (const e of entries.value) map.set(e.providerId, e.providerLabel);
  return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
});

let loadSeq = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

async function load(append = false) {
  if (!hostId.value) return;
  const seq = ++loadSeq;
  loading.value = true;
  error.value = "";
  const params = new URLSearchParams();
  params.set("limit", String(limit.value));
  if (query.value.trim()) params.set("q", query.value.trim());
  if (providerFilter.value) params.set("provider", providerFilter.value);
  try {
    const res = (await props.api(
      `/hosts/${encodeURIComponent(hostId.value)}/importable-sessions?${params.toString()}`,
      "GET",
      undefined,
      30_000,
    )) as ImportableSessionsResponse;
    if (seq !== loadSeq) return;
    entries.value = Array.isArray(res.entries) ? res.entries : [];
    providerErrors.value = Array.isArray(res.providerErrors) ? res.providerErrors : [];
    filteredCount.value = res.filteredAlreadyImportedCount ?? 0;
  } catch (e) {
    if (seq !== loadSeq) return;
    // Preserve previous results on a failed load-more so slow provider scans don't blank the list.
    if (!append) entries.value = [];
    error.value = (e as Error).message || "Could not load CLI sessions.";
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

watch(hostId, () => {
  providerFilter.value = "";
  limit.value = 50;
  entries.value = [];
  providerErrors.value = [];
  void load();
}, { immediate: true });

watch(providerFilter, () => {
  limit.value = 50;
  void load();
});

watch(query, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    limit.value = 50;
    void load();
  }, 220);
});
onUnmounted(() => {
  clearTimeout(searchTimer);
});

function loadMore() {
  limit.value = Math.min(200, limit.value + 50);
  void load(true);
}

async function importOne(entry: ImportableSessionEntry) {
  if (!hostId.value || importingKey.value) return;
  const key = `${entry.providerId}:${entry.providerHandleId}`;
  importingKey.value = key;
  error.value = "";
  try {
    const res = await props.api(
      `/hosts/${encodeURIComponent(hostId.value)}/import-session`,
      "POST",
      {
        providerId: entry.providerId,
        providerHandleId: entry.providerHandleId,
        cwd: entry.cwd,
      },
      60_000,
    );
    if (res?.key) emit("imported", res.key);
    emit("close");
  } catch (e) {
    error.value = (e as Error).message || "Could not import session.";
  } finally {
    importingKey.value = null;
  }
}

onMounted(() => {
  void nextTick(() => searchInput.value?.focus());
});
</script>

<template>
  <div class="overlay" @mousedown.self="emit('close')">
    <section ref="sheet" class="sheet archived-sheet" role="dialog" aria-modal="true" aria-label="Import CLI session" tabindex="-1">
      <header class="sheet-head">
        <h2>Import CLI session</h2>
        <button type="button" class="icon-btn" aria-label="Close" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="archived-controls">
        <select v-if="connected.length > 1" v-model="hostId" aria-label="Host">
          <option v-for="h in connected" :key="h.id" :value="h.id">{{ h.label }}</option>
        </select>
        <input ref="searchInput" v-model="query" placeholder="Search recent CLI sessions…" aria-label="Search CLI sessions" />
        <select v-if="providerOptions.length > 1 || providerFilter" v-model="providerFilter" aria-label="Provider">
          <option value="">All providers</option>
          <option v-for="p in providerOptions" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
        <button type="button" class="icon-btn" :disabled="loading" title="Refresh" aria-label="Refresh" @click="load()">
          <Icon name="refresh" :size="14" />
        </button>
      </div>
      <p v-if="error" class="setting-note is-error" style="padding: 0 16px;" role="alert">{{ error }}</p>
      <div v-if="providerErrors.length" class="import-warnings" role="status">
        <span v-for="pe in providerErrors" :key="pe.provider" class="row-sub is-error">
          {{ pe.provider }}: {{ pe.message }}
        </span>
      </div>
      <div class="archived-list">
        <p v-if="loading && !entries.length" class="subtle" style="padding: 16px;"><span class="spinner spinner-sm"></span> Scanning recent sessions…</p>
        <p v-else-if="!entries.length" class="subtle" style="padding: 16px;">
          No importable CLI sessions found.
          <template v-if="filteredCount"> ({{ filteredCount }} already imported)</template>
        </p>
        <div v-for="e in entries" :key="`${e.providerId}:${e.providerHandleId}`" class="archived-row">
          <div class="grow">
            <div class="row-title">
              {{ e.title || e.firstPromptPreview || "(Untitled session)" }}
              <span class="hs-tag">{{ e.providerLabel }}</span>
            </div>
            <div v-if="e.title && e.firstPromptPreview" class="row-sub">{{ e.firstPromptPreview }}</div>
            <div class="row-sub mono">{{ tildeHome(e.cwd) }} · {{ relativeAge(Date.parse(e.lastActivityAt) || Date.now()) }}</div>
          </div>
          <button
            type="button"
            class="btn btn-sm btn-outline"
            :disabled="!!importingKey"
            @click="importOne(e)"
          >
            {{ importingKey === `${e.providerId}:${e.providerHandleId}` ? "Importing…" : "Import" }}
          </button>
        </div>
        <div v-if="entries.length >= limit && limit < 200" style="padding: 10px 16px; text-align: center;">
          <button type="button" class="btn btn-sm btn-ghost" :disabled="loading" @click="loadMore">
            {{ loading ? "Loading…" : "Load more" }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
