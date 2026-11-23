<script setup lang="ts">
import { computed, ref } from "vue";
import type { HostState, WorkspaceSummary } from "../shared/wire.ts";
import type { DirectoryStore, ProjectGroup } from "./directory-store.ts";
import type { StreamState } from "./event-stream.ts";
import Icon from "./Icon.vue";
import SessionList from "./SessionList.vue";
import { cycleTheme, theme } from "./theme.ts";
import UsagePanel, { type UsageReport } from "./UsagePanel.vue";

export type Tab = "chat" | "board" | "hosts" | "settings" | "schedules";

/**
 * The sidebar, as in Paseo: search and the few pages, the workspace list with its grouping and
 * host filter, usage, and the footer (live state, schedules, hosts, theme, settings).
 * The default slot holds the resize handle.
 */
const props = defineProps<{
  instanceName: string;
  hosts: HostState[];
  store: DirectoryStore<WorkspaceSummary>;
  hostLabels: Map<string, string>;
  hostStates: Map<string, string>;
  queues: Record<string, { count: number; paused: boolean }>;
  selectedThread: string | null;
  usage: UsageReport | null;
  usageLoading: boolean;
  directoryState: StreamState;
  tab: Tab;
}>();
const query = defineModel<string>("query", { required: true });
const listMode = defineModel<"projects" | "recent">("listMode", { required: true });
const hostFilter = defineModel<string | null>("hostFilter", { required: true });
const emit = defineEmits<{
  select: [key: string];
  new: [group: ProjectGroup<WorkspaceSummary>];
  menu: [thread: WorkspaceSummary, x: number, y: number];
  projectMenu: [group: ProjectGroup<WorkspaceSummary>, x: number, y: number];
  openTab: [tab: Tab];
  refreshUsage: [];
  openCommandCenter: [];
  addProject: [];
  openArchived: [];
}>();

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const viewMenu = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);

const sessionCount = computed(() => {
  props.store.version.value;
  return props.store.total;
});
const viewSize = computed(() => {
  props.store.version.value;
  return props.store.size;
});
const projectCount = computed(() => {
  props.store.version.value;
  return props.store.projectCount;
});
const hostCounts = computed(() => {
  props.store.version.value;
  return new Map(props.hosts.map((h) => [h.id, props.store.hostSize(h.id)]));
});
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** The sidebar count spelled out, e.g. "45 workspaces in 23 projects". */
const listSummary = computed(() => `${plural(viewSize.value, "workspace")} in ${plural(projectCount.value, "project")}`);
const connectedHosts = computed(() => props.hosts.filter((h) => h.state === "connected").length);
const liveLabel = computed(() =>
  props.directoryState === "live"
    ? "Live"
    : props.directoryState === "paused"
      ? "Paused"
      : "Reconnecting",
);

defineExpose({
  /** The search shortcut (/ or ⌘K / Ctrl K). */
  focusSearch() {
    searchInput.value?.focus();
    searchInput.value?.select();
  },
  isSearchInput: (element: EventTarget | null) => !!element && element === searchInput.value,
});
</script>

<template>
  <aside class="sidebar">
    <slot />
    <!-- Compact navigation, as in Paseo: search and the few pages, then the workspace list. -->
    <div v-if="instanceName" class="instance-name" :title="instanceName">{{ instanceName }}</div>
    <nav class="side-nav" aria-label="Pages">
      <label class="side-row side-search" :class="{ active: !!query }">
        <Icon name="search" :size="15" />
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          placeholder="Search"
          aria-label="Search sessions, projects, hosts"
          aria-keyshortcuts="/ Control+K Meta+K"
        />
        <button type="button" class="kbd-btn hide-sm" title="Open Command Center" @click.stop.prevent="emit('openCommandCenter')"><kbd>{{ isMac ? "⌘K" : "Ctrl K" }}</kbd></button>
      </label>
      <button class="side-row" :class="{ chosen: tab === 'board' }" @click="emit('openTab', 'board')">
        <Icon name="board" :size="15" />Kanban
      </button>
    </nav>
    <div class="side-section">
      <span class="side-label">{{ listMode === "projects" ? "Workspaces" : "Recent" }}</span>
      <!-- Always the number of workspaces listed: the same unit as the host chips. -->
      <span class="list-summary" :title="listSummary" :aria-label="listSummary">{{ viewSize }}</span>
      <button
        class="icon-btn side-tool"
        aria-label="Add project"
        title="Add project"
        @click="emit('addProject')"
      >
        <Icon name="plus" :size="15" />
      </button>
      <button
        class="icon-btn side-tool"
        :class="{ chosen: viewMenu || hostFilter !== null || listMode !== 'projects' }"
        aria-label="View options"
        title="Group and filter"
        :aria-expanded="viewMenu"
        @click="viewMenu = !viewMenu"
      >
        <Icon name="sliders" :size="15" />
      </button>
    </div>
    <div v-if="hostFilter" class="active-host-filter" role="group" aria-label="Active host filter">
      <button class="active-host-label" :title="'Filtered by host: ' + (hostLabels.get(hostFilter) ?? hostFilter)" @click="viewMenu = true">
        <Icon name="server" :size="13" />
        <span>Host: {{ hostLabels.get(hostFilter) ?? hostFilter }}</span>
      </button>
      <button class="icon-btn" aria-label="Clear host filter" title="Show all hosts" @click="hostFilter = null"><Icon name="close" :size="13" /></button>
    </div>
    <div v-if="viewMenu" class="view-menu">
      <div class="segmented segmented-sm" role="radiogroup" aria-label="Group sessions">
        <button role="radio" :aria-checked="listMode === 'projects'" :class="{ chosen: listMode === 'projects' }" @click="listMode = 'projects'">
          By project
        </button>
        <button role="radio" :aria-checked="listMode === 'recent'" :class="{ chosen: listMode === 'recent' }" @click="listMode = 'recent'">Recent</button>
      </div>
      <div v-if="hosts.length > 1" class="host-filter" role="radiogroup" aria-label="Filter by host">
        <button role="radio" :aria-checked="hostFilter === null" :class="{ chosen: hostFilter === null }" @click="hostFilter = null">
          All<span class="chip-count" :title="plural(sessionCount, 'workspace')">{{ sessionCount }}</span>
        </button>
        <button
          v-for="h in hosts"
          :key="h.id"
          role="radio"
          :aria-checked="hostFilter === h.id"
          :class="{ chosen: hostFilter === h.id }"
          :title="h.label + ' · ' + h.state"
          @click="hostFilter = h.id"
        >
          <span class="status-dot" :class="h.state === 'connected' ? 'is-idle-ok' : 'is-offline'"></span
          >{{ h.label }}<span class="chip-count" :title="plural(hostCounts.get(h.id) ?? 0, 'workspace')">{{ hostCounts.get(h.id) }}</span>
        </button>
      </div>
    </div>
    <SessionList
      :queues="queues"
      :mode="listMode"
      :store="store"
      :host-labels="hostLabels"
      :host-states="hostStates"
      :selected-key="selectedThread"
      :searching="!!query.trim()"
      @select="(key) => emit('select', key)"
      @new="(group) => emit('new', group)"
      @menu="(thread, x, y) => emit('menu', thread, x, y)"
      @project-menu="(group, x, y) => emit('projectMenu', group, x, y)"
    />
    <UsagePanel :report="usage" :loading="usageLoading" @refresh="emit('refreshUsage')" />
    <div class="side-foot">
      <span class="live" :class="'is-' + directoryState" :title="'Directory stream: ' + directoryState">
        <span class="live-dot"></span>{{ liveLabel }}
      </span>
      <button
        class="icon-btn"
        title="Archived workspaces"
        aria-label="Archived workspaces"
        @click="emit('openArchived')"
      >
        <Icon name="archive" :size="15" />
      </button>
      <button
        class="icon-btn"
        :class="{ chosen: tab === 'schedules' }"
        title="Schedules"
        aria-label="Schedules"
        @click="emit('openTab', 'schedules')"
      >
        <Icon name="clock" :size="15" />
      </button>
      <button
        class="icon-btn foot-hosts"
        :class="{ chosen: tab === 'hosts' }"
        :title="`Hosts: ${connectedHosts} of ${hosts.length} connected`"
        :aria-label="`Hosts, ${connectedHosts} of ${hosts.length} connected`"
        @click="emit('openTab', 'hosts')"
      >
        <Icon name="server" :size="15" />
        <span v-if="connectedHosts < hosts.length" class="foot-alert" aria-hidden="true"></span>
      </button>
      <button
        class="icon-btn"
        :title="'Theme: ' + theme + ' (click to change)'"
        :aria-label="'Theme: ' + theme"
        @click="cycleTheme"
      >
        <Icon :name="theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor'" :size="15" />
      </button>
      <button class="icon-btn" :class="{ chosen: tab === 'settings' }" title="Settings" aria-label="Settings" @click="emit('openTab', 'settings')">
        <Icon name="gear" :size="15" />
      </button>
    </div>
  </aside>
</template>
