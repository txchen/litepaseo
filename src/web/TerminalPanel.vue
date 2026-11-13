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

// Input: keystrokes within one request round trip are sent together, in order.
let queued = "";
let sending = false;
function queueInput(data: string) {
  queued += data;
  void drain();
}
async function drain() {
  if (sending || !queued || !current.value) return;
  sending = true;
  const id = current.value;
  while (queued) {
    const data = queued.slice(0, 32 * 1024);
    queued = queued.slice(data.length);
    try {
      await props.api(`${base()}/${id}/input`, "POST", { data });
    } catch (e) {
      error.value = (e as Error).message;
      queued = "";
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
      else if (m.t === "o" && m.d) term.value?.write(Uint8Array.from(atob(m.d), (c) => c.charCodeAt(0)));
      else if (m.t === "exit") {
        term.value?.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
        void refresh();
      }
    },
  });
  resize();
  term.value?.focus();
}

async function refresh() {
  try {
    terminals.value = await props.api(`${base()}?cwd=${encodeURIComponent(props.cwd)}`);
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function create() {
  starting.value = true;
  try {
    await ensureTerminal();
    const created = (await props.api(base(), "POST", { cwd: props.cwd, rows: term.value?.rows ?? 24, cols: term.value?.cols ?? 80 })) as Term;
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

async function init() {
  stream?.close();
  stream = null;
  current.value = null;
  await refresh();
  await nextTick();
  await ensureTerminal();
  if (disposed) return;
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
      <button
        v-for="(t, i) in terminals"
        :key="t.id"
        class="term-tab"
        :class="{ chosen: t.id === current }"
        :title="t.title || t.name"
        @click="attach(t.id)"
      >
        <Icon name="terminal" :size="12" /><span>{{ t.title || t.name || `Terminal ${i + 1}` }}</span>
        <span class="term-close" role="button" :aria-label="'Close ' + (t.title || t.name)" @click.stop="kill(t.id)"><Icon name="close" :size="11" /></span>
      </button>
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
.term-tab { flex: none; display: inline-flex; align-items: center; gap: 6px; max-width: 180px; height: 26px; padding: 0 6px 0 8px; border-radius: 6px; font-size: 12px; color: var(--fg-muted); }
.term-tab span:not(.term-close) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.term-tab.chosen { background: var(--selected); color: var(--fg); }
.term-close { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 4px; opacity: 0.6; }
.term-close:hover { background: var(--hover); opacity: 1; }
.term-new { width: 26px; height: 26px; }
.term-error { display: flex; gap: 6px; align-items: center; margin: 6px 10px; font-size: 12.5px; color: var(--danger); }
.term-body { position: relative; flex: 1; min-height: 0; }
.term-host { position: absolute; inset: 0; padding: 6px 4px 4px 8px; background: v-bind("isDark ? '#141517' : '#fbfbfc'"); }
.term-host.hidden { visibility: hidden; }
.term-empty { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 10px; font-size: 13px; color: var(--fg-muted); }
.term-empty p { margin: 0; }
</style>
