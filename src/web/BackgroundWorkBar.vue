<script setup lang="ts">
import { ref } from "vue";
import type { AgentBackgroundWorkItem } from "../shared/wire.ts";
import Icon from "./Icon.vue";

defineProps<{
  items: AgentBackgroundWorkItem[];
  stoppingId: string | null;
}>();
const emit = defineEmits<{
  stop: [item: AgentBackgroundWorkItem];
}>();

const expanded = ref(false);

function kindLabel(kind: string) {
  if (kind === "monitor" || kind === "heartbeat") return "Heartbeat";
  if (kind === "shell") return "Background task";
  return kind;
}
function startedLabel(iso: string) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}
</script>

<template>
  <div v-if="items.length" class="bg-work" role="region" aria-label="Background work">
    <button type="button" class="bg-work-head" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="status-dot is-running"></span>
      <span class="bg-work-title">
        {{ items.length }} background {{ items.length === 1 ? "task" : "tasks" }}
      </span>
      <span class="bg-work-preview">
        {{ items.map((i) => i.description || i.command || kindLabel(i.kind)).slice(0, 2).join(" · ") }}
      </span>
      <Icon name="chevron" :size="13" class="bg-work-chevron" :class="{ open: expanded }" />
    </button>
    <div v-if="expanded" class="bg-work-list" role="list">
      <div v-for="item in items" :key="item.id" class="bg-work-item" role="listitem">
        <div class="bg-work-meta">
          <span class="bg-work-kind">{{ kindLabel(item.kind) }}</span>
          <span class="bg-work-desc">{{ item.description || item.command || item.id }}</span>
          <code v-if="item.command && item.description" class="bg-work-cmd">{{ item.command }}</code>
          <span v-if="startedLabel(item.startedAt)" class="bg-work-age">running {{ startedLabel(item.startedAt) }}</span>
        </div>
        <button
          v-if="item.canStop !== false"
          type="button"
          class="btn btn-sm btn-outline"
          :disabled="stoppingId === item.id"
          @click="emit('stop', item)"
        >
          <Icon name="stop" :size="11" />{{ stoppingId === item.id ? "Stopping…" : "Stop" }}
        </button>
      </div>
    </div>
  </div>
</template>
