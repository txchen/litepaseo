<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import type { AgentSummary } from "../shared/wire.ts";
import Icon from "./Icon.vue";

const props = defineProps<{
  agents: AgentSummary[];
  selectedKey: string | null;
  x: number;
  y: number;
}>();
const emit = defineEmits<{
  close: [];
  select: [key: string];
  rename: [agent: AgentSummary];
  closeAgent: [agent: AgentSummary];
}>();

const element = ref<HTMLElement | null>(null);
const filterInput = ref<HTMLInputElement | null>(null);
const query = ref("");
const position = ref({ left: props.x, top: props.y });
const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.agents;
  return props.agents.filter((a) => `${a.title ?? ""}\n${a.provider}`.toLowerCase().includes(q));
});

const dot = (a: AgentSummary) =>
  "is-" + (a.attention ? "attention" : a.state === "failed" ? "error" : a.state === "running" ? "running" : a.unread ? "unread" : "idle");

function pick(fn: () => void) {
  fn();
  emit("close");
}

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }
}

let outsideTimer: ReturnType<typeof setTimeout> | undefined;
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
    if (filterInput.value) filterInput.value.focus({ preventScroll: true });
    else el.querySelector<HTMLElement>(".tabs-picker-open.chosen, .tabs-picker-open")?.focus({ preventScroll: true });
  });
  document.addEventListener("keydown", onKey);
  outsideTimer = setTimeout(() => window.addEventListener("pointerdown", onOutside), 0);
});
onUnmounted(() => {
  clearTimeout(outsideTimer);
  document.removeEventListener("keydown", onKey);
  window.removeEventListener("pointerdown", onOutside);
});
</script>

<template>
  <div
    ref="element"
    class="menu tabs-picker"
    role="dialog"
    aria-label="Workspace sessions"
    :style="{ left: position.left + 'px', top: position.top + 'px' }"
  >
    <div class="menu-title">Sessions ({{ agents.length }})</div>
    <div v-if="agents.length >= 8" class="tabs-picker-search">
      <input
        ref="filterInput"
        v-model="query"
        type="search"
        placeholder="Filter sessions…"
        aria-label="Filter sessions"
      />
    </div>
    <div class="tabs-picker-list" role="listbox" aria-label="Workspace sessions">
      <div
        v-for="a in filtered"
        :key="a.key"
        class="tabs-picker-row"
        :class="{ chosen: a.key === selectedKey }"
      >
        <button
          type="button"
          class="tabs-picker-open"
          :class="{ chosen: a.key === selectedKey }"
          :title="a.title || a.provider"
          :aria-selected="a.key === selectedKey ? 'true' : 'false'"
          role="option"
          @click="pick(() => emit('select', a.key))"
        >
          <span class="status-dot" :class="dot(a)"></span>
          <span class="tabs-picker-name">{{ a.title || a.provider }}</span>
          <Icon v-if="a.key === selectedKey" name="check" :size="13" class="tabs-picker-check" />
        </button>
        <button
          type="button"
          class="tabs-picker-act"
          :aria-label="'Rename ' + (a.title || a.provider)"
          :title="'Rename ' + (a.title || a.provider)"
          @click="pick(() => emit('rename', a))"
        >
          <Icon name="edit" :size="13" />
        </button>
        <button
          v-if="agents.length > 1"
          type="button"
          class="tabs-picker-act tabs-picker-close"
          :aria-label="'Close ' + (a.title || a.provider)"
          :title="'Close ' + (a.title || a.provider)"
          @click="pick(() => emit('closeAgent', a))"
        >
          <Icon name="close" :size="13" />
        </button>
      </div>
      <p v-if="!filtered.length" class="tabs-picker-empty">No matching sessions</p>
    </div>
  </div>
</template>
