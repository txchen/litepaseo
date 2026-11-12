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
import { relativeAge } from "./timeline-display.ts";

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
/** A dot only when a thread has news: it works, waits for you, failed or finished unseen. */
const dot = (t: WorkspaceSummary) =>
  t.attention
    ? "is-attention"
    : t.state === "failed"
      ? "is-error"
      : t.state === "running"
        ? "is-running"
        : t.unread || t.state === "unread"
          ? "is-unread"
          : "";

// Ages ("5m", "3h") refresh once a minute; only the visible window re-renders.
const now = ref(Date.now());
let ageTimer: ReturnType<typeof setInterval> | undefined;

/** Machine(s) a project lives on, named on its row instead of under every thread. */
const groupHosts = (g: ProjectGroup<WorkspaceSummary>) => {
  const ids = [...g.hosts.keys()];
  if (ids.length === 1) return props.hostLabels.get(ids[0]) ?? "Unknown host";
  return `${ids.length} hosts`;
};
const groupHostsTitle = (g: ProjectGroup<WorkspaceSummary>) =>
  [...g.hosts.keys()].map((id) => props.hostLabels.get(id) ?? "Unknown host").join(", ");

// Project icons come from the daemon (favicon/logo in the project root); a letter tile otherwise.
const failedIcons = ref(new Set<string>());
const groupIcon = (g: ProjectGroup<WorkspaceSummary>) => {
  const first = g.items.at(0);
  if (!first?.rootPath) return null;
  const url = `/api/hosts/${encodeURIComponent(first.hostId)}/project-icon?cwd=${encodeURIComponent(first.rootPath)}`;
  return failedIcons.value.has(url) ? null : url;
};
const iconFailed = (url: string | null) => {
  if (!url || failedIcons.value.has(url)) return;
  failedIcons.value = new Set(failedIcons.value).add(url);
};
const TILE_COLORS = ["#4f7cc2", "#5a9e6f", "#c27a4f", "#9a6fc2", "#c25a7a", "#4fa7b0", "#b09a3f"];
const tileColor = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TILE_COLORS[h % TILE_COLORS.length];
};
const initial = (name: string) => (Array.from(name.trim())[0] ?? "?").toUpperCase();

// Hover card with the details a single-line row leaves out (Paseo's thread tooltip).
const canHover = matchMedia("(hover: hover) and (pointer: fine)").matches;
const card = ref<{ thread: WorkspaceSummary; top: number; left: number } | null>(null);
let cardTimer: ReturnType<typeof setTimeout> | undefined;
const home = (path: string) => path.replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");
function hoverStart(event: MouseEvent, thread: WorkspaceSummary) {
  if (!canHover) return;
  clearTimeout(cardTimer);
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  cardTimer = setTimeout(() => {
    card.value = { thread, top: Math.max(8, Math.min(rect.top - 4, window.innerHeight - 170)), left: rect.right + 10 };
  }, card.value ? 120 : 550);
}
function hoverEnd() {
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => (card.value = null), 80);
}

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
  clearTimeout(cardTimer);
  card.value = null;
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
  if (card.value) hoverEnd();
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
  ageTimer = setInterval(() => (now.value = Date.now()), 60_000);
});
onUnmounted(() => {
  observer?.disconnect();
  cancelAnimationFrame(frame);
  clearTimeout(pressTimer);
  clearTimeout(cardTimer);
  clearInterval(ageTimer);
});
</script>
<template>
  <div ref="element" class="session-list" :style="{ '--row-h': AGENT_PITCH + 'px' }" @scroll.passive="onScroll">
    <div class="session-spacer" :style="{ height: listHeight + 'px' }">
      <template v-for="row in rows" :key="row.key">
        <div
          v-if="row.kind === 'group'"
          class="group-row"
          :class="{ collapsed: row.collapsed }"
          :style="{ transform: `translateY(${row.top}px)`, height: GROUP_PITCH - 4 + 'px' }"
        >
          <button class="group-toggle" :aria-expanded="!row.collapsed" @click="store.toggleGroup(row.group.key)">
            <span class="group-icon" :style="groupIcon(row.group) ? undefined : { background: tileColor(row.group.name) }">
              <img
                v-if="groupIcon(row.group)"
                :src="groupIcon(row.group)!"
                alt=""
                loading="lazy"
                @error="iconFailed(groupIcon(row.group))"
              />
              <template v-else>{{ initial(row.group.name) }}</template>
            </span>
            <span class="group-name">{{ row.group.name }}</span>
            <span class="group-host" :title="groupHostsTitle(row.group)">{{ groupHosts(row.group) }}</span>
            <!-- Every state present shows, most urgent first, so a collapsed project still says
                 "something is running" even while another thread waits for you. -->
            <span v-if="groupState(row.group) !== 'done'" class="group-marks" :title="summary(row.group)">
              <span v-if="row.group.attention" class="group-flag is-attention">{{ row.group.attention }}</span>
              <span v-if="row.group.failed" class="status-dot is-error"></span>
              <span v-if="row.group.running" class="status-dot is-running"></span>
              <span v-if="row.group.unread" class="status-dot is-unread"></span>
            </span>
            <span v-if="row.collapsed" class="group-count">{{ row.group.items.size }}</span>
            <Icon name="chevron" :size="12" class="group-chevron" />
          </button>
          <button
            class="group-add"
            :aria-label="'New session in ' + row.group.name + ' on ' + groupHosts(row.group)"
            :title="'New session in ' + row.group.name + ' on ' + groupHosts(row.group)"
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
            @mouseenter="hoverStart($event, row.item)"
            @mouseleave="hoverEnd"
          >
            <span class="session-dot"><span v-if="dot(row.item)" class="status-dot" :class="dot(row.item)"></span></span>
            <span class="session-title">
              <Icon v-if="row.item.pinnedAt" name="pin" :size="11" class="pin-mark" />{{ row.item.name }}
            </span>
            <span v-if="mode === 'recent'" class="session-project">{{ row.item.project }}</span>
            <span v-if="row.item.attention" class="pill pill-attention">Needs you</span>
            <span v-else class="session-age">{{ relativeAge(row.item.activityAt, now) }}</span>
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
    <Teleport to="body">
      <div v-if="card" class="thread-card" :style="{ top: card.top + 'px', left: card.left + 'px' }" role="tooltip">
        <p class="thread-card-title">{{ card.thread.name }}</p>
        <p>
          <Icon name="server" :size="14" />{{ hostLabels.get(card.thread.hostId) ?? "Unknown host" }}
          <span v-if="hostStates.get(card.thread.hostId) !== 'connected'" class="thread-card-off">offline</span>
        </p>
        <p v-if="card.thread.branch"><Icon name="branch" :size="14" />{{ card.thread.branch }}</p>
        <p><Icon name="folder" :size="14" />{{ home(card.thread.directory || card.thread.rootPath) }}</p>
      </div>
    </Teleport>
    <div v-if="!total" class="list-empty">
      {{ searching ? "No threads match." : "No threads yet. Add a host to get started." }}
    </div>
  </div>
</template>
