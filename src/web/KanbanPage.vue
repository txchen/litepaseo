<script setup lang="ts">
import { ref, watch } from "vue";
import type { AgentSummary } from "../shared/wire.ts";
import AgentBoard from "./AgentBoard.vue";
import { confirmAction } from "./confirm.ts";
import type { DirectoryStore } from "./directory-store.ts";
import Icon from "./Icon.vue";
import PlanBoard, { type Board } from "./PlanBoard.vue";
import { safeGetItem, safeSetItem } from "./safe-storage.ts";
import { agentPath as path, type Api } from "./use-api.ts";

/** Kanban: live agent lanes (default) or the hand-made plan. */
const props = defineProps<{
  store: DirectoryStore<AgentSummary>;
  /** The open agent, offered first when linking a task. */
  active: AgentSummary | null;
  hostLabels: Map<string, string>;
  api: Api;
  /** Runs a request with the app's busy flag and error toast. */
  action: (fn: () => Promise<void>) => Promise<void>;
  busy: boolean;
}>();
const board = defineModel<Board>("board", { required: true });
const emit = defineEmits<{ back: []; open: [key: string] }>();

const mode = ref<"agents" | "plan">(safeGetItem("litepaseo-board-mode") === "plan" ? "plan" : "agents");
watch(mode, (next) => safeSetItem("litepaseo-board-mode", next));
async function stopAgent(a: AgentSummary) {
  await props.action(async () => void (await props.api(path(a) + "/stop", "POST")));
}
async function markRead(a: AgentSummary) {
  await props.action(async () => void (await props.api(path(a) + "/read", "POST", {})));
}
async function archiveAgent(a: AgentSummary) {
  if (!(await confirmAction({ title: `Archive “${a.title || "this session"}”?`, message: "It leaves the board and sidebar; the host keeps its history.", confirmLabel: "Archive" }))) return;
  await props.action(async () => void (await props.api(path(a) + "/archive", "POST", {})));
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <button class="icon-btn back" aria-label="Back" @click="emit('back')">
        <Icon name="back" :size="18" />
      </button>
      <div>
        <h1>Kanban</h1>
        <p class="subtle">
          {{
            mode === "agents"
              ? "Every agent by state, live. Follows the host filter and search."
              : "Your own plan. Moving a card never changes an agent."
          }}
        </p>
      </div>
      <div class="segmented head-toggle" role="radiogroup" aria-label="Board">
        <button role="radio" :aria-checked="mode === 'agents'" :class="{ chosen: mode === 'agents' }" @click="mode = 'agents'">Agents</button>
        <button role="radio" :aria-checked="mode === 'plan'" :class="{ chosen: mode === 'plan' }" @click="mode = 'plan'">Plan</button>
      </div>
    </header>
    <div class="page-body wide">
      <AgentBoard
        v-if="mode === 'agents'"
        :store="store"
        :host-labels="hostLabels"
        :busy="busy"
        @open="(key) => emit('open', key)"
        @stop="stopAgent"
        @read="markRead"
        @archive="archiveAgent"
      />
      <PlanBoard
        v-else
        v-model:board="board"
        :store="store"
        :active="active"
        :host-labels="hostLabels"
        :api="api"
        :action="action"
        :busy="busy"
        @open="(key) => emit('open', key)"
      />
    </div>
  </section>
</template>
