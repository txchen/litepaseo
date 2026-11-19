<script setup lang="ts">
import { computed } from "vue";
import type { AgentSummary, WorkspaceSummary } from "../shared/wire.ts";
import Icon from "./Icon.vue";
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
}>();
const emit = defineEmits<{
  back: [];
  /** Opens another agent (the parent). */
  select: [key: string];
  /** Shows another of the thread's agents. */
  selectAgent: [key: string];
  subagents: [];
  menu: [event: MouseEvent];
}>();
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
  <nav v-if="agents.length > 1 || openFiles.length || terminalOpen" class="agent-tabs" aria-label="Tabs">
    <button
      v-for="a in agents.length ? agents : [agent]"
      :key="a.key"
      :class="{ chosen: a.key === selectedKey && !activeFile && !terminalActive }"
      @click="showAgent(a.key)"
    >
      <span class="status-dot" :class="dot(a, true)"></span>
      <span class="agent-tab-name">{{ a.title || a.provider }}</span>
    </button>
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
    <div v-if="terminalOpen" class="file-tab" :class="{ chosen: terminalActive }">
      <button type="button" class="file-tab-open" :aria-current="terminalActive ? 'page' : undefined" @click="openTerminal()">
        <Icon name="terminal" :size="13" /><span class="agent-tab-name">Terminal</span>
      </button>
      <button type="button" class="tab-close" aria-label="Close terminal tab" title="Close terminal tab" @click="closeTerminal()"><Icon name="close" :size="11" /></button>
    </div>
  </nav>
</template>
