<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, provide, ref, shallowRef, watch } from "vue";
import type { TimelineMessage, TimelinePage } from "../shared/wire.ts";
import { openStream } from "./event-stream.ts";
import { TimelineStore, type RowRef } from "./timeline-store.ts";
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
const older = shallowRef<RowRef[]>([]);
const olderHasMore = ref(false);
const loadingOlder = ref(false);
const notice = ref("");
const element = ref<HTMLElement | null>(null);

const rows = computed(() => {
  version.value;
  store.value.membership.value;
  return older.value.length ? [...older.value, ...store.value.rows] : store.value.rows;
});
const hasOlder = computed(() => {
  version.value;
  return older.value.length ? olderHasMore.value : store.value.hasOlder;
});
const lastSeq = computed(() => rows.value.at(-1)?.seqStart ?? -1);

const nearBottom = () => {
  const el = element.value;
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
};
const toBottom = () =>
  void nextTick(() => {
    const el = element.value;
    if (el) el.scrollTop = el.scrollHeight;
  });

const stream = openStream({
  url: () => "/api" + props.base + "/timeline/stream",
  onMessage: (data) => {
    const message = data as TimelineMessage;
    if (message.type !== "ops") return;
    const current = store.value;
    const stick = nearBottom() || !current.ready;
    const failure = message.ops.find((op) => op.type === "error");
    notice.value = failure?.type === "error" ? failure.message : "";
    const epoch = current.epoch;
    current.apply(message.ops);
    if (epoch && epoch !== current.epoch) older.value = [];
    version.value++;
    if (stick) toBottom();
  },
});
onUnmounted(() => stream.close());

async function showOlder() {
  const current = store.value;
  const first = rows.value[0];
  if (!first || loadingOlder.value) return;
  loadingOlder.value = true;
  notice.value = "";
  try {
    const cursor = JSON.stringify({ epoch: current.epoch, seq: first.seqStart });
    const page: TimelinePage = await props.api(props.base + "/timeline?cursor=" + encodeURIComponent(cursor));
    if (store.value !== current || page.epoch !== current.epoch) return;
    const el = element.value;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    const known = new Set(rows.value.map((r) => r.seqStart));
    const added = page.rows.filter((row) => !known.has(row.seqStart)).map((row) => ({ seqStart: row.seqStart, row: shallowRef(row) }));
    older.value = [...added, ...older.value];
    olderHasMore.value = page.hasOlder;
    await nextTick();
    if (el) el.scrollTop = el.scrollHeight - fromBottom;
  } catch (e) {
    notice.value = (e as Error).message || "Could not load earlier messages.";
  } finally {
    loadingOlder.value = false;
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
      <div v-if="running && store.ready" class="timeline-working" role="status"><span class="spinner"></span><span>Working…</span></div>
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
