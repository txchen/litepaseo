<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import type { PromptMarker } from "../shared/wire.ts";

/**
 * Paseo's chat outline: one tick per user prompt along the left edge. Resting on the rail for a
 * moment shows the prompt under the pointer; after that, moving along the rail updates the
 * preview at once. Ticks near the pointer widen. Clicking a tick jumps to that prompt.
 */
const props = defineProps<{ prompts: PromptMarker[]; activeSeq: number | null }>();
const emit = defineEmits<{ jump: [seq: number] }>();
const HOVER_DELAY_MS = 150;
const MAGNIFY_RADIUS = 3;

const pointed = ref<number | null>(null);
const previewing = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
function point(index: number) {
  pointed.value = index;
  if (previewing.value || timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    previewing.value = true;
  }, HOVER_DELAY_MS);
}
function leave() {
  clearTimeout(timer);
  timer = undefined;
  pointed.value = null;
  previewing.value = false;
}
onBeforeUnmount(leave);
function magnification(index: number) {
  if (pointed.value === null) return 0;
  const d = Math.abs(index - pointed.value);
  return d >= MAGNIFY_RADIUS ? 0 : (1 + Math.cos((Math.PI * d) / MAGNIFY_RADIUS)) / 2;
}
const MAX_TICKS = 300;
const visiblePrompts = computed(() => {
  const list = props.prompts;
  if (list.length <= MAX_TICKS) return list;
  const picked = new Set<number>([0, list.length - 1]);
  const seq = props.activeSeq;
  if (seq !== null) {
    let activeIdx = -1;
    for (let i = 0; i < list.length && list[i].seq <= seq; i++) activeIdx = i;
    if (activeIdx >= 0) picked.add(activeIdx);
  }
  const step = (list.length - 1) / (MAX_TICKS - 1);
  for (let i = 1; i < MAX_TICKS - 1; i++) picked.add(Math.round(i * step));
  return [...picked].sort((a, b) => a - b).map((i) => list[i]!);
});
const activeIndex = computed(() => {
  const seq = props.activeSeq;
  if (seq === null) return -1;
  let found = -1;
  for (let i = 0; i < visiblePrompts.value.length && visiblePrompts.value[i].seq <= seq; i++) found = i;
  return found;
});
function tickStyle(index: number) {
  const base = index === activeIndex.value ? 18 : 10;
  const m = magnification(index);
  return { width: `${base + m * (26 - base)}px`, height: `${2 + 2 * m}px` };
}
function jump(index: number) {
  emit("jump", visiblePrompts.value[index].seq);
}
</script>

<template>
  <nav class="outline-rail" aria-label="Prompts in this conversation" @pointerleave="leave">
    <div
      v-for="(p, i) in visiblePrompts"
      :key="p.seq"
      class="outline-slot"
      @pointerenter="point(i)"
    >
      <button
        type="button"
        class="outline-target"
        :aria-label="`${i + 1} of ${visiblePrompts.length}: ${p.preview}`"
        :aria-current="i === activeIndex ? 'location' : undefined"
        @click="jump(i)"
      >
        <span class="outline-tick" :class="{ 'is-active': i === activeIndex, 'is-pointed': previewing && i === pointed }" :style="tickStyle(i)"></span>
      </button>
      <div v-if="previewing && i === pointed" class="outline-preview" aria-hidden="true">{{ p.preview || "(no text)" }}</div>
    </div>
  </nav>
</template>
