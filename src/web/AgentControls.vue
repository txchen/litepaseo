<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AgentConfigChange, AgentConfigOptions, AgentSummary } from "../shared/wire.ts";
import Icon from "./Icon.vue";

/**
 * The composer's agent switches, as in Paseo: model, thinking level, mode and provider features,
 * plus the context window gauge. Options load once per agent (cached briefly); the current
 * values arrive with the live directory, so nothing polls.
 */
const props = defineProps<{
  agent: AgentSummary;
  /** "/hosts/<host>/agents/<agent>" */
  path: string;
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  disabled: boolean;
}>();
const emit = defineEmits<{ notice: [text: string] }>();

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; options: AgentConfigOptions }>();
const options = ref<AgentConfigOptions | null>(null);
const pending = ref<Partial<Record<"model" | "thinking" | "mode" | string, string | boolean>>>({});

async function load(force = false) {
  const key = props.agent.key;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) {
    options.value = hit.options;
    return;
  }
  try {
    const result = (await props.api(props.path + "/config")) as AgentConfigOptions;
    cache.set(key, { at: Date.now(), options: result });
    if (props.agent.key === key) options.value = result;
  } catch {
    if (props.agent.key === key) options.value = hit?.options ?? null;
  }
}
watch(() => props.agent.key, () => {
  options.value = cache.get(props.agent.key)?.options ?? null;
  pending.value = {};
  void load();
}, { immediate: true });

const model = computed(() => (pending.value.model as string | undefined) ?? props.agent.model ?? null);
const modelOption = computed(() => options.value?.models.find((m) => m.id === model.value) ?? null);
/** "anthropic/claude-opus-5-5" → "claude-opus-5-5" until the provider's label is known. */
const modelLabel = computed(() => modelOption.value?.label ?? (model.value ? model.value.split("/").pop()! : "Model"));
const thinking = computed(() => (pending.value.thinking as string | undefined) ?? props.agent.thinking ?? modelOption.value?.defaultThinkingId ?? null);
const thinkingOptions = computed(() => modelOption.value?.thinking ?? []);
const thinkingLabel = computed(() => thinkingOptions.value.find((t) => t.id === thinking.value)?.label ?? thinking.value ?? "");
const mode = computed(() => (pending.value.mode as string | undefined) ?? props.agent.modeId ?? null);
const modes = computed(() => options.value?.modes ?? []);
const modeLabel = computed(() => modes.value.find((m) => m.id === mode.value)?.label ?? "Mode");
const features = computed(() =>
  (options.value?.features ?? []).map((f) => {
    const value = pending.value["feature:" + f.id] ?? f.value;
    return f.type === "toggle"
      ? { ...f, value: value as boolean }
      : { ...f, value: value as string | null, current: f.options.find((o) => o.id === value)?.label ?? "" };
  }),
);

// The directory catches up after a change: drop the optimistic value once it matches.
watch(() => [props.agent.model, props.agent.thinking, props.agent.modeId], () => {
  const next = { ...pending.value };
  if (next.model === props.agent.model) delete next.model;
  if (next.thinking === props.agent.thinking) delete next.thinking;
  if (next.mode === props.agent.modeId) delete next.mode;
  pending.value = next;
});

async function change(slot: string, body: AgentConfigChange, value: string | boolean) {
  const previous = pending.value[slot];
  pending.value = { ...pending.value, [slot]: value };
  try {
    const result = await props.api(props.path + "/config", "POST", body);
    const notice = result?.notice as { message?: string } | null;
    if (notice?.message) emit("notice", notice.message);
    if (slot.startsWith("feature:")) {
      cache.delete(props.agent.key);
      await load(true);
      const next = { ...pending.value };
      delete next[slot];
      pending.value = next;
    }
  } catch (e) {
    pending.value = { ...pending.value, [slot]: previous as string };
    if (previous === undefined) {
      const next = { ...pending.value };
      delete next[slot];
      pending.value = next;
    }
    emit("notice", (e as Error).message);
  }
}
const pick = (event: Event) => (event.target as HTMLSelectElement).value;

// Context window gauge.
const context = computed(() => {
  const used = props.agent.contextUsed ?? 0,
    max = props.agent.contextMax ?? 0;
  if (!used || !max) return null;
  const ratio = Math.min(1, used / max);
  const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);
  return { ratio, percent: Math.round(ratio * 100), title: `Context window: ${k(used)} of ${k(max)} tokens used` };
});
const RING = 2 * Math.PI * 7;
</script>

<template>
  <div class="agent-controls">
    <label class="chip" :class="{ 'is-disabled': disabled || !options?.models.length }" :title="'Model: ' + modelLabel">
      <Icon name="sparkle" :size="13" /><span class="chip-text">{{ modelLabel }}</span><Icon name="chevron" :size="11" class="chip-caret" />
      <select
        aria-label="Model"
        :disabled="disabled || !options?.models.length"
        :value="model ?? ''"
        @change="change('model', { model: pick($event) }, pick($event))"
      >
        <option v-if="model && !modelOption" :value="model">{{ modelLabel }}</option>
        <option v-for="m in options?.models ?? []" :key="m.id" :value="m.id">{{ m.label }}</option>
      </select>
    </label>
    <label v-if="thinkingOptions.length" class="chip" :class="{ 'is-disabled': disabled }" :title="'Thinking: ' + thinkingLabel">
      <Icon name="brain" :size="13" /><span class="chip-text">{{ thinkingLabel }}</span><Icon name="chevron" :size="11" class="chip-caret" />
      <select
        aria-label="Thinking"
        :disabled="disabled"
        :value="thinking ?? ''"
        @change="change('thinking', { thinkingOptionId: pick($event) }, pick($event))"
      >
        <option v-for="t in thinkingOptions" :key="t.id" :value="t.id">{{ t.label }}</option>
      </select>
    </label>
    <label v-if="modes.length" class="chip" :class="{ 'is-disabled': disabled }" :title="'Mode: ' + modeLabel">
      <Icon name="shield" :size="13" /><span class="chip-text">{{ modeLabel }}</span><Icon name="chevron" :size="11" class="chip-caret" />
      <select aria-label="Mode" :disabled="disabled" :value="mode ?? ''" @change="change('mode', { modeId: pick($event) }, pick($event))">
        <option v-if="!mode" value="" disabled>Mode</option>
        <option v-for="m in modes" :key="m.id" :value="m.id" :title="m.description">{{ m.label }}</option>
      </select>
    </label>
    <template v-for="f in features" :key="f.id">
      <button
        v-if="f.type === 'toggle'"
        type="button"
        class="chip chip-toggle"
        :class="{ chosen: f.value }"
        :aria-pressed="f.value"
        :title="f.tooltip ?? f.label"
        :disabled="disabled"
        @click="change('feature:' + f.id, { feature: { id: f.id, value: !f.value } }, !f.value)"
      >
        <Icon name="bolt" :size="13" /><span class="chip-text">{{ f.label }}</span>
      </button>
      <label v-else class="chip" :class="{ 'is-disabled': disabled }" :title="f.tooltip ?? f.label">
        <span class="chip-text"><span class="chip-key">{{ f.label }}:</span> {{ f.current || "Default" }}</span><Icon name="chevron" :size="11" class="chip-caret" />
        <select
          :aria-label="f.label"
          :disabled="disabled"
          :value="f.value ?? ''"
          @change="change('feature:' + f.id, { feature: { id: f.id, value: pick($event) } }, pick($event))"
        >
          <option v-for="o in f.options" :key="o.id" :value="o.id">{{ o.label }}</option>
        </select>
      </label>
    </template>
    <span v-if="context" class="context-gauge" :class="{ 'is-high': context.ratio >= 0.8 }" :title="context.title" role="img" :aria-label="context.title">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r="7" class="context-track" />
        <circle cx="9" cy="9" r="7" class="context-fill" :stroke-dasharray="`${RING * context.ratio} ${RING}`" transform="rotate(-90 9 9)" />
      </svg>
      <span>{{ context.percent }}%</span>
    </span>
  </div>
</template>

<style scoped>
.agent-controls {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.agent-controls::-webkit-scrollbar {
  display: none;
}
.chip {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  max-width: 220px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg-muted);
  cursor: pointer;
  white-space: nowrap;
}
.chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip-key {
  font-weight: 400;
}
.chip-caret {
  flex: none;
  transform: rotate(90deg);
  opacity: 0.7;
}
@media (hover: hover) {
  .chip:hover:not(.is-disabled) {
    background: var(--hover);
    color: var(--fg);
  }
}
.chip.is-disabled {
  cursor: default;
  opacity: 0.6;
}
.chip-toggle.chosen {
  color: var(--accent);
  background: var(--accent-soft);
}
/* The real <select> covers the chip: native pickers on phones, keyboard support everywhere. */
.chip select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: inherit;
  font-size: 16px;
}
.context-gauge {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 8px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--fg-muted);
}
.context-track {
  fill: none;
  stroke: var(--surface-3);
  stroke-width: 2.5;
}
.context-fill {
  fill: none;
  stroke: var(--fg-muted);
  stroke-width: 2.5;
  stroke-linecap: round;
}
.context-gauge.is-high {
  color: var(--warn);
}
.context-gauge.is-high .context-fill {
  stroke: var(--warn);
}
</style>
