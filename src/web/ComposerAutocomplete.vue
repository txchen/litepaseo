<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { SlashCommandOption } from "../shared/wire.ts";
import Icon from "./Icon.vue";

export interface AutocompleteTrigger {
  mode: "slash" | "file";
  query: string;
  start: number;
  end: number;
}

const props = defineProps<{
  trigger: AutocompleteTrigger | null;
  commands: SlashCommandOption[];
  files: string[];
  loading: boolean;
}>();
const emit = defineEmits<{
  select: [replacement: string, trigger: AutocompleteTrigger];
  close: [];
}>();

const selectedIndex = ref(0);

const items = computed(() => {
  const t = props.trigger;
  if (!t) return [];
  const q = t.query.toLowerCase();
  if (t.mode === "slash") {
    return props.commands
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      .slice(0, 30)
      .map((c) => ({
        key: "cmd:" + c.name,
        title: "/" + c.name + (c.argumentHint ? " " + c.argumentHint : ""),
        sub: c.description,
        badge: c.kind === "skill" ? "skill" : "",
        value: "/" + c.name + " ",
        icon: c.kind === "skill" ? "sparkle" : "terminal",
      }));
  }
  return props.files.slice(0, 30).map((f) => ({
    key: "file:" + f,
    title: f,
    sub: "",
    badge: "",
    value: "@" + f + " ",
    icon: "file",
  }));
});

watch(
  () => [props.trigger?.mode, props.trigger?.query, items.value.length],
  () => {
    selectedIndex.value = 0;
  },
);

function choose(index: number) {
  const t = props.trigger;
  const item = items.value[index];
  if (!t || !item) return;
  emit("select", item.value, t);
}

function onKeyDown(event: KeyboardEvent): boolean {
  if (!props.trigger || (!items.value.length && !props.loading)) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return true;
  }
  if (!items.value.length) return false;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    selectedIndex.value = (selectedIndex.value + 1) % items.value.length;
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    selectedIndex.value = (selectedIndex.value - 1 + items.value.length) % items.value.length;
    return true;
  }
  if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey)) {
    event.preventDefault();
    choose(selectedIndex.value);
    return true;
  }
  return false;
}

defineExpose({ onKeyDown, hasItems: computed(() => items.value.length > 0) });
</script>

<template>
  <div v-if="trigger && (items.length || loading)" class="ac-popover" role="listbox" :aria-label="trigger.mode === 'slash' ? 'Slash commands' : 'Workspace files'">
    <div v-if="loading && !items.length" class="ac-empty"><span class="spinner spinner-sm"></span> Searching…</div>
    <button
      v-for="(item, i) in items"
      :key="item.key"
      type="button"
      role="option"
      class="ac-item"
      :class="{ active: i === selectedIndex }"
      :aria-selected="i === selectedIndex"
      @mousedown.prevent="choose(i)"
      @pointerenter="selectedIndex = i"
    >
      <Icon :name="item.icon" :size="14" class="ac-icon" />
      <span class="ac-body">
        <span class="ac-title">{{ item.title }}</span>
        <span v-if="item.sub" class="ac-sub">{{ item.sub }}</span>
      </span>
      <span v-if="item.badge" class="ac-badge">{{ item.badge }}</span>
    </button>
  </div>
</template>
