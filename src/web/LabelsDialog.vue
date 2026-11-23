<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { WorkspaceLabelColor, WorkspaceLabelDef, WorkspaceSummary } from "../shared/wire.ts";
import Icon from "./Icon.vue";
import { useDialog } from "./use-dialog.ts";

const COLORS: WorkspaceLabelColor[] = ["violet", "sky", "emerald", "orange", "pink", "indigo", "teal", "red", "amber", "blue"];

const props = defineProps<{
  thread: WorkspaceSummary;
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}>();
const emit = defineEmits<{ close: [] }>();

const sheet = ref<HTMLElement | null>(null);
useDialog(sheet, () => emit("close"));

const labels = ref<WorkspaceLabelDef[]>([]);
const assigned = ref<Set<string>>(new Set(props.thread.labels ?? []));
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const newName = ref("");
const newColor = ref<WorkspaceLabelColor>("blue");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await props.api(`/hosts/${encodeURIComponent(props.thread.hostId)}/labels`);
    labels.value = Array.isArray(res.labels) ? res.labels : [];
  } catch (e) {
    error.value = (e as Error).message || "Could not load labels.";
  } finally {
    loading.value = false;
  }
}

async function toggleLabel(def: WorkspaceLabelDef) {
  busy.value = true;
  error.value = "";
  const next = !assigned.value.has(def.name);
  try {
    await props.api(
      `/hosts/${encodeURIComponent(props.thread.hostId)}/workspaces/${encodeURIComponent(props.thread.id)}/labels`,
      "POST",
      { name: def.name, color: def.color, assigned: next },
    );
    const copy = new Set(assigned.value);
    if (next) copy.add(def.name);
    else copy.delete(def.name);
    assigned.value = copy;
  } catch (e) {
    error.value = (e as Error).message || "Could not update label.";
  } finally {
    busy.value = false;
  }
}

async function createAndAssign() {
  const name = newName.value.trim();
  if (!name) return;
  busy.value = true;
  error.value = "";
  try {
    await props.api(
      `/hosts/${encodeURIComponent(props.thread.hostId)}/workspaces/${encodeURIComponent(props.thread.id)}/labels`,
      "POST",
      { name, color: newColor.value, assigned: true },
    );
    newName.value = "";
    const copy = new Set(assigned.value);
    copy.add(name);
    assigned.value = copy;
    await load();
  } catch (e) {
    error.value = (e as Error).message || "Could not create label.";
  } finally {
    busy.value = false;
  }
}

async function deleteLabel(name: string) {
  busy.value = true;
  error.value = "";
  try {
    await props.api(`/hosts/${encodeURIComponent(props.thread.hostId)}/labels/${encodeURIComponent(name)}`, "DELETE");
    const copy = new Set(assigned.value);
    copy.delete(name);
    assigned.value = copy;
    labels.value = labels.value.filter((l) => l.name !== name);
  } catch (e) {
    error.value = (e as Error).message || "Could not delete label.";
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="overlay" @mousedown.self="emit('close')">
    <section ref="sheet" class="sheet labels-sheet" role="dialog" aria-modal="true" aria-label="Workspace labels" tabindex="-1">
      <header class="sheet-head">
        <h2>Labels · {{ thread.name }}</h2>
        <button type="button" class="icon-btn" aria-label="Close" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <p v-if="error" class="setting-note is-error" role="alert">{{ error }}</p>
      <div class="labels-list">
        <p v-if="loading && !labels.length" class="row-sub">Loading labels…</p>
        <p v-else-if="!labels.length" class="row-sub">No labels on this host yet. Create one below.</p>
        <div v-for="l in labels" :key="l.name" class="label-item">
          <button
            type="button"
            class="label-toggle"
            :class="{ chosen: assigned.has(l.name) }"
            :disabled="busy"
            @click="toggleLabel(l)"
          >
            <span class="label-dot" :class="'lc-' + l.color"></span>
            <span class="grow">{{ l.name }}</span>
            <Icon v-if="assigned.has(l.name)" name="check" :size="14" />
          </button>
          <button type="button" class="icon-btn" :disabled="busy" title="Delete label from host" aria-label="Delete label" @click="deleteLabel(l.name)">
            <Icon name="trash" :size="13" />
          </button>
        </div>
      </div>
      <form class="label-create" @submit.prevent="createAndAssign">
        <input v-model="newName" placeholder="New label name…" maxlength="60" :disabled="busy" />
        <div class="label-colors" role="radiogroup" aria-label="Label color">
          <button
            v-for="c in COLORS"
            :key="c"
            type="button"
            class="label-swatch"
            :class="['lc-' + c, { chosen: newColor === c }]"
            :aria-checked="newColor === c"
            :title="c"
            @click="newColor = c"
          ></button>
        </div>
        <button type="submit" class="btn btn-sm btn-primary" :disabled="busy || !newName.trim()">Add</button>
      </form>
    </section>
  </div>
</template>
