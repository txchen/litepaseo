<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { loadMarkstream, markstream } from "./markstream-loader.ts";
import { highlight, languageFor } from "./highlight.ts";
import { parseFileLink, rewriteFileImages, rewriteFileLinks, type FileViewState, type LineRange } from "./timeline-display.ts";

/** A workspace file opened as a main-area tab: code with line numbers, Markdown, or an image. */
const props = defineProps<{
  hostId: string; cwd: string; path: string; api: (path: string) => Promise<any>; session?: string;
  /** Lines to scroll to and mark, once per `seq`: returning to the tab does not jump again. */
  jump?: LineRange & { seq: number };
  /** Where the reader left this tab (scroll, rendered or source, marked lines), to restore. */
  view?: FileViewState;
  /** Identifies the tab in the `view` event (sent after the parent may have moved on). */
  viewKey?: string;
}>();
/**
 * `open`: another workspace file a Markdown link points at (a path relative to `cwd`);
 * `reveal`: a workspace directory one points at.
 * `view`: the tab's state as it closes or is switched away from, for `view` next time.
 */
const emit = defineEmits<{ open: [path: string, range?: Partial<LineRange>]; reveal: [path: string]; view: [key: string, state: FileViewState] }>();

const file = ref<{ path: string; kind: string; mime: string; size: number; text?: string; truncated?: boolean; modifiedAt?: string } | null>(null);
const error = ref("");
const loading = ref(false);
const rendered = ref(props.view?.rendered ?? true);
const base = computed(() => `/hosts/${encodeURIComponent(props.hostId)}/fs`);
const q = computed(() => `cwd=${encodeURIComponent(props.cwd)}&path=${encodeURIComponent(props.path)}`);
const isImage = computed(() => /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(props.path));
const isMarkdown = computed(() => /\.(md|markdown|mdx)$/i.test(props.path) && file.value?.text !== undefined);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    file.value = await props.api(`${base.value}/read?${q.value}`);
    if (isMarkdown.value) void loadMarkstream();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
watch(() => [props.hostId, props.cwd, props.path], load, { immediate: true });

/** The file's absolute path and directory: relative links in Markdown resolve against it. */
const fullPath = computed(() => props.path.startsWith("/") || props.path.startsWith("~") ? props.path : `${props.cwd.replace(/\/$/, "")}/${props.path}`);
const markdownText = computed(() => {
  const text = file.value?.text ?? "";
  if (!props.session) return text;
  const dir = fullPath.value.slice(0, fullPath.value.lastIndexOf("/")) || "/";
  const context = { session: props.session, cwd: dir, workspace: props.cwd };
  return rewriteFileLinks(rewriteFileImages(text, { ...context, rawBase: `/api${base.value}` }), context);
});
const notice = ref("");
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function showNotice(text: string) {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 4000);
}
/** Links rewritten by rewriteFileLinks: open the file in another tab, or copy an outside path. */
function onMarkdownClick(event: MouseEvent) {
  const link = (event.target as HTMLElement | null)?.closest?.("a");
  const target = parseFileLink(link?.getAttribute("href"));
  if (!target) return;
  if (target.kind === "copy") {
    event.preventDefault();
    const fallback = () => showNotice(`Can't open this here. Path: ${target.path}`);
    if (navigator.clipboard) navigator.clipboard.writeText(target.path).then(() => showNotice(`Copied path: ${target.path}`), fallback);
    else fallback();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (target.kind === "reveal") emit("reveal", target.path);
  else emit("open", target.path, target);
}

/**
 * Line jumps: a line only exists in the numbered source view (rendered Markdown switches to
 * source). Each line is one row of the gutter, so its position is (line - 1) * line height.
 */
const body = ref<HTMLElement | null>(null);
const mark = ref<{ top: number; height: number } | null>(props.view?.mark ?? null);
/** The last jump carried out; a jump is a one-time instruction, not part of the tab. */
let jumped = props.view?.jumped ?? 0;
let restored = false;
const lineCount = computed(() => {
  const text = file.value?.text ?? "";
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
});
watch([() => props.jump?.seq, () => file.value], async () => {
  if (!file.value) return;
  const jump = props.jump;
  if (jump && jump.seq !== jumped && file.value.text !== undefined) {
    jumped = jump.seq;
    restored = true;
    if (/\.(md|markdown|mdx)$/i.test(props.path)) rendered.value = false;
    await nextTick();
    const gutter = body.value?.querySelector<HTMLElement>(".code-gutter");
    if (!body.value || !gutter) return;
    const style = getComputedStyle(gutter);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const first = Math.min(jump.line, lineCount.value);
    const last = Math.min(Math.max(jump.end ?? first, first), lineCount.value);
    mark.value = { top: parseFloat(style.paddingTop) + (first - 1) * lineHeight, height: (last - first + 1) * lineHeight };
    body.value.scrollTop = Math.max(0, mark.value.top - body.value.clientHeight / 3);
    return;
  }
  // Back on this tab: the place the reader left it (layout may settle a frame later).
  if (restored) return;
  restored = true;
  const top = props.view?.scrollTop ?? 0;
  if (!top) return;
  await nextTick();
  if (body.value) body.value.scrollTop = top;
  requestAnimationFrame(() => {
    if (body.value && body.value.scrollTop < top) body.value.scrollTop = top;
  });
}, { immediate: true });
onBeforeUnmount(() => {
  if (props.viewKey) emit("view", props.viewKey, { rendered: rendered.value, scrollTop: body.value?.scrollTop ?? 0, mark: mark.value, jumped });
});

const rawUrl = computed(() => `/api${base.value}/raw?${q.value}`);
/** Two text nodes however long the file: a gutter of numbers and the text itself. */
const gutter = computed(() => Array.from({ length: lineCount.value }, (_, i) => i + 1).join("\n"));
/** Highlighted file text, or null for plain (unknown language, or too large to tokenize). */
const highlighted = computed(() => file.value?.text === undefined ? null : highlight(file.value.text, languageFor(props.path)));
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const copied = ref(false);
async function copyPath() {
  await navigator.clipboard?.writeText(fullPath.value).catch(() => {});
  copied.value = true;
  setTimeout(() => (copied.value = false), 1200);
}
</script>

<template>
  <div class="file-view">
    <div class="file-bar">
      <Icon name="file" :size="14" class="file-bar-icon" />
      <span class="file-bar-path" :title="path">{{ path }}</span>
      <span v-if="file" class="file-bar-meta">{{ size(file.size) }}</span>
      <button v-if="isMarkdown" class="icon-btn" :title="rendered ? 'Show source' : 'Show rendered'" @click="rendered = !rendered">
        <Icon :name="rendered ? 'terminal' : 'eye'" :size="14" />
      </button>
      <button class="icon-btn" title="Reload" aria-label="Reload file" @click="load"><Icon name="refresh" :size="14" /></button>
      <button class="icon-btn" :title="copied ? 'Copied' : 'Copy path'" aria-label="Copy path" @click="copyPath">
        <Icon :name="copied ? 'check' : 'copy'" :size="14" />
      </button>
    </div>
    <div ref="body" class="file-body">
      <div v-if="loading && !file" class="timeline-empty"><span class="spinner"></span></div>
      <p v-else-if="error" class="file-error"><Icon name="alert" :size="13" />{{ error }}</p>
      <img v-else-if="isImage" :src="rawUrl" :alt="path" class="file-image" />
      <div v-else-if="isMarkdown && rendered" class="file-markdown" @click="onMarkdownClick">
        <p v-if="notice" class="file-link-notice" role="status">{{ notice }}</p>
        <component :is="markstream" v-if="markstream" :content="markdownText" :final="true" />
        <pre v-else class="file-text wrap">{{ file?.text }}</pre>
      </div>
      <template v-else-if="file?.text !== undefined">
        <div class="code-wrap">
          <div v-if="mark" class="line-mark" :style="{ top: mark.top + 'px', height: mark.height + 'px' }" aria-hidden="true"></div>
          <pre class="code-gutter" aria-hidden="true">{{ gutter }}</pre>
          <pre v-if="highlighted !== null" class="file-text hljs" v-html="highlighted"></pre>
          <pre v-else class="file-text">{{ file.text }}</pre>
        </div>
        <p v-if="file.truncated" class="file-note">Showing the first 1 MB.</p>
      </template>
      <p v-else-if="file" class="file-note">{{ file.mime || file.kind }} · not shown as text</p>
    </div>
  </div>
</template>

<style scoped>
.file-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.file-bar { flex: none; display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 10px 0 16px; border-bottom: 1px solid var(--border); font-size: 12.5px; color: var(--fg-muted); }
.file-bar .icon-btn { width: 28px; height: 28px; }
.file-bar-icon { flex: none; color: var(--fg-faint); }
.file-bar-path { flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-bar-meta { flex: none; font-size: 11.5px; color: var(--fg-faint); }
.file-body { flex: 1; min-height: 0; overflow: auto; }
.file-error { display: flex; gap: 6px; align-items: center; margin: 16px; font-size: 13px; color: var(--danger); }
.file-note { margin: 8px 16px 16px; font-size: 12px; color: var(--fg-faint); }
.file-image { display: block; max-width: calc(100% - 32px); margin: 16px auto; border-radius: 8px; }
.file-link-notice { position: sticky; top: 0; z-index: 1; margin: 0 0 12px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-1); font-size: 12px; color: var(--fg-muted); overflow-wrap: anywhere; }
.file-markdown { max-width: 780px; margin: 0 auto; padding: 20px 24px 40px; }
.code-wrap { position: relative; display: flex; min-width: max-content; }
.line-mark { position: absolute; left: 0; right: 0; background: var(--accent-soft); border-left: 2px solid var(--accent); pointer-events: none; }
.code-gutter { flex: none; margin: 0; padding: 10px 10px 10px 14px; font: 12.5px/1.6 var(--mono); text-align: right; color: var(--fg-faint); user-select: none; border-right: 1px solid var(--border); }
.file-text { margin: 0; padding: 10px 16px; font: 12.5px/1.6 var(--mono); color: var(--fg); white-space: pre; tab-size: 4; }
.file-text.wrap { white-space: pre-wrap; }
</style>
