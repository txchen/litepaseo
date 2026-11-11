<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { WorkspaceSummary } from "../shared/wire.ts";
import {
  AGENT_PITCH,
  GROUP_PITCH,
  groupState,
  type DirectoryStore,
  type ProjectGroup,
  type SidebarRow,
} from "./directory-store.ts";
import Icon from "./Icon.vue";

// The sidebar: projects, then their threads (Paseo workspaces), windowed.
const props = defineProps<{
  store: DirectoryStore<WorkspaceSummary>;
  mode: "projects" | "recent";
  hostLabels: Map<string, string>;
  hostStates: Map<string, string>;
  selectedKey: string | null;
  searching: boolean;
}>();
const emit = defineEmits<{
  select: [key: string];
  new: [group: ProjectGroup<WorkspaceSummary>];
  menu: [thread: WorkspaceSummary, x: number, y: number];
}>();

const OVERSCAN_PX = 320;
const LONG_PRESS_MS = 500;
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
const rows = computed<SidebarRow<WorkspaceSummary>[]>(() => {
  props.store.version.value;
  const top = Math.max(0, scrollTop.value - OVERSCAN_PX);
  const span = height.value + OVERSCAN_PX * 2;
  if (props.mode === "projects") return props.store.groupedRows(top, span);
  const first = Math.floor(top / AGENT_PITCH);
  return props.store
    .range(first, Math.ceil(span / AGENT_PITCH) + 1)
    .map((item, i) => ({ kind: "item" as const, key: item.key, top: (first + i) * AGENT_PITCH, item }));
});

/** Tooltip for a project row: how many threads are in each state. */
const summary = (g: ProjectGroup<WorkspaceSummary>) =>
  [
    g.attention && `${g.attention} need you`,
    g.failed && `${g.failed} failed`,
    g.running && `${g.running} running`,
    g.unread && `${g.unread} finished, not viewed`,
  ]
    .filter(Boolean)
    .join(" · ");
const dot = (t: WorkspaceSummary) =>
  "is-" +
  (t.attention
    ? "attention"
    : t.state === "failed"
      ? "error"
      : t.state === "running"
        ? "running"
        : t.state === "unread"
          ? "unread"
          : "idle");

// Touch: a long press opens the thread menu (a tap still opens the thread).
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pressed = false;
function pressStart(event: PointerEvent, thread: WorkspaceSummary) {
  if (event.pointerType === "mouse") return;
  pressed = false;
  clearTimeout(pressTimer);
  const { clientX, clientY } = event;
  pressTimer = setTimeout(() => {
    pressed = true;
    navigator.vibrate?.(10);
    emit("menu", thread, clientX, clientY);
  }, LONG_PRESS_MS);
}
function pressEnd() {
  clearTimeout(pressTimer);
}
function open(thread: WorkspaceSummary) {
  if (pressed) {
    pressed = false; // the long press already opened the menu
    return;
  }
  emit("select", thread.key);
}
function menuButton(event: MouseEvent, thread: WorkspaceSummary) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  emit("menu", thread, rect.left, rect.bottom + 4);
}

function onScroll() {
  pressEnd();
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
  clearTimeout(pressTimer);
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
          <button class="group-toggle" :aria-expanded="!row.collapsed" @click="store.toggleGroup(row.group.key)">
            <Icon name="chevron" :size="13" class="group-chevron" />
            <Icon name="folder" :size="14" class="group-folder" />
            <span class="group-name">{{ row.group.name }}</span>
            <!-- Every state present shows, most urgent first, so a collapsed project still says
                 "something is running" even while another thread waits for you. -->
            <span v-if="groupState(row.group) !== 'done'" class="group-marks" :title="summary(row.group)">
              <span v-if="row.group.attention" class="group-flag is-attention">{{ row.group.attention }}</span>
              <span v-if="row.group.failed" class="status-dot is-error"></span>
              <span v-if="row.group.running" class="status-dot is-running"></span>
              <span v-if="row.group.unread" class="status-dot is-unread"></span>
            </span>
            <span class="group-count">{{ row.group.items.size }}</span>
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
        <div
          v-else
          class="session-row"
          :class="{ chosen: selectedKey === row.item.key }"
          :style="{ transform: `translateY(${row.top}px)` }"
        >
          <button
            class="session"
            :class="{
              unread: row.item.unread,
              chosen: selectedKey === row.item.key,
              offline: hostStates.get(row.item.hostId) !== 'connected',
              nested: mode === 'projects',
            }"
            @click="open(row.item)"
            @contextmenu.prevent="emit('menu', row.item, $event.clientX, $event.clientY)"
            @pointerdown="pressStart($event, row.item)"
            @pointerup="pressEnd"
            @pointercancel="pressEnd"
            @pointerleave="pressEnd"
          >
            <span class="status-dot" :class="dot(row.item)"></span>
            <span class="session-text">
              <span class="session-title">
                <Icon v-if="row.item.pinnedAt" name="pin" :size="11" class="pin-mark" />{{ row.item.name }}
              </span>
              <span class="session-meta">
                <template v-if="mode === 'recent'">
                  <span class="session-project">{{ row.item.project }}</span>
                  <span class="sep">·</span>
                </template>
                <span>{{ hostLabels.get(row.item.hostId) ?? "Unknown host" }}</span>
                <template v-if="row.item.branch">
                  <span class="sep">·</span>
                  <span class="session-branch">{{ row.item.branch }}</span>
                </template>
              </span>
            </span>
            <span v-if="row.item.attention" class="pill pill-attention">Needs you</span>
            <span v-else-if="row.item.unread" class="unread-mark" title="Finished, not viewed yet"></span>
          </button>
          <button
            class="row-more"
            :aria-label="'Actions for ' + row.item.name"
            title="Rename, pin, mark unread, archive"
            @click.stop="menuButton($event, row.item)"
          >
            <Icon name="more" :size="16" />
          </button>
        </div>
      </template>
    </div>
    <div v-if="!total" class="list-empty">
      {{ searching ? "No threads match." : "No threads yet. Add a host to get started." }}
    </div>
  </div>
</template>
