<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AttachmentStore } from "./attachment-store.ts";
import Icon from "./Icon.vue";
const props = defineProps<{ store: AttachmentStore; agentKey: string; base: string; busy: boolean }>();
const caps = ref<{ images: boolean; files: boolean; maxBytes: number; note?: string } | null>(null);
const error = ref("");
const supportRetry = ref(0);
const picker = ref<HTMLInputElement | null>(null);
const entries = computed(() => props.store.get(props.agentKey));
watch([() => props.base, supportRetry], async ([base], _, cleanup) => {
  const controller = new AbortController(); cleanup(() => controller.abort());
  caps.value = null; error.value = "";
  try {
    const response = await fetch(base + "/attachments/capabilities", { signal: controller.signal });
    if (!response.ok) throw new Error("Attachment capabilities are unavailable while the host is disconnected.");
    const result = await response.json();
    if (!controller.signal.aborted) caps.value = result;
  } catch (e) { if (!controller.signal.aborted) error.value = (e as Error).message; }
}, { immediate: true });
const RASTER = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Clipboard images all arrive as "image.png": give each a distinct, dated name. */
function named(file: File) {
  if (!RASTER.has(file.type) || !/^image\.(png|jpe?g|webp)$/i.test(file.name)) return file;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const ext = file.type === "image/jpeg" ? "jpg" : file.type.slice(6);
  return new File([file], `pasted-${stamp}-${Math.random().toString(36).slice(2, 6)}.${ext}`, { type: file.type, lastModified: file.lastModified });
}
/** A retina screenshot can exceed the upload limit: scale it down and re-encode once, in the browser. */
async function fitted(file: File, maxBytes: number) {
  if (!RASTER.has(file.type) || file.size <= maxBytes || typeof createImageBitmap !== "function") return file;
  const bitmap = await createImageBitmap(file);
  try {
    for (const [side, quality] of [[3072, 0.9], [2400, 0.85], [1800, 0.8]] as const) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= maxBytes) return new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
    }
  } finally {
    bitmap.close();
  }
  return file;
}
async function addFiles(files: FileList | File[] | undefined | null) {
  if (!files?.length || props.busy) return;
  error.value = "";
  try {
    if (!caps.value) throw new Error("Wait for attachment capabilities, then try again.");
    const maxBytes = caps.value.maxBytes;
    const ready = await Promise.all(Array.from(files).map((f) => fitted(named(f), maxBytes)));
    await props.store.add(props.agentKey, props.base, ready, caps.value);
  } catch (e) { error.value = (e as Error).message; }
  if (picker.value) picker.value.value = "";
}
/** The composer's attach button: enabled state and tooltip (limits and the agent's support note). */
const available = computed(() => !!caps.value && (caps.value.images || caps.value.files));
const hint = computed(() => {
  if (!caps.value) return error.value ? "Attachments unavailable" : "Checking attachment support…";
  if (!available.value) return "Attachments are unavailable for this agent";
  return ["Attach files (up to 4 · 8 MiB each · 24 MiB total)", caps.value.note].filter(Boolean).join("\n");
});
const pick = () => { if (available.value && !props.busy) picker.value?.click(); };
const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
defineExpose({ addFiles, pick, available, hint });
</script>
<template>
  <input ref="picker" type="file" multiple hidden aria-label="Choose attachments" @change="addFiles(picker?.files)" />
  <div v-if="entries.length || error" class="attachment-tray">
    <div
      v-for="entry in entries"
      :key="entry.localId"
      class="attachment-item"
      :class="{ 'is-error': !!entry.error }"
      :data-state="entry.uploading ? 'uploading' : entry.error ? 'error' : 'ready'"
      :title="entry.error || entry.file.name"
    >
      <span class="attachment-thumb">
        <img v-if="entry.preview" :src="entry.preview" :alt="entry.file.name" />
        <Icon v-else name="file" :size="16" />
        <span v-if="entry.uploading" class="spinner spinner-sm attachment-uploading"></span>
      </span>
      <span class="attachment-text">
        <span class="attachment-name">{{ entry.file.name }}</span>
        <span class="attachment-meta">{{ entry.error ? "Upload failed" : entry.uploading ? "Uploading…" : size(entry.file.size) }}</span>
      </span>
      <button v-if="entry.error" type="button" class="attachment-action" aria-label="Retry upload" title="Retry upload" :disabled="busy" @click="store.upload(entry)">
        <Icon name="refresh" :size="13" />
      </button>
      <button
        type="button"
        class="attachment-action"
        :aria-label="entry.uploading ? 'Cancel upload' : 'Remove attachment'"
        :title="entry.uploading ? 'Cancel upload' : 'Remove attachment'"
        :disabled="busy"
        @click="store.remove(agentKey, entry)"
      >
        <Icon name="close" :size="13" />
      </button>
    </div>
    <p v-if="error" class="attachment-error" role="alert">
      <Icon name="alert" :size="13" />{{ error }}
      <button v-if="!caps" type="button" class="attachment-retry" :disabled="busy" @click="supportRetry++">Retry</button>
    </p>
  </div>
</template>
<style scoped>
.attachment-tray { display: flex; flex-wrap: wrap; gap: 8px; padding: 2px 0 8px; }
.attachment-item {
  display: flex; align-items: center; gap: 8px; max-width: 240px;
  padding: 4px 4px 4px 4px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-1);
}
.attachment-item.is-error { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.attachment-thumb {
  position: relative; flex: none; display: grid; place-items: center; width: 36px; height: 36px;
  border-radius: 8px; overflow: hidden; background: var(--surface-2); color: var(--fg-muted);
}
.attachment-thumb img { width: 100%; height: 100%; object-fit: cover; }
.attachment-uploading { position: absolute; margin: 0; }
.attachment-text { display: grid; min-width: 0; line-height: 1.25; }
.attachment-name { font-size: 12.5px; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.attachment-meta { font-size: 11.5px; color: var(--fg-muted); }
.is-error .attachment-meta { color: var(--danger); }
.attachment-action {
  flex: none; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; color: var(--fg-muted);
}
.attachment-action:hover:not(:disabled) { background: var(--hover); color: var(--fg); }
.attachment-error { display: flex; align-items: center; gap: 6px; width: 100%; margin: 0; font-size: 12.5px; color: var(--danger); }
.attachment-retry { margin-left: 4px; color: var(--link); font-size: 12.5px; }
</style>
