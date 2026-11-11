<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AttachmentStore } from "./attachment-store.ts";
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
async function addFiles(files: FileList | File[] | undefined | null) {
  if (!files?.length || props.busy) return;
  error.value = "";
  try {
    if (!caps.value) throw new Error("Wait for attachment capabilities, then try again.");
    await props.store.add(props.agentKey, props.base, Array.from(files), caps.value);
  } catch (e) { error.value = (e as Error).message; }
  if (picker.value) picker.value.value = "";
}
defineExpose({ addFiles });
</script>
<template>
  <div class="attachment-panel">
    <input ref="picker" type="file" multiple hidden aria-label="Choose attachments" @change="addFiles(picker?.files)" />
    <button type="button" class="btn btn-ghost" :disabled="busy || !caps || (!caps.images && !caps.files)" @click="picker?.click()">Attach files</button>
    <span class="row-sub">Up to 4 files · 8 MiB each · 24 MiB total · kept in this tab until sent</span>
    <p v-if="caps && !caps.images && !caps.files" role="status">Attachments are unavailable for this agent.</p>
    <details v-else-if="caps?.note"><summary>Attachment support</summary>{{ caps.note }}</details>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="error && !caps" type="button" class="btn btn-ghost" :disabled="busy" @click="supportRetry++">Retry attachment support</button>
    <div v-for="entry in entries" :key="entry.localId" class="attachment-item">
      <img v-if="entry.preview" :src="entry.preview" :alt="entry.file.name" width="64" height="64" />
      <span>{{ entry.file.name }} ({{ Math.ceil(entry.file.size / 1024) }} KiB) · {{ entry.uploading ? 'Uploading…' : entry.error || 'Ready' }}</span>
      <button v-if="entry.error" type="button" class="btn btn-ghost" :disabled="busy" @click="store.upload(entry)">Retry upload</button>
      <button type="button" class="btn btn-ghost" :disabled="busy" @click="store.remove(agentKey, entry)">{{ entry.uploading ? 'Cancel upload' : 'Remove attachment' }}</button>
    </div>
  </div>
</template>
<style scoped>
.attachment-panel { padding: 6px 0; }
.attachment-item { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px; }
.attachment-item img { object-fit: contain; }
</style>
