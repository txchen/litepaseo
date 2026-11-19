<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import Icon from "./Icon.vue";
import { openStream } from "./event-stream.ts";
import { isDark } from "./theme.ts";
import "@xterm/xterm/css/xterm.css";

/**
 * Terminals of the workspace, run by the host's daemon. xterm.js loads only when this panel
 * first opens; output arrives over one SSE stream per visible terminal, input is posted in
 * small batches. Terminals keep running on the host when the panel closes.
 */
const props = defineProps<{ hostId: string; cwd: string; visible: boolean; api: (path: string, method?: string, body?: unknown) => Promise<any> }>();

interface Term { id: string; name: string; title: string | null }
const terminals = ref<Term[]>([]);
const profiles = ref<{id:string;name:string}[]>([]), profileId = ref("");
const current = ref<string | null>(null);
const error = ref("");
const starting = ref(false);
const host = ref<HTMLElement | null>(null);
const base = () => `/hosts/${encodeURIComponent(props.hostId)}/terminals`;

type XTerm = import("@xterm/xterm").Terminal;
type Fit = import("@xterm/addon-fit").FitAddon;
const term = shallowRef<XTerm | null>(null);
let fit: Fit | null = null;
let stream: ReturnType<typeof openStream> | null = null;
let observer: ResizeObserver | undefined;
let lastSize = "";
let disposed = false;
let initializing: Promise<void> | null = null;

const THEMES = {
  dark: { background: "#141517", foreground: "#e4e4e7", cursor: "#e4e4e7", selectionBackground: "#3a3b42" },
  light: { background: "#fbfbfc", foreground: "#18181b", cursor: "#18181b", selectionBackground: "#d6d6dc" },
};

async function ensureTerminal() {
  if (term.value || !host.value || disposed) return;
  if (initializing) return initializing;
  initializing = setupTerminal().finally(() => { initializing = null; });
  return initializing;
}
async function setupTerminal() {
  const [{ Terminal }, { FitAddon }, { Unicode11Addon }, { WebglAddon }] = await Promise.all([
    import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-unicode11"), import("@xterm/addon-webgl"),
  ]);
  await document.fonts.ready;
  if (disposed || !host.value) return;
  const t = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono") || "monospace",
    fontSize: 14,
    lineHeight: 1.2,
    scrollback: 5000,
    cursorBlink: false,
    allowProposedApi: true,
    theme: isDark.value ? THEMES.dark : THEMES.light,
  });
  fit = new FitAddon();
  t.loadAddon(fit);
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = "11";
  t.open(host.value);
  // WebGL draws continuous box/block/Powerline glyphs. Keep DOM rendering as fallback.
  const webgl = new WebglAddon();
  try {
    t.loadAddon(webgl);
    webgl.onContextLoss(() => webgl.dispose());
  } catch {
    webgl.dispose();
  }
  t.onData(queueInput);
  term.value = t;
  observer = new ResizeObserver(() => resize());
  observer.observe(host.value);
  resize();
}
watch(() => props.visible, async (visible) => {
  if (!visible) return;
  await nextTick();
  resize();
  term.value?.focus();
});
watch(isDark, (dark) => term.value && (term.value.options.theme = dark ? THEMES.dark : THEMES.light));

// Input: keystrokes within one request round trip are sent together, in order. Each batch keeps
// the terminal it was typed into, so switching terminals (or workspaces) while a request is in
// flight cannot deliver earlier keystrokes to the newly shown terminal, or later ones to the old.
let queued: { url: string; data: string }[] = [];
let sending = false;
function queueInput(data: string) {
  if (!current.value) return;
  const url = `${base()}/${current.value}/input`;
  const last = queued[queued.length - 1];
  if (last?.url === url) last.data += data;
  else queued.push({ url, data });
  void drain();
}
async function drain() {
  if (sending) return;
  sending = true;
  while (queued.length) {
    const head = queued[0]!;
    const data = head.data.slice(0, 32 * 1024);
    head.data = head.data.slice(data.length);
    if (!head.data) queued.shift();
    try {
      await props.api(head.url, "POST", { data });
    } catch (e) {
      error.value = (e as Error).message;
      queued = queued.filter((q) => q.url !== head.url);
    }
  }
  sending = false;
}
function resize() {
  if (!term.value || !fit || !host.value?.clientWidth) return;
  fit.fit();
  const size = `${term.value.rows}x${term.value.cols}`;
  if (size === lastSize || !current.value) return;
  lastSize = size;
  void props.api(`${base()}/${current.value}/input`, "POST", { rows: term.value.rows, cols: term.value.cols }).catch(() => {});
}

function attach(id: string) {
  stream?.close();
  current.value = id;
  lastSize = "";
  term.value?.reset();
  stream = openStream({
    url: () => `/api${base()}/${id}/stream?rows=${term.value?.rows ?? 24}&cols=${term.value?.cols ?? 80}`,
    onMessage: (message) => {
      const m = message as { t: string; d?: string };
      if (m.t === "reset") term.value?.reset();
      else if (m.t === "o" && m.d) {
        let bytes: Uint8Array;
        try { bytes = Uint8Array.from(atob(m.d), (c) => c.charCodeAt(0)); }
        catch { return; } // a malformed chunk is dropped rather than breaking the stream
        term.value?.write(bytes);
      }
      else if (m.t === "exit") {
        term.value?.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
        void refresh();
      }
    },
  });
  resize();
  term.value?.focus();
}

const listUrl = () => `${base()}?cwd=${encodeURIComponent(props.cwd)}`;
async function refresh() {
  const url = listUrl();
  try {
    const list = await props.api(url);
    if (url !== listUrl()) return; // the workspace changed meanwhile
    terminals.value = list;
    error.value = "";
  } catch (e) {
    if (url === listUrl()) error.value = (e as Error).message;
  }
}
async function create() {
  starting.value = true;
  try {
    await ensureTerminal();
    const url = listUrl();
    const created = (await props.api(base(), "POST", { cwd: props.cwd, ...(profileId.value ? { profileId: profileId.value } : {}), rows: term.value?.rows ?? 24, cols: term.value?.cols ?? 80 })) as Term;
    if (url !== listUrl()) return; // created in the previous workspace; it lists there
    terminals.value = [...terminals.value, created];
    attach(created.id);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    starting.value = false;
  }
}
async function kill(id: string) {
  try {
    await props.api(`${base()}/${id}`, "DELETE");
  } catch {
    /* already gone */
  }
  terminals.value = terminals.value.filter((t) => t.id !== id);
  if (current.value === id) {
    stream?.close();
    stream = null;
    current.value = null;
    term.value?.reset();
    if (terminals.value[0]) attach(terminals.value[0].id);
  }
}

/** Each workspace switch restarts init; an older run stops at its next await. */
let initGeneration = 0;
async function init() {
  const generation = ++initGeneration;
  profiles.value = []; profileId.value = ""; terminals.value = [];
  const host = props.hostId;
  void props.api(`/hosts/${encodeURIComponent(host)}/settings`).then(r => { if (host === props.hostId) profiles.value = r.config.terminalProfiles ?? []; }).catch(() => {});
  stream?.close();
  stream = null;
  current.value = null;
  await refresh();
  if (generation !== initGeneration) return;
  await nextTick();
  await ensureTerminal();
  if (disposed || generation !== initGeneration) return;
  if (terminals.value[0]) attach(terminals.value[0].id);
}
onMounted(() => { void init().catch((e) => { error.value = (e as Error).message; }); });
watch(() => [props.hostId, props.cwd], init);

onUnmounted(() => {
  disposed = true;
  stream?.close();
  observer?.disconnect();
  term.value?.dispose();
});
</script>

<template>
  <div class="terminals">
    <div class="term-tabs">
      <div v-for="(t, i) in terminals" :key="t.id" class="term-tab" :class="{ chosen: t.id === current }">
        <button type="button" class="term-open" :title="t.title || t.name" :aria-current="t.id === current ? 'true' : undefined" @click="attach(t.id)">
          <Icon name="terminal" :size="12" /><span>{{ t.title || t.name || `Terminal ${i + 1}` }}</span>
        </button>
        <button type="button" class="term-close" :aria-label="'Close ' + (t.title || t.name || `Terminal ${i + 1}`)" @click="kill(t.id)"><Icon name="close" :size="11" /></button>
      </div>
      <select v-if="profiles.length" v-model="profileId" aria-label="New terminal profile" style="max-width: 150px"><option value="">Default shell</option><option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option></select>
      <button class="icon-btn term-new" title="New terminal" aria-label="New terminal" :disabled="starting" @click="create">
        <Icon name="plus" :size="14" />
      </button>
    </div>
    <p v-if="error" class="term-error"><Icon name="alert" :size="13" />{{ error }}</p>
    <div class="term-body">
      <div ref="host" class="term-host" :class="{ hidden: !current }"></div>
      <div v-if="!current" class="term-empty">
        <p>No terminal open in this workspace.</p>
        <button class="btn btn-outline" :disabled="starting" @click="create"><Icon name="terminal" :size="14" />Open terminal</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminals { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
.term-tabs { flex: none; display: flex; align-items: center; gap: 2px; height: 36px; padding: 0 6px; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none; }
.term-tab { flex: none; display: inline-flex; align-items: center; gap: 2px; max-width: 180px; height: 26px; padding: 0 4px 0 0; border-radius: 6px; font-size: 12px; color: var(--fg-muted); }
.term-open { display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 100%; padding: 0 2px 0 8px; border-radius: 6px; }
.term-open span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.term-tab.chosen { background: var(--selected); color: var(--fg); }
.term-close { flex: none; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 4px; opacity: 0.6; }
.term-close:focus-visible { opacity: 1; }
.term-close:hover { background: var(--hover); opacity: 1; }
@media (pointer: coarse) { .term-tabs { height: 42px; } .term-tab { height: 34px; } .term-close { width: 30px; height: 30px; } }
.term-new { width: 26px; height: 26px; }
.term-error { display: flex; gap: 6px; align-items: center; margin: 6px 10px; font-size: 12.5px; color: var(--danger); }
.term-body { position: relative; flex: 1; min-height: 0; }
.term-host { position: absolute; inset: 0; padding: 6px 4px 4px 8px; background: v-bind("isDark ? '#141517' : '#fbfbfc'"); }
.term-host.hidden { visibility: hidden; }
.term-empty { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 10px; font-size: 13px; color: var(--fg-muted); }
.term-empty p { margin: 0; }
</style>
