<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import Icon from "./Icon.vue";

// Paseo's project menu: edit the project's paseo.json, or remove the project from its host.
const props = defineProps<{ name: string; host: string; x: number; y: number }>();
const emit = defineEmits<{ close: []; settings: []; remove: [] }>();
const element = ref<HTMLElement | null>(null);
const position = ref({ left: props.x, top: props.y });

function pick(event: "settings" | "remove") {
  if (event === "settings") emit("settings");
  else emit("remove");
  emit("close");
}
function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close");
}
function onOutside(event: PointerEvent) {
  if (element.value && !element.value.contains(event.target as Node)) emit("close");
}
onMounted(() => {
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
    :aria-label="'Actions for project ' + name"
    :style="{ left: position.left + 'px', top: position.top + 'px' }"
  >
    <div class="menu-title">{{ name }} · {{ host }}</div>
    <button role="menuitem" @click="pick('settings')"><Icon name="sliders" :size="14" />Project settings…</button>
    <div class="menu-sep"></div>
    <button role="menuitem" class="menu-danger" @click="pick('remove')"><Icon name="trash" :size="14" />Remove project…</button>
  </div>
</template>
