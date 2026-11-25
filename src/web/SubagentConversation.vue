<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, provide, ref, shallowRef, watch } from "vue";
import type { TimelineMessage, TimelinePage } from "../shared/wire.ts";
import { openStream } from "./event-stream.ts";
import { TimelineStore, type RowRef } from "./timeline-store.ts";
import { pageHistory, RENDER_WINDOW } from "./timeline-window.ts";
import { TIMELINE_CONTEXT, type TimelineContext } from "./timeline-display.ts";
import TimelineRowView from "./TimelineRowView.vue";

/** A provider subagent's conversation: live and read-only, older rows paged in on request. */
const props = defineProps<{
  /** "/hosts/<host>/agents/<agent>/subagents/<id>". */
  base: string;
  api: (path: string) => Promise<any>;
  running: boolean;
}>();

// Rows render with the parent's file links, but nothing here can rewind or open subagents.
const parent = inject(TIMELINE_CONTEXT, null);
const context = shallowRef<TimelineContext>({ base: "", cwd: "" });
watch(
  () => parent?.value,
  (value) => {
    context.value = { ...(value ?? { base: "", cwd: "" }), rewindModes: [], rewind: undefined, subagents: undefined, openSubagent: undefined };
  },
  { immediate: true },
);
provide(TIMELINE_CONTEXT, context);

const store = shallowRef(new TimelineStore());
const version = ref(0);
const historyRows = shallowRef<RowRef[] | null>(null);
const historyHasOlder = ref(false);
const loadingOlder = ref(false);
const notice = ref("");
const element = ref<HTMLElement | null>(null);

const rows = computed(() => {
  version.value;
  if (historyRows.value) return historyRows.value;
  store.value.membership.value;
  return store.value.rows.slice(-RENDER_WINDOW);
});
const hasOlder = computed(() => {
  version.value;
  if (historyRows.value) return historyHasOlder.value;
  store.value.membership.value;
  return store.value.rows.length > RENDER_WINDOW || store.value.hasOlder;
});
const lastSeq = computed(() => {
  version.value;
  store.value.membership.value;
  return store.value.rows.at(-1)?.seqStart ?? -1;
});

const nearBottom = () => {
  const el = element.value;
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
};
const toBottom = () =>
  void nextTick(() => {
    const el = element.value;
    if (el) el.scrollTop = el.scrollHeight;
  });

let historyGeneration = 0;
const stream = openStream({
  url: () => {
    const at = store.value.resumePoint();
    const query = at
      ? `?epoch=${encodeURIComponent(at.epoch)}${at.view ? `&view=${encodeURIComponent(at.view)}` : ""}&seq=${at.seq}&from=${at.from}`
      : "";
    return "/api" + props.base + "/timeline/stream" + query;
  },
  onMessage: (data) => {
    const message = data as TimelineMessage;
    if (message.type !== "ops" || !Array.isArray(message.ops)) return;
    const current = store.value;
    const stick = !historyRows.value && (nearBottom() || !current.ready);
    const failure = message.ops.find((op) => op.type === "error");
    notice.value = failure?.type === "error" ? failure.message : "";
    const epoch = current.epoch, membership = current.membership.value, ready = current.ready;
    current.apply(message.ops);
    if (epoch && epoch !== current.epoch) {
      historyGeneration++;
      loadingOlder.value = false;
      historyRows.value = null;
    }
    // Text appends re-render only their row (its own ref); the list changes with membership.
    if (membership !== current.membership.value || ready !== current.ready || epoch !== current.epoch) version.value++;
    if (stick) toBottom();
  },
});
onUnmounted(() => {
  historyGeneration++;
  stream.close();
});

function showLatest() {
  historyGeneration++;
  loadingOlder.value = false;
  historyRows.value = null;
  historyHasOlder.value = false;
  toBottom();
}

async function showOlder() {
  const current = store.value;
  const currentRows = rows.value.slice();
  const first = currentRows[0];
  if (!first || loadingOlder.value) return;
  const gen = ++historyGeneration;
  loadingOlder.value = true;
  notice.value = "";
  try {
    const cursor = JSON.stringify({ epoch: current.epoch, seq: first.seqStart });
    const page: TimelinePage = await props.api(props.base + "/timeline?cursor=" + encodeURIComponent(cursor));
    if (gen !== historyGeneration || store.value !== current || page.epoch !== current.epoch) return;
    const el = element.value;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    const snapshot = currentRows.map((r) => ({ seqStart: r.seqStart, row: shallowRef(r.row.value) }));
    const nextWindow = pageHistory(snapshot, page, "before");
    historyRows.value = nextWindow.rows;
    historyHasOlder.value = nextWindow.hasOlder;
    await nextTick();
    if (el) el.scrollTop = Math.max(0, el.scrollHeight - fromBottom);
  } catch (e) {
    if (gen === historyGeneration) notice.value = (e as Error).message || "Could not load earlier messages.";
  } finally {
    if (gen === historyGeneration) loadingOlder.value = false;
  }
}
</script>

<template>
  <div ref="element" class="timeline subagent-timeline">
    <div class="timeline-inner">
      <div v-if="hasOlder" class="older">
        <span v-if="loadingOlder" class="older-loading" role="status"><span class="spinner"></span>Loading earlier messages…</span>
        <button v-else class="btn btn-ghost" @click="showOlder">Show earlier messages</button>
      </div>
      <p v-if="notice" class="notice">{{ notice }}</p>
      <TimelineRowView
        v-for="r in rows"
        :key="store.epoch + ':' + r.seqStart"
        :entry="r.row"
        :final="r.seqStart !== lastSeq || !running"
      />
      <div v-if="historyRows" class="older">
        <button class="btn btn-ghost" @click="showLatest">Back to latest</button>
      </div>
      <div v-if="running && store.ready && !historyRows" class="timeline-working" role="status"><span class="spinner"></span><span>Working…</span></div>
      <div v-if="!rows.length" class="timeline-empty">
        <span v-if="!store.ready" class="spinner"></span>
        {{ store.ready ? "No messages yet." : "Loading conversation…" }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.subagent-timeline .timeline-inner {
  padding: 14px 16px 20px;
}
</style>
