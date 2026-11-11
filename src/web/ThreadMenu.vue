<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import type { WorkspaceSummary } from "../shared/wire.ts";
import Icon from "./Icon.vue";

// The thread actions Paseo's sidebar offers: rename, pin, unread/read, archive.
const props = defineProps<{ thread: WorkspaceSummary; x: number; y: number }>();
const emit = defineEmits<{
  close: [];
  rename: [thread: WorkspaceSummary];
  pin: [thread: WorkspaceSummary, pinned: boolean];
  unread: [thread: WorkspaceSummary];
  read: [thread: WorkspaceSummary];
  archive: [thread: WorkspaceSummary];
}>();
const element = ref<HTMLElement | null>(null);
const position = ref({ left: props.x, top: props.y });

function pick(fn: () => void) {
  fn();
  emit("close");
}
function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close");
}
function onOutside(event: PointerEvent) {
  if (element.value && !element.value.contains(event.target as Node)) emit("close");
}
onMounted(() => {
  // Keep the menu on screen near the pointer.
  void nextTick(() => {
    const el = element.value;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    position.value = {
      left: Math.max(8, Math.min(props.x, innerWidth - width - 8)),
      top: Math.max(8, Math.min(props.y, innerHeight - height - 8)),
    };
    el.querySelector("button")?.focus();
  });
  window.addEventListener("keydown", onKey);
  setTimeout(() => window.addEventListener("pointerdown", onOutside), 0);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("pointerdown", onOutside);
});
</script>

<template>
  <div
    ref="element"
    class="menu"
    role="menu"
    :aria-label="'Actions for ' + thread.name"
    :style="{ left: position.left + 'px', top: position.top + 'px' }"
  >
    <div class="menu-title">{{ thread.name }}</div>
    <button role="menuitem" @click="pick(() => emit('rename', thread))"><Icon name="edit" :size="14" />Rename…</button>
    <button role="menuitem" @click="pick(() => emit('pin', thread, !thread.pinnedAt))">
      <Icon name="pin" :size="14" />{{ thread.pinnedAt ? "Unpin" : "Pin to top" }}
    </button>
    <button v-if="thread.unread" role="menuitem" @click="pick(() => emit('read', thread))">
      <Icon name="check" :size="14" />Mark as read
    </button>
    <button v-else role="menuitem" @click="pick(() => emit('unread', thread))">
      <Icon name="dot" :size="14" />Mark as unread
    </button>
    <div class="menu-sep"></div>
    <button role="menuitem" class="menu-danger" @click="pick(() => emit('archive', thread))">
      <Icon name="archive" :size="14" />Archive…
    </button>
  </div>
</template>
