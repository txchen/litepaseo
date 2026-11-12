<script setup lang="ts">
import { computed } from "vue";
import { highlight, languageFor } from "./highlight.ts";

/** Markstream's fenced-code node, rendered as a plain <pre> with highlight.js token spans. */
// Markstream passes renderer options (loading, isDark, …) as extra attributes; keep them off the DOM.
defineOptions({ inheritAttrs: false });
const props = defineProps<{ node: { language?: string; code?: string; raw?: string; diff?: boolean } }>();
const language = computed(() => languageFor(props.node.diff ? "diff" : String(props.node.language ?? "")));
const code = computed(() => String(props.node.code ?? "").replace(/\n$/, ""));
const html = computed(() => highlight(code.value, language.value));
</script>

<template>
  <pre class="code" :data-language="language ?? undefined"><code v-if="html !== null" class="hljs" v-html="html"></code><code v-else>{{ code }}</code></pre>
</template>
