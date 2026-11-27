<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import type { AgentSummary, WorkspaceSummary } from "../shared/wire.ts";
import AgentTabsPicker from "./AgentTabsPicker.vue";
import Icon from "./Icon.vue";
import ScriptsMenu from "./ScriptsMenu.vue";
import type { Api } from "./use-api.ts";
import type { WorkspaceTabs } from "./use-workspace-tabs.ts";

/**
 * The open conversation's header (title, context, subagents, panel and terminal toggles, thread
 * actions) and its tabs: the thread's agents, then open files and the terminal.
 */
const props = defineProps<{
  agent: AgentSummary;
  thread: WorkspaceSummary | null;
  /** The agent's host, named when there is more than one host. */
  hostLabel: string | undefined;
  showHost: boolean;
  /** The agent that delegated this one, when it is a subagent. */
  parent: AgentSummary | null;
  subagents: { total: number; label: string; tone: string } | null;
  /** The thread's agents, most recent first. */
  agents: AgentSummary[];
  selectedKey: string | null;
  tabs: WorkspaceTabs;
  api?: Api;
}>();
const emit = defineEmits<{
  back: [];
  /** Opens another agent (the parent). */
  select: [key: string];
  /** Shows another of the thread's agents. */
  selectAgent: [key: string];
  /** Renames one of the thread's agents. */
  renameAgent: [agent: AgentSummary];
  /** Opens the context menu for one of the thread's agents. */
  agentMenu: [agent: AgentSummary, event: MouseEvent];
  /** Closes (archives) one of the thread's agents. */
  closeAgent: [agent: AgentSummary];
  subagents: [];
  menu: [event: MouseEvent];
  newAgent: [];
}>();
const statsOpen = ref(false);
const tabsEl = ref<HTMLElement | null>(null);
const picker = shallowRef<{ x: number; y: number } | null>(null);
const { panel, togglePanel, terminalOpen, terminalActive, openTerminal, closeTerminal, showConversation, openFiles, activeFile, closeFile } = props.tabs;

const project = computed(() => {
  const cwd = props.agent.cwd ?? "";
  return cwd.replace(/\/+$/, "").split("/").pop() || cwd;
});
const dot = (a: AgentSummary, unread = false) =>
  "is-" + (a.attention ? "attention" : a.state === "failed" ? "error" : a.state === "running" ? "running" : unread && a.unread ? "unread" : "idle");
function showAgent(key: string) {
  emit("selectAgent", key);
  showConversation();
}
function onTabsWheel(event: WheelEvent) {
  const el = tabsEl.value;
  if (!el || el.scrollWidth <= el.clientWidth || event.ctrlKey) return;
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.preventDefault();
    el.scrollLeft += event.deltaY;
  }
}
function togglePicker(event: MouseEvent) {
  if (picker.value) {
    picker.value = null;
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  picker.value = { x: rect.right - 280, y: rect.bottom + 6 };
}
watch([() => props.selectedKey, activeFile, terminalActive], () => {
  void nextTick(() => {
    const nav = tabsEl.value;
    const chosen = nav?.querySelector<HTMLElement>(".chosen");
    if (!nav || !chosen) return;
    // Scroll only the horizontal tab strip; scrollIntoView() would also scroll ancestor
    // containers while the phone detail pane is sliding in.
    const navRect = nav.getBoundingClientRect();
    const itemRect = chosen.getBoundingClientRect();
    if (itemRect.left < navRect.left) nav.scrollLeft -= navRect.left - itemRect.left;
    else if (itemRect.right > navRect.right) nav.scrollLeft += itemRect.right - navRect.right;
  });
});
</script>

<template>
  <header class="chat-head">
    <button class="icon-btn back" aria-label="Back to sessions" @click="emit('back')">
      <Icon name="back" :size="18" />
    </button>
    <span class="status-dot chat-status" :class="dot(agent)" :title="agent.status"></span>
    <h1 class="chat-title" :title="thread?.name || agent.title || ''">
      <Icon v-if="thread?.pinnedAt" name="pin" :size="12" class="title-pin" />{{ thread?.name || agent.title || "Untitled session" }}
    </h1>
    <span
      class="chat-context hide-sm"
      :title="[project, hostLabel, thread?.branch, agent.provider].filter(Boolean).join(' · ')"
    >{{ project }}<template v-if="showHost"> · {{ hostLabel }}</template><template v-if="thread?.branch"> · {{ thread.branch }}</template></span>
    <button
      v-if="parent"
      class="chat-chip"
      :title="'Subagent of ' + (parent.title || 'another session') + ' · open the parent'"
      @click="emit('select', parent.key)"
    >
      <Icon name="back" :size="12" /><span>{{ parent.title || "Parent agent" }}</span>
    </button>
    <span class="grow"></span>
    <div v-if="agent.sessionMetrics?.length" class="session-stats-wrap">
      <button
        type="button"
        class="chat-chip session-stats-chip"
        :aria-expanded="statsOpen"
        :title="agent.sessionMetrics.map((m) => m.label + ': ' + m.value).join(' · ')"
        @click="statsOpen = !statsOpen"
      >
        <Icon name="gauge" :size="13" /><span>{{ agent.sessionMetrics.slice(0, 2).map((m) => m.value).join(" · ") }}</span>
      </button>
      <div v-if="statsOpen" class="session-stats-popover" role="region" aria-label="Session stats">
        <div v-for="(m, i) in agent.sessionMetrics" :key="i" class="turn-metric" :class="m.tone && 'is-' + m.tone">
          <span class="turn-metric-label">{{ m.label }}</span>
          <span class="turn-metric-value">{{ m.value }}</span>
        </div>
      </div>
    </div>
    <button
      v-if="subagents"
      class="chat-chip chat-subagents"
      :class="['is-' + subagents.tone, { chosen: panel === 'subagents' }]"
      :aria-label="'Subagents: ' + subagents.label"
      :title="subagents.total + (subagents.total === 1 ? ' subagent' : ' subagents')"
      @click="emit('subagents')"
    >
      <span v-if="subagents.tone !== 'idle'" class="status-dot" :class="'is-' + subagents.tone"></span>
      <Icon v-else name="bot" :size="14" /><span>{{ subagents.label }}</span>
    </button>
    <button
      class="icon-btn head-tool head-tool-wide"
      :class="{ chosen: panel === 'changes' }"
      :aria-pressed="panel === 'changes'"
      aria-label="Changes"
      title="Workspace changes"
      @click="togglePanel('changes')"
    >
      <Icon name="file" :size="16" />
    </button>
    <button
      class="icon-btn head-tool head-tool-wide"
      :class="{ chosen: panel === 'search' }"
      :aria-pressed="panel === 'search'"
      aria-label="Search conversation"
      title="Search conversation"
      @click="togglePanel('search')"
    >
      <Icon name="search" :size="16" />
    </button>
    <button
      class="icon-btn head-tool"
      :class="{ chosen: panel === 'files' }"
      :aria-pressed="panel === 'files'"
      aria-label="Files"
      title="Files"
      @click="togglePanel('files')"
    >
      <Icon name="folder" :size="16" />
    </button>
    <button
      class="icon-btn head-tool"
      :class="{ chosen: terminalActive }"
      :aria-pressed="terminalActive"
      aria-label="Terminal"
      title="Terminal"
      @click="openTerminal()"
    >
      <Icon name="terminal" :size="16" />
    </button>
    <ScriptsMenu v-if="agent.workspaceId && api" :host-id="agent.hostId" :workspace-id="agent.workspaceId" :api="api" />
    <button
      v-if="agent.workspaceId"
      class="icon-btn head-tool"
      aria-label="New agent in this workspace"
      title="New agent in this workspace"
      @click="emit('newAgent')"
    >
      <Icon name="plus" :size="16" />
    </button>
    <button
      v-if="thread"
      class="icon-btn head-tool"
      aria-label="Thread actions"
      title="Rename, pin, mark unread, archive"
      @click="emit('menu', $event)"
    >
      <Icon name="more" :size="16" />
    </button>
  </header>
  <!-- Tabs: the thread's agents, then files opened from the side panel (Paseo's workspace tabs). -->
  <div v-if="agents.length > 1 || openFiles.length || terminalOpen" class="agent-tabs-bar">
    <nav ref="tabsEl" class="agent-tabs" aria-label="Tabs" @wheel="onTabsWheel">
    <template v-if="agents.length > 1">
      <div
        v-for="a in agents"
        :key="a.key"
        class="file-tab agent-tab"
        :class="{ chosen: a.key === selectedKey && !activeFile && !terminalActive }"
        @auxclick.prevent="$event.button === 1 && emit('closeAgent', a)"
        @contextmenu.prevent="emit('agentMenu', a, $event)"
      >
        <button
          type="button"
          class="file-tab-open"
          :title="a.title || a.provider"
          :aria-current="a.key === selectedKey && !activeFile && !terminalActive ? 'page' : undefined"
          @click="showAgent(a.key)"
          @dblclick="emit('renameAgent', a)"
        >
          <span class="status-dot" :class="dot(a, true)"></span>
          <span class="agent-tab-name">{{ a.title || a.provider }}</span>
        </button>
        <button
          v-if="a.key === selectedKey && !activeFile && !terminalActive"
          type="button"
          class="tab-action"
          :aria-label="'Rename ' + (a.title || a.provider)"
          :title="'Rename ' + (a.title || a.provider)"
          @click="emit('renameAgent', a)"
        >
          <Icon name="edit" :size="11" />
        </button>
        <button
          type="button"
          class="tab-close"
          :aria-label="'Close ' + (a.title || a.provider)"
          :title="'Close ' + (a.title || a.provider)"
          @click="emit('closeAgent', a)"
        >
          <Icon name="close" :size="11" />
        </button>
      </div>
    </template>
    <template v-else>
      <button
        v-for="a in agents.length ? agents : [agent]"
        :key="a.key"
        :class="{ chosen: a.key === selectedKey && !activeFile && !terminalActive }"
        @click="showAgent(a.key)"
        @dblclick="emit('renameAgent', a)"
        @contextmenu.prevent="emit('agentMenu', a, $event)"
      >
        <span class="status-dot" :class="dot(a, true)"></span>
        <span class="agent-tab-name">{{ a.title || a.provider }}</span>
      </button>
    </template>
    <div
      v-for="f in openFiles"
      :key="'file:' + f"
      class="file-tab"
      :class="{ chosen: activeFile === f }"
      @auxclick.prevent="$event.button === 1 && closeFile(f)"
    >
      <button type="button" class="file-tab-open" :title="f" :aria-current="activeFile === f ? 'page' : undefined" @click="activeFile = f">
        <Icon name="file" :size="13" />
        <span class="agent-tab-name">{{ f.split("/").pop() }}</span>
      </button>
      <button type="button" class="tab-close" :aria-label="'Close ' + f" :title="'Close ' + f" @click="closeFile(f)"><Icon name="close" :size="11" /></button>
    </div>
    <button
      v-if="agent.workspaceId"
      type="button"
      class="agent-tab-add"
      title="New agent in this workspace"
      aria-label="New agent in this workspace"
      @click="emit('newAgent')"
    >
      <Icon name="plus" :size="13" />
    </button>
    <div v-if="terminalOpen" class="file-tab" :class="{ chosen: terminalActive }">
      <button type="button" class="file-tab-open" :aria-current="terminalActive ? 'page' : undefined" @click="openTerminal()">
        <Icon name="terminal" :size="13" /><span class="agent-tab-name">Terminal</span>
      </button>
      <button type="button" class="tab-close" aria-label="Close terminal tab" title="Close terminal tab" @click="closeTerminal()"><Icon name="close" :size="11" /></button>
    </div>
    </nav>
    <button
      v-if="agents.length > 1"
      type="button"
      class="agent-tabs-picker"
      :class="{ chosen: !!picker }"
      :aria-expanded="!!picker"
      aria-haspopup="dialog"
      :aria-label="'All ' + agents.length + ' sessions'"
      :title="'All ' + agents.length + ' sessions'"
      @click="togglePicker"
    >
      <Icon name="list" :size="13" />
      <span>{{ agents.length }}</span>
    </button>
  </div>
  <AgentTabsPicker
    v-if="picker"
    :agents="agents"
    :selected-key="selectedKey"
    :x="picker.x"
    :y="picker.y"
    @close="picker = null"
    @select="showAgent"
    @rename="(a) => emit('renameAgent', a)"
    @close-agent="(a) => emit('closeAgent', a)"
  />
</template>
