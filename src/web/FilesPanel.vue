<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import Icon from "./Icon.vue";

/** The workspace file tree. Directories load on expand; a file opens as a main-area tab. */
const props = defineProps<{
  hostId: string; cwd: string; api: (path: string) => Promise<any>; activePath?: string | null;
  /** A directory to expand to, select and scroll into view (a link pointed at it). */
  reveal?: { path: string; seq: number } | null;
}>();
const emit = defineEmits<{ open: [path: string] }>();

interface Entry { name: string; path: string; kind: "file" | "directory" | string; size: number }
const children = shallowRef(new Map<string, Entry[]>());
const expanded = ref(new Set<string>());
const loading = ref(new Set<string>());
const error = ref("");
const base = computed(() => `/hosts/${encodeURIComponent(props.hostId)}/fs`);
const q = (path: string) => `cwd=${encodeURIComponent(props.cwd)}&path=${encodeURIComponent(path)}`;

let inflight = new Map<string, Promise<void>>();
/** Bumped when the workspace changes: answers for the previous one are dropped. */
let generation = 0;
/** Loads a directory's entries; a second call while one is in flight waits for it. */
function load(path: string): Promise<void> {
  const running = inflight.get(path);
  if (running) return running;
  const map = inflight;
  const done = fetchEntries(path).finally(() => { if (map.get(path) === done) map.delete(path); });
  map.set(path, done);
  return done;
}
async function fetchEntries(path: string) {
  const current = generation;
  loading.value = new Set(loading.value).add(path);
  try {
    const result = await props.api(`${base.value}/list?${q(path)}`);
    if (current !== generation) return;
    const next = new Map(children.value);
    next.set(path, result.entries as Entry[]);
    children.value = next;
    error.value = "";
  } catch (e) {
    if (current === generation) error.value = (e as Error).message;
  } finally {
    if (current === generation) {
      const next = new Set(loading.value);
      next.delete(path);
      loading.value = next;
    }
  }
}
watch(() => [props.hostId, props.cwd], () => {
  generation++;
  inflight = new Map();
  loading.value = new Set();
  error.value = "";
  children.value = new Map();
  expanded.value = new Set();
  void load(".");
}, { immediate: true });

function toggle(entry: Entry) {
  const next = new Set(expanded.value);
  if (next.has(entry.path)) next.delete(entry.path);
  else {
    next.add(entry.path);
    if (!children.value.has(entry.path)) void load(entry.path);
  }
  expanded.value = next;
}
/** The visible rows: a depth-first walk over expanded directories only. */
const rows = computed(() => {
  const out: { entry: Entry; depth: number }[] = [];
  const walk = (path: string, depth: number) => {
    for (const entry of children.value.get(path) ?? []) {
      out.push({ entry, depth });
      if (entry.kind === "directory" && expanded.value.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk(".", 0);
  return out;
});

const tree = ref<HTMLElement | null>(null);
const revealed = ref<string | null>(null);
// The revealed directory stays selected until a file is chosen.
watch(() => props.activePath, () => (revealed.value = null));
watch(() => props.reveal?.seq, async () => {
  const target = props.reveal?.path;
  if (!target) return;
  const parts = target === "." ? [] : target.split("/").filter(Boolean);
  const current = generation;
  await load(".");
  for (let i = 1; i <= parts.length; i++) {
    if (current !== generation) return;
    const dir = parts.slice(0, i).join("/");
    if (!children.value.has(dir)) await load(dir);
    if (current !== generation) return;
    expanded.value = new Set(expanded.value).add(dir);
  }
  revealed.value = parts.join("/") || null;
  await nextTick();
  const row = Array.from(tree.value?.querySelectorAll<HTMLElement>(".tree-row") ?? []).find((el) => el.dataset.path === revealed.value);
  row?.scrollIntoView({ block: "center" });
  row?.focus({ preventScroll: true });
}, { immediate: true });

</script>

<template>
  <div class="files">
    <div class="files-head">
      <span class="files-root" :title="cwd">{{ cwd.split("/").filter(Boolean).pop() || cwd }}</span>
      <button class="icon-btn" title="Refresh" aria-label="Refresh files" @click="children = new Map(); expanded = new Set(); load('.')">
        <Icon name="refresh" :size="14" />
      </button>
    </div>
    <p v-if="error" class="files-error"><Icon name="alert" :size="13" />{{ error }}</p>
    <div ref="tree" class="tree" role="tree">
      <button
        v-for="r in rows"
        :key="r.entry.path"
        class="tree-row"
        :class="{ chosen: r.entry.path === activePath || r.entry.path === revealed }"
        :data-path="r.entry.path"
        role="treeitem"
        :aria-expanded="r.entry.kind === 'directory' ? expanded.has(r.entry.path) : undefined"
        :style="{ paddingLeft: 8 + r.depth * 14 + 'px' }"
        :title="r.entry.path"
        @click="r.entry.kind === 'directory' ? toggle(r.entry) : emit('open', r.entry.path)"
      >
        <Icon v-if="r.entry.kind === 'directory'" name="chevron" :size="11" class="tree-caret" :class="{ open: expanded.has(r.entry.path) }" />
        <span v-else class="tree-caret"></span>
        <Icon :name="r.entry.kind === 'directory' ? 'folder' : 'file'" :size="14" class="tree-icon" />
        <span class="tree-name">{{ r.entry.name }}</span>
        <span v-if="loading.has(r.entry.path)" class="spinner spinner-sm"></span>
      </button>
      <div v-if="!rows.length && loading.has('.')" class="files-empty"><span class="spinner"></span></div>
    </div>
  </div>
</template>

<style scoped>
.files { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.files-head { flex: none; display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 6px 0 10px; border-bottom: 1px solid var(--border); font-size: 12.5px; color: var(--fg-muted); }
.files-head .icon-btn { width: 26px; height: 26px; }
.files-root { flex: 1; font-weight: 600; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree { flex: 1; min-height: 0; overflow: auto; padding: 4px 4px 12px; }
.tree-row { display: flex; align-items: center; gap: 5px; width: 100%; height: 26px; padding-right: 8px; border-radius: 6px; font-size: 13px; color: var(--fg-muted); text-align: left; white-space: nowrap; }
.tree-row:hover { background: var(--hover); color: var(--fg); }
.tree-row.chosen { background: var(--selected); color: var(--fg); }
.tree-caret { flex: none; width: 11px; color: var(--fg-faint); transition: transform 0.1s; }
.tree-caret.open { transform: rotate(90deg); }
.tree-icon { flex: none; color: var(--fg-faint); }
.tree-name { overflow: hidden; text-overflow: ellipsis; }
.files-empty { display: grid; place-items: center; padding: 24px; }
.files-error { display: flex; gap: 6px; align-items: center; margin: 8px 10px; font-size: 12.5px; color: var(--danger); }
</style>
