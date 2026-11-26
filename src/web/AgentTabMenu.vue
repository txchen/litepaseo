<script setup lang="ts">
import { ref } from "vue";
import type { AgentSummary } from "../shared/wire.ts";
import Icon from "./Icon.vue";
import { useMenu } from "./use-menu.ts";

const props = defineProps<{ agent: AgentSummary; canClose: boolean; x: number; y: number }>();
const emit = defineEmits<{
  close: [];
  rename: [agent: AgentSummary];
  closeAgent: [agent: AgentSummary];
}>();
const element = ref<HTMLElement | null>(null);
const label = () => props.agent.title || props.agent.provider;

function pick(fn: () => void) {
  fn();
  emit("close");
}
const { position } = useMenu(element, { x: props.x, y: props.y }, () => emit("close"));
</script>

<template>
  <div
    ref="element"
    class="menu"
    role="menu"
    :aria-label="'Actions for ' + label()"
    :style="{ left: position.left + 'px', top: position.top + 'px' }"
  >
    <div class="menu-title">{{ label() }}</div>
    <button role="menuitem" @click="pick(() => emit('rename', agent))"><Icon name="edit" :size="14" />Rename session…</button>
    <template v-if="canClose">
      <div class="menu-sep"></div>
      <button role="menuitem" class="menu-danger" @click="pick(() => emit('closeAgent', agent))">
        <Icon name="close" :size="14" />Close session…
      </button>
    </template>
  </div>
</template>
