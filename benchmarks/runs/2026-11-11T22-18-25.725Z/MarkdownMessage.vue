<script setup lang="ts">
import MarkdownRender, { disableKatex, disableMermaid, disableD2, disableInfographic } from "markstream-vue";

defineProps<{ content: string; final: boolean }>();
// Keep optional editor/diagram runtimes out of chat. The server owns pacing;
// mount synchronously so history scroll anchors see the complete layout.
disableKatex();
disableMermaid();
disableD2();
disableInfographic();
const codeBlockProps = Object.freeze({ showLineNumbers: false, showHeader: false, showCopyButton: false });
</script>

<template>
  <MarkdownRender class="prose" mode="chat" :content="content" :final="final"
    :smooth-streaming="false" :typewriter="false" :fade="false"
    :code-block-stream="false" :render-code-blocks-as-pre="true" :code-block-props="codeBlockProps"
    :batch-rendering="false" :defer-nodes-until-visible="false" :node-virtual="false"
    :viewport-priority="false" html-policy="escape" />
</template>
