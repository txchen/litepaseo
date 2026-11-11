<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  AGENT_PITCH,
  GROUP_PITCH,
  type DirectoryStore,
  type ProjectGroup,
  type SidebarRow,
} from "./directory-store.ts";
import Icon from "./Icon.vue";

const props = defineProps<{
  store: DirectoryStore;
  mode: "projects" | "recent";
  hostLabels: Map<string, string>;
  hostStates: Map<string, string>;
  selectedKey: string | null;
  searching: boolean;
}>();
const emit = defineEmits<{ select: [key: string]; new: [group: ProjectGroup] }>();

const OVERSCAN_PX = 320;
const element = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const height = ref(600);
let frame = 0;
let observer: ResizeObserver | undefined;

const total = computed(() => {
  props.store.version.value;
  return props.store.size;
});
const listHeight = computed(() => {
  props.store.version.value;
  return props.mode === "projects" ? props.store.groupedHeight : props.store.size * AGENT_PITCH;
});
// Only the visible window is materialized: O(window · log n) per change or scroll frame.
const rows = computed<SidebarRow[]>(() => {
  props.store.version.value;
  const top = Math.max(0, scrollTop.value - OVERSCAN_PX);
  const span = height.value + OVERSCAN_PX * 2;
  if (props.mode === "projects") return props.store.groupedRows(top, span);
  const first = Math.floor(top / AGENT_PITCH);
  return props.store
    .range(first, Math.ceil(span / AGENT_PITCH) + 1)
    .map((agent, i) => ({ kind: "agent", key: agent.key, top: (first + i) * AGENT_PITCH, agent }));
});

function onScroll() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (element.value) scrollTop.value = element.value.scrollTop;
  });
}
onMounted(() => {
  const el = element.value!;
  height.value = el.clientHeight || height.value;
  observer = new ResizeObserver(() => (height.value = el.clientHeight || height.value));
  observer.observe(el);
});
onUnmounted(() => {
  observer?.disconnect();
  cancelAnimationFrame(frame);
});
</script>
<template>
  <div ref="element" class="session-list" @scroll.passive="onScroll">
    <div class="session-spacer" :style="{ height: listHeight + 'px' }">
      <template v-for="row in rows" :key="row.key">
        <div
          v-if="row.kind === 'group'"
          class="group-row"
          :class="{ collapsed: row.collapsed }"
          :style="{ transform: `translateY(${row.top}px)`, height: GROUP_PITCH - 4 + 'px' }"
        >
          <button
            class="group-toggle"
            :aria-expanded="!row.collapsed"
            @click="store.toggleGroup(row.group.key)"
          >
          <Icon name="chevron" :size="13" class="group-chevron" />
          <Icon name="folder" :size="14" class="group-folder" />
          <span class="group-name">{{ row.group.name }}</span>
          <span v-if="row.group.attention" class="group-flag is-attention" :title="row.group.attention + ' need you'">{{
            row.group.attention
          }}</span>
          <span v-else-if="row.group.running" class="group-flag is-running" :title="row.group.running + ' running'"
            ><span class="status-dot is-running"></span
          ></span>
          <span class="group-count">{{ row.group.agents.size }}</span>
          </button>
          <button
            class="group-add"
            :aria-label="'New session in ' + row.group.name"
            :title="'New session in ' + row.group.name"
            @click="emit('new', row.group)"
          >
            <Icon name="plus" :size="14" />
          </button>
        </div>
        <button
          v-else
          class="session"
          :class="{
            unread: row.agent.unread,
            chosen: selectedKey === row.agent.key,
            offline: hostStates.get(row.agent.hostId) !== 'connected',
            nested: mode === 'projects',
          }"
          :style="{ transform: `translateY(${row.top}px)` }"
          @click="emit('select', row.agent.key)"
        >
          <span
            class="status-dot"
            :class="
              'is-' +
              (row.agent.attention
                ? 'attention'
                : row.agent.state === 'failed'
                  ? 'error'
                  : row.agent.state === 'running'
                    ? 'running'
                    : row.agent.unread
                      ? 'unread'
                      : 'idle')
            "
          ></span>
          <span class="session-text">
            <span class="session-title">{{ row.agent.title || "Untitled session" }}</span>
            <span class="session-meta">
              <template v-if="mode === 'recent'">
                <span class="session-project">{{ row.agent.project }}</span>
                <span class="sep">·</span>
              </template>
              <span>{{ hostLabels.get(row.agent.hostId) ?? "Unknown host" }}</span>
              <template v-if="mode === 'projects'">
                <span class="sep">·</span>
                <span>{{ row.agent.provider }}</span>
              </template>
            </span>
          </span>
          <span v-if="row.agent.pendingPermissions.length" class="pill pill-attention">Approve</span>
          <span v-else-if="row.agent.attention" class="pill pill-attention">Needs you</span>
          <span v-else-if="row.agent.unread" class="unread-mark" title="Finished, not viewed yet"></span>
        </button>
      </template>
    </div>
    <div v-if="!total" class="list-empty">
      {{ searching ? "No sessions match." : "No sessions yet. Add a host to get started." }}
    </div>
  </div>
</template>
