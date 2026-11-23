<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ArchivedWorkspaceSummary, HostState } from "../shared/wire.ts";
import Icon from "./Icon.vue";
import ProviderIcon from "./ProviderIcon.vue";
import { useDialog } from "./use-dialog.ts";

const props = defineProps<{
  hosts: HostState[];
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}>();
const emit = defineEmits<{
  close: [];
  restored: [hostId: string, workspaceId: string];
}>();

const sheet = ref<HTMLElement | null>(null);
useDialog(sheet, () => emit("close"));

const query = ref("");
const items = ref<ArchivedWorkspaceSummary[]>([]);
const loading = ref(false);
const error = ref("");
const restoring = ref<string | null>(null);

const hostLabels = computed(() => new Map(props.hosts.map((h) => [h.id, h.label])));

async function load() {
  loading.value = true;
  error.value = "";
  const connected = props.hosts.filter((h) => h.state === "connected");
  try {
    const results = await Promise.allSettled(
      connected.map((h) => {
        const qs = query.value.trim() ? `?q=${encodeURIComponent(query.value.trim())}` : "";
        return props.api(`/hosts/${encodeURIComponent(h.id)}/archived-workspaces${qs}`) as Promise<ArchivedWorkspaceSummary[]>;
      }),
    );
    const merged: ArchivedWorkspaceSummary[] = [];
    for (const r of results) {
      if (r.status === "fulfilled" && Array.isArray(r.value)) merged.push(...r.value);
    }
    merged.sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt));
    items.value = merged;
  } catch (e) {
    error.value = (e as Error).message || "Could not load archived workspaces.";
  } finally {
    loading.value = false;
  }
}

async function restore(item: ArchivedWorkspaceSummary) {
  if (!item.workspaceId) return;
  const key = `${item.hostId}:${item.workspaceId}`;
  restoring.value = key;
  error.value = "";
  try {
    await props.api(`/hosts/${encodeURIComponent(item.hostId)}/workspaces/${encodeURIComponent(item.workspaceId)}/restore`, "POST", {});
    items.value = items.value.filter((x) => !(x.hostId === item.hostId && x.workspaceId === item.workspaceId));
    emit("restored", item.hostId, item.workspaceId);
  } catch (e) {
    error.value = (e as Error).message || "Could not restore workspace.";
  } finally {
    restoring.value = null;
  }
}

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

onMounted(() => void load());
</script>

<template>
  <div class="overlay" @mousedown.self="emit('close')">
    <section ref="sheet" class="sheet archived-sheet" role="dialog" aria-modal="true" aria-label="Archived workspaces" tabindex="-1">
      <header class="sheet-head">
        <h2>Archived workspaces</h2>
        <button type="button" class="icon-btn" aria-label="Close" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="archived-search">
        <form @submit.prevent="load">
          <input v-model="query" type="search" placeholder="Search archived workspaces…" aria-label="Search archived workspaces" />
          <button type="submit" class="btn btn-sm btn-outline" :disabled="loading">{{ loading ? "Loading…" : "Search" }}</button>
        </form>
      </div>
      <p v-if="error" class="setting-note is-error" role="alert">{{ error }}</p>
      <div class="archived-list">
        <p v-if="loading && !items.length" class="subtle archived-empty"><span class="spinner spinner-sm"></span> Loading archived workspaces…</p>
        <p v-else-if="!items.length" class="subtle archived-empty">No archived workspaces found.</p>
        <div v-for="item in items" :key="item.hostId + ':' + (item.workspaceId || item.id)" class="archived-row">
          <ProviderIcon :provider="item.provider" />
          <div class="grow">
            <div class="row-title">{{ item.name }}</div>
            <div class="row-sub">
              {{ item.project }}
              <template v-if="hosts.length > 1"> · {{ hostLabels.get(item.hostId) || item.hostId }}</template>
              · archived {{ ago(item.archivedAt) }}
            </div>
          </div>
          <button
            v-if="item.workspaceId"
            type="button"
            class="btn btn-sm btn-outline"
            :disabled="restoring === item.hostId + ':' + item.workspaceId"
            @click="restore(item)"
          >
            <Icon name="undo" :size="13" />{{ restoring === item.hostId + ':' + item.workspaceId ? "Restoring…" : "Restore" }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
