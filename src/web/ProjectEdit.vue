<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import ProjectIcon from "./ProjectIcon.vue";

/**
 * Paseo's "Edit project" sheet: the name and the icon, decided together and saved once. A blank
 * name returns to the derived one; the icon is an uploaded image, an image or website URL (fetched
 * by the LitePaseo server), or automatic (found in the project again).
 */
const props = defineProps<{
  hostId: string;
  rootPath: string;
  project: { projectId: string; name: string; customName: string | null; iconRevision: string | null };
  customIcons: boolean;
  request: (path: string, method?: string, body?: unknown, timeoutMs?: number) => Promise<unknown>;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();

const MAX_ICON_BYTES = 512 * 1024;
type IconChoice = "unchanged" | "automatic" | "upload" | "url";
const name = ref(props.project.customName ?? "");
const url = ref("");
const picked = ref<{ fileName: string; mimeType: string; data: string } | null>(null);
const choice = ref<IconChoice>("unchanged");
const error = ref<{ scope: "name" | "icon"; message: string } | null>(null);
const saving = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const hasCustomIcon = computed(() => !!props.project.iconRevision);

const rename = computed(() => {
  const customName = name.value.trim() || null;
  return customName === props.project.customName ? null : { customName };
});
const icon = computed(() => {
  if (choice.value === "automatic") return hasCustomIcon.value ? { type: "automatic" as const } : null;
  if (choice.value === "upload" && picked.value) return { type: "upload" as const, data: picked.value.data };
  if (choice.value === "url") return url.value.trim() ? { type: "url" as const, url: url.value.trim() } : null;
  return null;
});
const canUseAutomatic = computed(() => (icon.value ? icon.value.type !== "automatic" : hasCustomIcon.value));
const canSubmit = computed(() => !saving.value && !!(rename.value || icon.value));
/** Dropping a custom icon leaves the daemon to find one again, so the preview is the letter. */
const previewSrc = computed(() =>
  choice.value === "automatic" ? null : choice.value === "upload" && picked.value ? `data:${picked.value.mimeType};base64,${picked.value.data}` : undefined,
);

function setName(value: string) {
  name.value = value;
  error.value = null;
}
/** Emptying the box withdraws the URL without discarding an earlier pick. */
function setUrl(value: string) {
  url.value = value;
  choice.value = value.trim() ? "url" : picked.value ? "upload" : "unchanged";
  error.value = null;
}
function chooseImage() {
  fileInput.value?.click();
}
async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > MAX_ICON_BYTES) {
    error.value = { scope: "icon", message: "Icon must be 512 KB or smaller" };
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  picked.value = { fileName: file.name, mimeType: file.type || "image/png", data: btoa(binary) };
  choice.value = "upload";
  error.value = null;
}
function useAutomatic() {
  picked.value = null;
  url.value = "";
  choice.value = hasCustomIcon.value ? "automatic" : "unchanged";
  error.value = null;
}
async function save() {
  if (!canSubmit.value) return;
  saving.value = true;
  error.value = null;
  try {
    await props.request(
      `/hosts/${encodeURIComponent(props.hostId)}/projects/${encodeURIComponent(props.project.projectId)}/edit`,
      "POST",
      { rename: rename.value, icon: icon.value },
      40000,
    );
    emit("saved");
    emit("close");
  } catch (e) {
    const err = e as Error & { scope?: string };
    error.value = { scope: err.scope === "icon" ? "icon" : "name", message: err.message };
  } finally {
    saving.value = false;
  }
}
function close() {
  if (!saving.value) emit("close");
}
onMounted(() => nextTick(() => nameInput.value?.focus()));
</script>

<template>
  <div class="overlay ps-script-overlay" @mousedown.self="close" @keydown.esc.stop="close">
    <form class="sheet sheet-small" role="dialog" aria-modal="true" aria-label="Edit project" @submit.prevent="save">
      <header class="sheet-head">
        <h2>Edit project</h2>
        <button type="button" class="icon-btn" aria-label="Close" @click="close"><Icon name="close" :size="16" /></button>
      </header>
      <div class="sheet-body">
        <label class="field">
          <span>Name</span>
          <input
            ref="nameInput"
            :value="name"
            :placeholder="project.name"
            :disabled="saving"
            maxlength="200"
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
            aria-label="Project name"
            @input="setName(($event.target as HTMLInputElement).value)"
          />
        </label>
        <p v-if="error?.scope === 'name'" class="ps-field-error" role="alert">{{ error.message }}</p>
        <div v-if="customIcons" class="field">
          <span>Icon</span>
          <div class="pe-icon-row">
            <ProjectIcon
              :name="project.name"
              :size="40"
              :src="previewSrc"
              :source="{ hostId, rootPath, projectId: project.projectId, projectIconRevision: project.iconRevision }"
            />
            <button type="button" class="btn btn-outline" :disabled="saving" @click="chooseImage">Choose image</button>
            <button v-if="canUseAutomatic" type="button" class="btn btn-ghost" :disabled="saving" @click="useAutomatic">Use automatic</button>
            <input
              ref="fileInput"
              class="pe-file"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,.ico"
              tabindex="-1"
              aria-hidden="true"
              @change="onFile"
            />
          </div>
          <input
            class="pe-url"
            :value="url"
            type="url"
            inputmode="url"
            placeholder="Image or website URL"
            aria-label="Image or website URL"
            :disabled="saving"
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
            @input="setUrl(($event.target as HTMLInputElement).value)"
          />
          <p v-if="choice === 'upload' && picked" class="pe-hint">{{ picked.fileName }}</p>
          <p v-if="error?.scope === 'icon'" class="ps-field-error pe-icon-error" role="alert">{{ error.message }}</p>
        </div>
      </div>
      <footer class="sheet-foot">
        <button type="button" class="btn btn-ghost" :disabled="saving" @click="close">Cancel</button>
        <button class="btn btn-primary" :disabled="!canSubmit">{{ saving ? "Saving…" : "Save changes" }}</button>
      </footer>
    </form>
  </div>
</template>
