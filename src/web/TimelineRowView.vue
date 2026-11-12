<script setup lang="ts">
import { computed, inject, ref, type ShallowRef } from "vue";
import type { TimelineRow } from "../shared/wire.ts";
import { renderMarkdown } from "./markdown.ts";
import { loadMarkstream, markstream } from "./markstream-loader.ts";
import { TIMELINE_CONTEXT, editDiff, reasoningHeadline, rewriteImageSources, toolDisplay, toolOutput } from "./timeline-display.ts";
import Icon from "./Icon.vue";
import PluginRow from "./PluginRow.vue";

// Receives the row's own ref: only this component re-renders when the row changes.
const props = defineProps<{ entry: ShallowRef<TimelineRow>; final: boolean }>();
const context = inject(TIMELINE_CONTEXT, null);
const row = computed(() => props.entry.value);
const item = computed(() => row.value.item as Record<string, any>);
const open = ref(false);
/** Large outputs are cut for display: a 2 MB log must not freeze the page when expanded. */
const MAX_DETAIL = 20_000;
const MAX_DIFF_LINES = 600;

const assistantText = computed(() => {
  const text = String(item.value.text ?? "");
  return context?.value ? rewriteImageSources(text, context.value.base) : text;
});
// Markstream arrives asynchronously; until then the built-in renderer (escapes all input,
// only http(s)/mailto links and this app's own images) shows the same message.
const fallbackHtml = computed(() =>
  !markstream.value && item.value.type === "assistant_message" ? renderMarkdown(assistantText.value) : "",
);
if (!markstream.value && item.value.type === "assistant_message") void loadMarkstream();

const tool = computed(() => {
  const i = item.value;
  if (i.type !== "tool_call") return null;
  const display = toolDisplay(i, context?.value.cwd);
  return { ...display, summary: display.summary.split("\n")[0], status: String(i.status ?? "running") };
});
/** Thinking shows its first line, as Paseo does; the rest opens on click. */
const headline = computed(() => (item.value.type === "reasoning" ? reasoningHeadline(String(item.value.text ?? "")) : ""));
const reasoningMore = computed(() => {
  const text = String(item.value.text ?? "").trim();
  return text.length > headline.value.length + 4;
});
const clip = (text: string) => (text.length > MAX_DETAIL ? text.slice(0, MAX_DETAIL) + "\n… (truncated)" : text);
// Only computed while expanded: collapsed rows cost nothing beyond their summary line.
const detail = computed(() => {
  if (!open.value || !tool.value) return null;
  const i = item.value;
  const d = (i.detail ?? {}) as Record<string, any>;
  const diff = editDiff(i);
  const lines = diff ? diff.split("\n") : [];
  const output = clip(toolOutput(i));
  const input = d.type === "unknown" && d.input !== undefined ? clip(JSON.stringify(d.input, null, 2)) : "";
  return {
    command: d.type === "shell" || tool.value.kind === "shell" ? String(d.command ?? (d.input as any)?.command ?? tool.value.summary) : "",
    exitCode: typeof d.exitCode === "number" ? d.exitCode : null,
    diff: lines.slice(0, MAX_DIFF_LINES).map((text) => ({
      text,
      kind: text.startsWith("@@") ? "hunk" : text.startsWith("+") && !text.startsWith("+++") ? "add" : text.startsWith("-") && !text.startsWith("---") ? "del" : "",
    })),
    diffMore: Math.max(0, lines.length - MAX_DIFF_LINES),
    input: tool.value.kind === "shell" ? "" : input,
    output,
    error: i.error ? clip(typeof i.error === "string" ? i.error : JSON.stringify(i.error, null, 2)) : "",
  };
});
const todo = computed(() => (item.value.type === "todo" ? (item.value.items as any[]) : []));
const raw = computed(() => (open.value ? clip(JSON.stringify(item.value, null, 2)) : ""));
const label = computed(() => String(item.value.type).replaceAll("_", " "));
const onToggle = (event: Event) => (open.value = (event.target as HTMLDetailsElement).open);
</script>

<template>
  <div v-if="item.type === 'user_message'" class="row row-user">
    <div class="bubble">{{ item.text }}</div>
  </div>

  <div v-else-if="item.type === 'assistant_message'" class="row row-assistant">
    <component :is="markstream" v-if="markstream" :content="assistantText" :final="final" />
    <div v-else class="prose" v-html="fallbackHtml"></div>
  </div>

  <details v-else-if="item.type === 'reasoning'" class="row row-line row-reasoning" :class="{ 'is-static': !reasoningMore }" @toggle="onToggle">
    <summary :tabindex="reasoningMore ? undefined : -1" @click="!reasoningMore && $event.preventDefault()">
      <span class="line-icon"><Icon name="bulb" :size="15" /></span>
      <span class="line-text">{{ headline || "Thinking" }}</span>
    </summary>
    <div v-if="open" class="reasoning-text">{{ item.text }}</div>
  </details>

  <details v-else-if="tool" class="row row-line row-tool" :class="['is-' + tool.status, 'kind-' + tool.kind]" @toggle="onToggle">
    <summary :title="tool.name + (tool.status === 'failed' ? ' · failed' : tool.status === 'canceled' ? ' · canceled' : '')">
      <span class="line-icon">
        <span v-if="tool.status === 'running'" class="status-dot is-running"></span>
        <Icon v-else :name="tool.status === 'failed' ? 'close' : tool.icon" :size="15" />
      </span>
      <span v-if="tool.showName || !tool.summary" class="line-name">{{ tool.name }}</span>
      <span class="line-text" :class="{ mono: tool.kind !== 'sub_agent' && tool.kind !== 'plain' && tool.kind !== 'unknown' }">{{ tool.summary }}</span>
      <span v-if="tool.meta" class="line-meta">{{ tool.meta }}</span>
      <span v-else-if="tool.status === 'canceled'" class="line-meta">canceled</span>
    </summary>
    <div v-if="detail" class="tool-body">
      <pre v-if="detail.command" class="tool-pre tool-command"><span class="tool-prompt">$</span> {{ detail.command }}</pre>
      <pre v-if="detail.diff.length" class="tool-pre tool-diff"><span v-for="(line, n) in detail.diff" :key="n" :class="line.kind && 'diff-' + line.kind">{{ line.text }}
</span><span v-if="detail.diffMore" class="diff-hunk">… {{ detail.diffMore }} more lines</span></pre>
      <pre v-if="detail.input" class="tool-pre">{{ detail.input }}</pre>
      <pre v-if="detail.output" class="tool-pre tool-output">{{ detail.output }}</pre>
      <pre v-if="detail.error" class="tool-pre tool-error">{{ detail.error }}</pre>
      <p v-if="detail.exitCode !== null && detail.exitCode !== 0 && !detail.error" class="tool-exit">exit {{ detail.exitCode }}</p>
      <p v-if="!detail.command && !detail.diff.length && !detail.input && !detail.output && !detail.error" class="tool-exit">No output</p>
    </div>
  </details>

  <div v-else-if="item.type === 'todo'" class="row row-todo">
    <div class="todo-title"><Icon name="list" :size="14" /> Plan</div>
    <ul>
      <li v-for="(t, i) in todo" :key="t.id ?? i" :class="{ done: t.completed, active: t.status === 'in_progress' }">
        <span class="check" :class="{ done: t.completed }"></span>{{ t.text }}
      </li>
    </ul>
  </div>

  <div v-else-if="item.type === 'error'" class="row row-callout is-error">
    <Icon name="alert" :size="15" /> <span>{{ item.message }}</span>
  </div>

  <div v-else-if="item.type === 'notification'" class="row row-callout" :class="'is-' + item.level">
    <Icon name="alert" :size="15" /> <span>{{ item.message }}</span>
  </div>

  <div v-else-if="item.type === 'compaction'" class="row row-divider">
    <span>{{ item.status === "loading" ? "Compacting context…" : "Context compacted" }}</span>
  </div>

  <PluginRow v-else-if="item.type === 'plugin'" :item="item" :seq-start="row.seqStart" />

  <details v-else class="row row-line row-tool" @toggle="onToggle">
    <summary>
      <span class="line-icon"><Icon name="tool" :size="15" /></span>
      <span class="line-name">{{ label }}</span>
    </summary>
    <div v-if="open" class="tool-body"><pre class="tool-pre">{{ raw }}</pre></div>
  </details>
</template>
