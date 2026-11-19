<script setup lang="ts">
import { ref } from "vue";
import Icon from "./Icon.vue";
import { useMenu } from "./use-menu.ts";

// Paseo's project menu: edit the project's paseo.json, or remove the project from its host.
const props = defineProps<{ name: string; pinned?: boolean; host: string; x: number; y: number }>();
const emit = defineEmits<{ close: []; settings: []; remove: []; pin: [] }>();
const element = ref<HTMLElement | null>(null);

function pick(event: "settings" | "remove" | "pin") {
  if (event === "settings") emit("settings");
  else if (event === "pin") emit("pin");
  else emit("remove");
  emit("close");
}
const { position } = useMenu(element, { x: props.x, y: props.y }, () => emit("close"));
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
    <button role="menuitem" @click="pick('pin')"><Icon name="pin" :size="14" />{{ pinned ? "Unpin project" : "Pin project" }}</button>
    <button role="menuitem" @click="pick('settings')"><Icon name="sliders" :size="14" />Project settings…</button>
    <div class="menu-sep"></div>
    <button role="menuitem" class="menu-danger" @click="pick('remove')"><Icon name="trash" :size="14" />Remove project…</button>
  </div>
</template>
