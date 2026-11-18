<script setup lang="ts">
import { computed } from "vue";
import type { AgentSummary, ProviderSubagent } from "../shared/wire.ts";
import Icon from "./Icon.vue";
import SubagentConversation from "./SubagentConversation.vue";

/**
 * The open agent's subagents, as Paseo's chat shows them: agents it delegated through Paseo
 * (full sessions, opened in place) and subagents its provider runs (read-only conversations).
 */
const props = defineProps<{
  agents: AgentSummary[];
  subagents: ProviderSubagent[];
  /** "/hosts/<host>/agents/<agent>" of the parent. */
  base: string;
  api: (path: string) => Promise<any>;
  /** The provider subagent shown; null for the list. */
  opened: string | null;
}>();
const emit = defineEmits<{ "update:opened": [id: string | null]; select: [key: string] }>();

const shown = computed(() => (props.opened ? props.subagents.find((s) => s.id === props.opened) ?? null : null));
const agentDot = (a: AgentSummary) =>
  a.attention ? "attention" : a.state === "failed" ? "error" : a.state === "running" ? "running" : a.unread ? "unread" : "idle";
const agentStatus = (a: AgentSummary) =>
  a.attention ? "Needs input" : a.state === "failed" ? "Failed" : a.state === "running" ? "Working" : a.unread ? "Ready to review" : "Idle";
const subagentDot = (s: ProviderSubagent) =>
  s.status === "running" ? "running" : s.status === "failed" ? "error" : "idle";
const subagentStatus = (s: ProviderSubagent) =>
  s.status === "running" ? "Working" : s.status === "failed" ? "Failed" : s.status === "canceled" ? "Canceled" : "Done";
/** Paseo labels a subagent by its task, falling back to its type. */
const subagentLabel = (s: ProviderSubagent) => s.description?.trim() || s.title?.trim() || "Subagent";
const subagentDetail = (s: ProviderSubagent) => {
  const description = s.description?.trim();
  return s.subtitle?.trim() || (description ? s.title?.trim() : "") || "";
};
</script>

<template>
  <section class="subagents-panel">
    <template v-if="opened">
      <header class="subagent-head">
        <button class="icon-btn" aria-label="All subagents" title="All subagents" @click="emit('update:opened', null)">
          <Icon name="back" :size="16" />
        </button>
        <span v-if="shown" class="status-dot" :class="'is-' + subagentDot(shown)" :title="subagentStatus(shown)"></span>
        <span class="subagent-title" :title="shown ? subagentLabel(shown) : ''">{{ shown ? subagentLabel(shown) : "Subagent" }}</span>
        <span v-if="shown" class="subagent-meta">{{ subagentStatus(shown) }}</span>
      </header>
      <SubagentConversation
        :key="base + ':' + opened"
        :base="base + '/subagents/' + encodeURIComponent(opened)"
        :api="api"
        :running="shown?.status === 'running'"
      />
    </template>
    <div v-else class="subagent-list">
      <p v-if="!agents.length && !subagents.length" class="subagent-empty">No subagents yet.</p>
      <template v-if="agents.length">
        <h3>Delegated agents</h3>
        <button v-for="a in agents" :key="a.key" class="subagent-row" @click="emit('select', a.key)">
          <span class="status-dot" :class="'is-' + agentDot(a)"></span>
          <span class="subagent-text">
            <span class="subagent-name">{{ a.title || "Untitled session" }}</span>
            <span class="subagent-sub">{{ agentStatus(a) }} · {{ a.provider }}</span>
          </span>
          <Icon name="chevron" :size="12" class="subagent-go" />
        </button>
      </template>
      <template v-if="subagents.length">
        <h3>Provider subagents</h3>
        <button v-for="s in subagents" :key="s.id" class="subagent-row" :class="{ nested: !!s.parentSubagentId }" @click="emit('update:opened', s.id)">
          <span class="status-dot" :class="'is-' + subagentDot(s)"></span>
          <span class="subagent-text">
            <span class="subagent-name">{{ subagentLabel(s) }}</span>
            <span class="subagent-sub">{{ subagentStatus(s) }}<template v-if="subagentDetail(s)"> · {{ subagentDetail(s) }}</template></span>
          </span>
          <Icon name="chevron" :size="12" class="subagent-go" />
        </button>
      </template>
    </div>
  </section>
</template>

<style scoped>
.subagents-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.subagent-list {
  overflow-y: auto;
  padding: 8px;
}
.subagent-list h3 {
  margin: 10px 8px 4px;
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-faint);
}
.subagent-empty {
  padding: 16px 8px;
  color: var(--fg-muted);
  font-size: 13px;
}
.subagent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  border-radius: 8px;
  text-align: left;
}
.subagent-row:hover {
  background: var(--hover);
}
.subagent-row.nested {
  padding-left: 24px;
}
.subagent-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.subagent-name,
.subagent-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subagent-name {
  font-size: 13px;
  color: var(--fg);
}
.subagent-sub {
  font-size: 12px;
  color: var(--fg-faint);
}
.subagent-go {
  flex: none;
  color: var(--fg-faint);
}
.subagent-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 10px 0 4px;
  border-bottom: 1px solid var(--border);
}
.subagent-head .icon-btn {
  width: 28px;
  height: 28px;
}
.subagent-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}
.subagent-meta {
  flex: none;
  font-size: 12px;
  color: var(--fg-faint);
}
</style>
