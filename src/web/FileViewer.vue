<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { loadMarkstream, markstream } from "./markstream-loader.ts";

/** A workspace file opened as a main-area tab: code with line numbers, Markdown, or an image. */
const props = defineProps<{ hostId: string; cwd: string; path: string; api: (path: string) => Promise<any> }>();

const file = ref<{ path: string; kind: string; mime: string; size: number; text?: string; truncated?: boolean; modifiedAt?: string } | null>(null);
const error = ref("");
const loading = ref(false);
const rendered = ref(true);
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

const rawUrl = computed(() => `/api${base.value}/raw?${q.value}`);
/** Two text nodes however long the file: a gutter of numbers and the text itself. */
const gutter = computed(() => {
  const text = file.value?.text ?? "";
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return Array.from({ length: count }, (_, i) => i + 1).join("\n");
});
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const copied = ref(false);
async function copyPath() {
  await navigator.clipboard?.writeText(`${props.cwd.replace(/\/$/, "")}/${props.path}`).catch(() => {});
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
    <div class="file-body">
      <div v-if="loading && !file" class="timeline-empty"><span class="spinner"></span></div>
      <p v-else-if="error" class="file-error"><Icon name="alert" :size="13" />{{ error }}</p>
      <img v-else-if="isImage" :src="rawUrl" :alt="path" class="file-image" />
      <div v-else-if="isMarkdown && rendered" class="file-markdown">
        <component :is="markstream" v-if="markstream" :content="file?.text ?? ''" :final="true" />
        <pre v-else class="file-text wrap">{{ file?.text }}</pre>
      </div>
      <template v-else-if="file?.text !== undefined">
        <div class="code-wrap">
          <pre class="code-gutter" aria-hidden="true">{{ gutter }}</pre>
          <pre class="file-text">{{ file.text }}</pre>
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
.file-markdown { max-width: 780px; margin: 0 auto; padding: 20px 24px 40px; }
.code-wrap { display: flex; min-width: max-content; }
.code-gutter { flex: none; margin: 0; padding: 10px 10px 10px 14px; font: 12.5px/1.6 var(--mono); text-align: right; color: var(--fg-faint); user-select: none; border-right: 1px solid var(--border); }
.file-text { margin: 0; padding: 10px 16px; font: 12.5px/1.6 var(--mono); color: var(--fg); white-space: pre; tab-size: 4; }
.file-text.wrap { white-space: pre-wrap; }
</style>
