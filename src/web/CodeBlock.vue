<script setup lang="ts">
import { computed, inject, type ComputedRef } from "vue";
import { highlight, languageFor } from "./highlight.ts";

/** Markstream's fenced-code node, rendered as a plain <pre> with highlight.js token spans. */
// Markstream passes renderer options (loading, isDark, …) as extra attributes; keep them off the DOM.
defineOptions({ inheritAttrs: false });
const props = defineProps<{ node: { language?: string; code?: string; raw?: string; diff?: boolean; loading?: boolean } }>();
const markdownFinal = inject<ComputedRef<boolean> | null>("litepaseo-markdown-final", null);
const language = computed(() => languageFor(props.node.diff ? "diff" : String(props.node.language ?? "")));
const code = computed(() => String(props.node.code ?? "").replace(/\n$/, ""));
// Skip synchronous highlight.js tokenization while a fence is still streaming; highlight once closed or settled.
const html = computed(() => {
  if (props.node.loading && !markdownFinal?.value) return null;
  return highlight(code.value, language.value);
});
</script>

<template>
  <pre class="code" :data-language="language ?? undefined"><code v-if="html !== null" class="hljs" v-html="html"></code><code v-else>{{ code }}</code></pre>
</template>
