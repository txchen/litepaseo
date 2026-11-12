<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { RewindMode } from "../shared/wire.ts";
import Icon from "./Icon.vue";

/** The rewind button on a user message: a small menu of what the provider can rewind. */
const props = defineProps<{ modes: RewindMode[]; busy: boolean }>();
const emit = defineEmits<{ rewind: [mode: RewindMode] }>();
const LABELS: Record<RewindMode, string> = {
  conversation: "Rewind conversation",
  files: "Rewind files",
  both: "Rewind conversation and files",
};
const ICONS: Record<RewindMode, string> = { conversation: "chat", files: "file", both: "layers" };
const open = ref(false);
const root = ref<HTMLElement | null>(null);
function onDocument(event: Event) {
  if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.value?.contains(event.target as Node)) open.value = false;
}
watch(open, (isOpen) => {
  const method = isOpen ? "addEventListener" : "removeEventListener";
  document[method]("pointerdown", onDocument, true);
  document[method]("keydown", onDocument, true);
});
onBeforeUnmount(() => (open.value = false));
function choose(mode: RewindMode) {
  open.value = false;
  emit("rewind", mode);
}
</script>

<template>
  <span ref="root" class="rewind">
    <button
      type="button"
      class="icon-btn"
      aria-label="Rewind to this message"
      title="Rewind to this message"
      :aria-expanded="open"
      :disabled="busy"
      @click="open = !open"
    >
      <span v-if="busy" class="spinner"></span>
      <Icon v-else name="undo" :size="14" />
    </button>
    <div v-if="open" class="rewind-menu" role="menu">
      <p class="rewind-warning"><Icon name="alert" :size="13" />This action cannot be undone</p>
      <button v-for="mode in props.modes" :key="mode" type="button" role="menuitem" class="rewind-item" @click="choose(mode)">
        <Icon :name="ICONS[mode]" :size="15" />{{ LABELS[mode] }}
      </button>
    </div>
  </span>
</template>
