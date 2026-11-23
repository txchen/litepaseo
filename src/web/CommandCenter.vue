<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { AgentSummary, ArchivedWorkspaceSummary, HostState, WorkspaceSummary } from "../shared/wire.ts";
import Icon from "./Icon.vue";
import { useDialog } from "./use-dialog.ts";

export interface CommandAction {
  id: string;
  label: string;
  sub?: string;
  icon: string;
  shortcut?: string;
  run: () => void;
}

const props = defineProps<{
  workspaces: WorkspaceSummary[];
  hosts: HostState[];
  activeAgent: AgentSummary | null;
  actions: CommandAction[];
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}>();
const emit = defineEmits<{
  close: [];
  selectWorkspace: [key: string];
  openFile: [path: string];
  restoreArchived: [hostId: string, workspaceId: string];
}>();

type Mode = "workspaces" | "files" | "actions";
const sheet = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
useDialog(sheet, () => emit("close"));

const mode = ref<Mode>("workspaces");
const query = ref("");
const selectedIndex = ref(0);
const hostLabels = computed(() => new Map(props.hosts.map((h) => [h.id, h.label])));

// ---- Archived search (loaded once on demand when searching workspaces) -------------------------
const archived = ref<ArchivedWorkspaceSummary[]>([]);
const archivedLoaded = ref(false);
async function loadArchived() {
  if (archivedLoaded.value) return;
  archivedLoaded.value = true;
  const connected = props.hosts.filter((h) => h.state === "connected");
  const results = await Promise.allSettled(
    connected.map((h) => props.api(`/hosts/${encodeURIComponent(h.id)}/archived-workspaces`) as Promise<ArchivedWorkspaceSummary[]>),
  );
  const merged: ArchivedWorkspaceSummary[] = [];
  for (const r of results) if (r.status === "fulfilled" && Array.isArray(r.value)) merged.push(...r.value);
  merged.sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt));
  archived.value = merged;
}

// ---- Files search (debounced against current workspace) ----------------------------------------
const files = ref<string[]>([]);
const filesLoading = ref(false);
let fileTimer: ReturnType<typeof setTimeout> | undefined;
let fileSeq = 0;

async function searchFiles() {
  const agent = props.activeAgent;
  if (!agent) {
    files.value = [];
    return;
  }
  const seq = ++fileSeq;
  filesLoading.value = true;
  try {
    const res = await props.api(
      `/hosts/${encodeURIComponent(agent.hostId)}/fs/search?cwd=${encodeURIComponent(agent.cwd)}&q=${encodeURIComponent(query.value.trim())}&limit=40`,
    );
    if (seq === fileSeq) files.value = Array.isArray(res.files) ? res.files : [];
  } catch {
    if (seq === fileSeq) files.value = [];
  } finally {
    if (seq === fileSeq) filesLoading.value = false;
  }
}

watch([mode, query], ([m, q]) => {
  selectedIndex.value = 0;
  if (m === "files") {
    clearTimeout(fileTimer);
    fileTimer = setTimeout(() => void searchFiles(), q ? 120 : 0);
  } else if (m === "workspaces" && q.trim().length >= 2) {
    void loadArchived();
  }
});

interface ResultRow {
  key: string;
  icon: string;
  title: string;
  sub: string;
  badge?: string;
  shortcut?: string;
  run: () => void;
}

const results = computed<ResultRow[]>(() => {
  const q = query.value.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const matches = (text: string) => !tokens.length || tokens.every((t) => text.toLowerCase().includes(t));

  if (mode.value === "workspaces") {
    const activeRows: ResultRow[] = props.workspaces
      .filter((w) => matches(`${w.name} ${w.project} ${w.branch ?? ""} ${hostLabels.value.get(w.hostId) ?? ""}`))
      .slice(0, 30)
      .map((w) => ({
        key: "ws:" + w.key,
        icon: "chat",
        title: w.name,
        sub: [w.project, w.branch, props.hosts.length > 1 ? hostLabels.value.get(w.hostId) : ""].filter(Boolean).join(" · "),
        badge: w.attention ? "needs input" : w.state === "running" ? "running" : undefined,
        run: () => {
          emit("selectWorkspace", w.key);
          emit("close");
        },
      }));
    const archivedRows: ResultRow[] = q
      ? archived.value
          .filter((a) => a.workspaceId && matches(`${a.name} ${a.project} ${hostLabels.value.get(a.hostId) ?? ""}`))
          .slice(0, 12)
          .map((a) => ({
            key: `arch:${a.hostId}:${a.workspaceId}`,
            icon: "archive",
            title: a.name,
            sub: `${a.project} · archived`,
            badge: "restore",
            run: () => {
              if (a.workspaceId) emit("restoreArchived", a.hostId, a.workspaceId);
              emit("close");
            },
          }))
      : [];
    return [...activeRows, ...archivedRows];
  }

  if (mode.value === "files") {
    return files.value.map((f) => ({
      key: "file:" + f,
      icon: "file",
      title: f.split("/").pop() || f,
      sub: f,
      run: () => {
        emit("openFile", f);
        emit("close");
      },
    }));
  }

  return props.actions
    .filter((a) => matches(`${a.label} ${a.sub ?? ""}`))
    .map((a) => ({
      key: "act:" + a.id,
      icon: a.icon,
      title: a.label,
      sub: a.sub ?? "",
      shortcut: a.shortcut,
      run: () => {
        emit("close");
        a.run();
      },
    }));
});

const TABS: { id: Mode; label: string }[] = [
  { id: "workspaces", label: "Workspaces" },
  { id: "files", label: "Files" },
  { id: "actions", label: "Actions" },
];

function onKey(event: KeyboardEvent) {
  if (event.key === "Tab") {
    event.preventDefault();
    const idx = TABS.findIndex((t) => t.id === mode.value);
    const next = TABS[(idx + (event.shiftKey ? TABS.length - 1 : 1)) % TABS.length]!;
    mode.value = next.id;
    return;
  }
  if (event.key === "ArrowDown" && results.value.length) {
    event.preventDefault();
    selectedIndex.value = (selectedIndex.value + 1) % results.value.length;
    return;
  }
  if (event.key === "ArrowUp" && results.value.length) {
    event.preventDefault();
    selectedIndex.value = (selectedIndex.value - 1 + results.value.length) % results.value.length;
    return;
  }
  if (event.key === "Enter" && results.value[selectedIndex.value]) {
    event.preventDefault();
    results.value[selectedIndex.value]!.run();
  }
}

onMounted(() => {
  void nextTick(() => inputEl.value?.focus());
});
</script>

<template>
  <div class="overlay cc-overlay" @mousedown.self="emit('close')">
    <section ref="sheet" class="sheet cc-sheet" role="dialog" aria-modal="true" aria-label="Command center" tabindex="-1" @keydown="onKey">
      <div class="cc-input-row">
        <Icon name="search" :size="16" class="cc-search-icon" />
        <input
          ref="inputEl"
          v-model="query"
          type="search"
          class="cc-input"
          :placeholder="mode === 'workspaces' ? 'Jump to workspace or archived session…' : mode === 'files' ? 'Search files in current workspace…' : 'Run an action…'"
          aria-label="Command center search"
        />
        <kbd class="cc-kbd">Esc</kbd>
      </div>
      <div class="cc-tabs" role="tablist">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          type="button"
          role="tab"
          class="cc-tab"
          :class="{ chosen: mode === tab.id }"
          :aria-selected="mode === tab.id"
          :disabled="tab.id === 'files' && !activeAgent"
          @click="mode = tab.id; inputEl?.focus()"
        >
          {{ tab.label }}
        </button>
        <span class="cc-hint">Tab to switch</span>
      </div>
      <div class="cc-list" role="listbox">
        <p v-if="mode === 'files' && filesLoading && !results.length" class="cc-empty"><span class="spinner spinner-sm"></span> Searching files…</p>
        <p v-else-if="!results.length" class="cc-empty">
          {{ mode === "files" && !activeAgent ? "Open a conversation to search its files." : "No matches." }}
        </p>
        <button
          v-for="(item, i) in results"
          :key="item.key"
          type="button"
          role="option"
          class="cc-item"
          :class="{ active: i === selectedIndex }"
          :aria-selected="i === selectedIndex"
          @click="item.run()"
          @pointerenter="selectedIndex = i"
        >
          <Icon :name="item.icon" :size="15" class="cc-item-icon" />
          <span class="cc-item-body">
            <span class="cc-item-title">{{ item.title }}</span>
            <span v-if="item.sub" class="cc-item-sub">{{ item.sub }}</span>
          </span>
          <span v-if="item.badge" class="cc-badge">{{ item.badge }}</span>
          <kbd v-if="item.shortcut" class="cc-kbd">{{ item.shortcut }}</kbd>
        </button>
      </div>
    </section>
  </div>
</template>
