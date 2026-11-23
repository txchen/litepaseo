<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import type { AgentSummary, ProviderSubagent } from "../shared/wire.ts";
import Icon from "./Icon.vue";
import { agentPath as path, type Api } from "./use-api.ts";
import type { Panel } from "./use-workspace-tabs.ts";
// The panels load on first use: the file viewer and xterm.js stay out of the first page.
const ChangesPanel = defineAsyncComponent(() => import("./ChangesPanel.vue"));
const ConversationSearch = defineAsyncComponent(() => import("./ConversationSearch.vue"));
const FilesPanel = defineAsyncComponent(() => import("./FilesPanel.vue"));
const SubagentsPanel = defineAsyncComponent(() => import("./SubagentsPanel.vue"));

const LABELS = { files: "Files", changes: "Changes", search: "Search conversation", subagents: "Subagents" } as const;

/** Beside the open conversation: Files, Changes, Search and Subagents. The default slot holds the resize handle. */
defineProps<{
  agent: AgentSummary;
  /** The thread's working directory. */
  cwd: string;
  api: Api;
  /** Agents the open agent delegated, and its provider subagents. */
  agents: AgentSummary[];
  subagents: ProviderSubagent[];
  /** The Subagents tab shows while the agent has any. */
  hasSubagents: boolean;
  /** The file open in the center, highlighted in the tree. */
  activePath: string | null;
  reveal: { owner: string; path: string; seq: number } | null;
}>();
const panel = defineModel<Panel>("panel", { required: true });
const opened = defineModel<string | null>("opened", { required: true });
const emit = defineEmits<{
  close: [];
  jump: [seq: number, epoch: string];
  select: [key: string];
  open: [path: string];
  sendReview: [prompt: string];
}>();
</script>

<template>
  <aside class="side-panel" :aria-label="LABELS[panel]">
    <slot />
    <div class="panel-tabs">
      <button :class="{ chosen: panel === 'files' }" @click="panel = 'files'"><Icon name="folder" :size="14" />Files</button>
      <button :class="{ chosen: panel === 'changes' }" @click="panel = 'changes'">Changes</button>
      <button :class="{ chosen: panel === 'search' }" @click="panel = 'search'">Search</button>
      <button v-if="hasSubagents || panel === 'subagents'" :class="{ chosen: panel === 'subagents' }" @click="panel = 'subagents'">Subagents</button>
      <span class="grow"></span>
      <button class="icon-btn" aria-label="Close panel" title="Close panel" @click="emit('close')"><Icon name="close" :size="14" /></button>
    </div>
    <div class="panel-body">
      <ChangesPanel v-if="panel === 'changes'" :host-id="agent.hostId" :cwd="cwd" :workspace-id="agent.workspaceId" :api="api" @send-review="(p) => emit('sendReview', p)" />
      <ConversationSearch v-if="panel === 'search'" :base="path(agent)" :api="api" @jump="(seq, epoch) => emit('jump', seq, epoch)" />
      <SubagentsPanel
        v-if="panel === 'subagents'"
        v-model:opened="opened"
        :agents="agents"
        :subagents="subagents"
        :base="path(agent)"
        :api="api"
        @select="(key) => emit('select', key)"
      />
      <KeepAlive :max="5">
        <FilesPanel
          v-if="panel === 'files'"
          :key="'f:' + agent.hostId + ':' + cwd"
          :host-id="agent.hostId"
          :cwd="cwd"
          :api="api"
          :active-path="activePath"
          :reveal="reveal"
          @open="(path) => emit('open', path)"
        />
      </KeepAlive>
    </div>
  </aside>
</template>
