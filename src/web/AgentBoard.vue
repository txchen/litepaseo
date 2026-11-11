<script setup lang="ts">
import { computed, reactive } from "vue";
import { LANES, midSentence, type AgentSummary, type Lane } from "../shared/wire.ts";
import type { DirectoryStore } from "./directory-store.ts";
import Icon from "./Icon.vue";

// Every agent in lanes by state, derived live from the directory (no storage of its own).
const props = defineProps<{
  store: DirectoryStore;
  hostLabels: Map<string, string>;
  busy: boolean;
}>();
const emit = defineEmits<{
  open: [key: string];
  stop: [agent: AgentSummary];
  read: [agent: AgentSummary];
  archive: [agent: AgentSummary];
}>();

const PAGE = 40;
const TITLES: Record<Lane, string> = {
  needs_input: "Needs you",
  running: "Running",
  review: "To review",
  done: "Done",
};
const HINTS: Record<Lane, string> = {
  needs_input: "Waiting on a permission or an answer",
  running: "Working right now",
  review: "Finished or failed, not looked at yet",
  done: "Seen and settled",
};
const limits = reactive<Record<Lane, number>>({ needs_input: PAGE, running: PAGE, review: PAGE, done: PAGE });
// Each lane materializes only its first `limit` cards: O(limit · log n) per change.
const lanes = computed(() => {
  props.store.version.value;
  return LANES.map((lane) => ({
    lane,
    size: props.store.laneSize(lane),
    agents: props.store.laneRange(lane, 0, limits[lane]),
  }));
});
const ago = (t: number) => {
  // Before 2020 means "no real timestamp" (a stored agent without one).
  if (!t || t < 1_577_836_800_000) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const detail = (a: AgentSummary) => {
  if (a.state === "needs_input") {
    const p = a.pendingPermissions[0];
    return p ? `${p.kind === "question" ? "Asks:" : "Wants to"} ${midSentence(p.title || p.name)}` : "Waiting for you";
  }
  if (a.state === "failed") return a.lastError || "Turn failed";
  if (a.state === "running") return "Working…";
  if (a.state === "unread") return `Finished ${ago(a.activityAt)}`;
  return ago(a.activityAt);
};
</script>

<template>
  <div class="agent-board">
    <section v-for="column in lanes" :key="column.lane" class="lane" :class="'lane-' + column.lane">
      <header class="lane-head" :title="HINTS[column.lane]">
        <span class="lane-dot"></span>
        <h3>{{ TITLES[column.lane] }}</h3>
        <span class="count">{{ column.size }}</span>
      </header>
      <article
        v-for="a in column.agents"
        :key="a.key"
        class="task-card"
        :class="'is-' + a.state"
        tabindex="0"
        @click="emit('open', a.key)"
        @keydown.enter="emit('open', a.key)"
      >
        <div class="task-top">
          <span class="status-dot" :class="'is-' + (a.state === 'needs_input' ? 'attention' : a.state === 'failed' ? 'error' : a.state)"></span>
          <span class="task-title">{{ a.title || "Untitled session" }}</span>
        </div>
        <div class="task-meta">{{ a.project }} · {{ hostLabels.get(a.hostId) ?? "?" }} · {{ a.provider }}</div>
        <div class="task-detail" :class="{ 'is-error': a.state === 'failed' }">{{ detail(a) }}</div>
        <div class="task-actions" @click.stop>
          <button v-if="a.state === 'needs_input'" class="btn btn-primary btn-sm" @click="emit('open', a.key)">Respond</button>
          <button v-if="a.state === 'running'" class="btn btn-outline btn-sm" :disabled="busy" @click="emit('stop', a)">
            <Icon name="stop" :size="11" />Stop
          </button>
          <button v-if="a.unread" class="btn btn-outline btn-sm" :disabled="busy" @click="emit('read', a)">
            <Icon name="check" :size="12" />Mark read
          </button>
          <button
            v-if="a.state !== 'running' && a.state !== 'needs_input'"
            class="btn btn-ghost btn-sm"
            :disabled="busy"
            @click="emit('archive', a)"
          >
            Archive
          </button>
        </div>
      </article>
      <button v-if="column.size > limits[column.lane]" class="btn btn-ghost lane-more" @click="limits[column.lane] += PAGE">
        Show {{ Math.min(PAGE, column.size - limits[column.lane]) }} more
      </button>
      <p v-if="!column.size" class="column-empty">Nothing here</p>
    </section>
  </div>
</template>
