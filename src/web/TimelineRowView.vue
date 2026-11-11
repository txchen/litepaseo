<script setup lang="ts">
import { computed, ref, type ShallowRef } from "vue";
import type { TimelineRow } from "../shared/wire.ts";
import MarkdownMessage from "./MarkdownMessage.vue";
import Icon from "./Icon.vue";
import PluginRow from "./PluginRow.vue";

// Receives the row's own ref: only this component re-renders when the row changes.
const props = defineProps<{ entry: ShallowRef<TimelineRow>; final: boolean }>();
const row = computed(() => props.entry.value);
const item = computed(() => row.value.item as Record<string, any>);
const open = ref(false);

const TOOL_ICONS: Record<string, string> = {
  shell: "terminal",
  read: "file",
  edit: "edit",
  write: "edit",
  search: "search",
  fetch: "globe",
  web_search: "globe",
  sub_agent: "bot",
};
const tool = computed(() => {
  const i = item.value;
  if (i.type !== "tool_call") return null;
  const d = (i.detail ?? {}) as Record<string, any>;
  const subject =
    d.command ?? d.filePath ?? d.query ?? d.url ?? d.description ?? d.prompt ?? d.filePaths?.[0] ?? "";
  return {
    icon: TOOL_ICONS[d.type] ?? "tool",
    name: String(i.name ?? d.type ?? "tool"),
    subject: String(subject).split("\n")[0],
    status: String(i.status ?? "running"),
  };
});
const todo = computed(() => (item.value.type === "todo" ? (item.value.items as any[]) : []));
const details = computed(() =>
  open.value ? JSON.stringify(item.value.detail ?? item.value, null, 2) : "",
);
const label = computed(() => String(item.value.type).replaceAll("_", " "));
</script>

<template>
  <div v-if="item.type === 'user_message'" class="row row-user">
    <div class="bubble">{{ item.text }}</div>
  </div>

  <div v-else-if="item.type === 'assistant_message'" class="row row-assistant">
    <MarkdownMessage :content="String(item.text ?? '')" :final="final" />
  </div>

  <details
    v-else-if="item.type === 'reasoning'"
    class="row row-reasoning"
    @toggle="open = ($event.target as HTMLDetailsElement).open"
  >
    <summary><Icon name="sparkle" :size="14" /> Thinking</summary>
    <div v-if="open" class="reasoning-text">{{ item.text }}</div>
  </details>

  <details
    v-else-if="tool"
    class="row row-tool"
    :class="'is-' + tool.status"
    @toggle="open = ($event.target as HTMLDetailsElement).open"
  >
    <summary>
      <span class="tool-icon"><Icon :name="tool.icon" :size="14" /></span>
      <span class="tool-name">{{ tool.name }}</span>
      <span class="tool-subject">{{ tool.subject }}</span>
      <span class="tool-status" :title="tool.status">
        <span v-if="tool.status === 'running'" class="spinner"></span>
        <Icon v-else-if="tool.status === 'completed'" name="check" :size="14" />
        <Icon v-else-if="tool.status === 'failed'" name="close" :size="14" />
        <span v-else class="muted-text">{{ tool.status }}</span>
      </span>
    </summary>
    <pre v-if="open" class="tool-detail">{{ details }}</pre>
    <pre v-if="open && item.error" class="tool-detail tool-error">{{
      typeof item.error === "string" ? item.error : JSON.stringify(item.error, null, 2)
    }}</pre>
  </details>

  <div v-else-if="item.type === 'todo'" class="row row-todo">
    <div class="todo-title"><Icon name="list" :size="14" /> Plan</div>
    <ul>
      <li v-for="(t, i) in todo" :key="t.id ?? i" :class="{ done: t.completed, active: t.status === 'in_progress' }">
        <span class="check" :class="{ done: t.completed }"></span>{{ t.text }}
      </li>
    </ul>
  </div>

  <div v-else-if="item.type === 'error'" class="row row-callout is-error">
    <Icon name="alert" :size="15" /> <span>{{ item.message }}</span>
  </div>

  <div v-else-if="item.type === 'notification'" class="row row-callout" :class="'is-' + item.level">
    <Icon name="alert" :size="15" /> <span>{{ item.message }}</span>
  </div>

  <div v-else-if="item.type === 'compaction'" class="row row-divider">
    <span>{{ item.status === "loading" ? "Compacting context…" : "Context compacted" }}</span>
  </div>

  <PluginRow v-else-if="item.type === 'plugin'" :item="item" :seq-start="row.seqStart" />

  <details v-else class="row row-tool" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary>
      <span class="tool-icon"><Icon name="tool" :size="14" /></span>
      <span class="tool-name">{{ label }}</span>
    </summary>
    <pre v-if="open" class="tool-detail">{{ details }}</pre>
  </details>
</template>
