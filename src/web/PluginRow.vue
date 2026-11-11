<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { SUGGESTIONS, type SuggestionContext } from "./suggestions.ts";

// Renders timeline rows that daemon-side plugins append (type "plugin").
const props = defineProps<{ item: Record<string, any>; seqStart: number }>();
const context = inject<SuggestionContext | null>(SUGGESTIONS, null);
const plugin = computed(() => `${props.item.pluginId}/${props.item.kind}`);
const data = computed(() => (props.item.data ?? {}) as Record<string, any>);

// ---- turn-speed ------------------------------------------------------------------------------
const speed = computed(() => {
  const d = data.value;
  if (plugin.value !== "turn-speed/turn-speed" || typeof d.tokensPerSecond !== "number") return null;
  const tokens = d.outputTokens >= 1000 ? `${(d.outputTokens / 1000).toFixed(1)}k` : String(d.outputTokens);
  const seconds = d.generationMs >= 60_000 ? `${Math.floor(d.generationMs / 60_000)}m ${Math.round((d.generationMs % 60_000) / 1000)}s` : `${(d.generationMs / 1000).toFixed(1)}s`;
  return `${d.tokensPerSecond.toFixed(1)} tok/s · ${tokens} tokens · ${seconds} · ${d.requests} ${d.requests === 1 ? "request" : "requests"}`;
});

// ---- next-input ------------------------------------------------------------------------------
const isSuggestion = computed(() => plugin.value === "next-input/next-input" && typeof data.value.token === "string");
const status = ref<"idle" | "loading" | "ready" | "hidden" | "error">("idle");
const text = ref("");
/**
 * Mirrors the plugin's own caution: a suggestion that mentions commands, paths, links,
 * credentials or destructive/publishing actions can be used (edited) but not sent in one tap.
 */
const risky = computed(() =>
  /[`$|<>]|(^|\s)[.~]?\/[\w.-]|https?:|www\.|\b(rm|sudo|delete|drop|remove|reset|force|push|deploy|publish|release|merge|token|password|passwd|secret|credential|api[ _-]?key|ssh)\b|删除|推送|部署|发布|密码|密钥|令牌/i.test(
    text.value,
  ),
);
async function predict() {
  if (!context || !isSuggestion.value) return;
  if (data.value.status === "ready" && data.value.text) {
    status.value = "ready";
    text.value = data.value.text;
  } else {
    status.value = "loading";
    try {
      const result = await context.predict(data.value.token);
      if (result.status === "ready" && result.text) {
        status.value = "ready";
        text.value = result.text;
      } else status.value = result.status === "error" ? "error" : "hidden";
    } catch {
      status.value = "error";
    }
  }
  if (status.value === "ready") context.offer(props.seqStart, text.value);
}
onMounted(() => void predict());
watch(() => data.value.token, () => void predict());

const open = ref(false);
const details = computed(() => (open.value ? JSON.stringify(props.item.data ?? props.item, null, 2) : ""));
</script>

<template>
  <div v-if="speed" class="row row-plugin row-speed" title="Turn speed (turn-speed plugin)">
    <Icon name="bolt" :size="12" /><span>{{ speed }}</span>
  </div>

  <div v-else-if="isSuggestion" class="row row-suggestion" :class="'is-' + status">
    <template v-if="status === 'loading'">
      <span class="spinner spinner-sm"></span><span class="suggestion-wait">Thinking of a next message…</span>
    </template>
    <template v-else-if="status === 'ready'">
      <button class="suggestion-text" title="Put in the message box to edit" @click="context?.use(text)">{{ text }}</button>
      <span class="suggestion-actions">
        <button class="icon-btn" title="Edit in the message box" aria-label="Edit suggestion" @click="context?.use(text)">
          <Icon name="edit" :size="14" />
        </button>
        <button
          v-if="!risky"
          class="icon-btn"
          title="Send this message"
          aria-label="Send suggestion"
          @click="context?.send(text)"
        >
          <Icon name="send" :size="14" />
        </button>
      </span>
    </template>
    <span v-else-if="status === 'error'" class="suggestion-wait">Suggestion unavailable</span>
  </div>

  <details v-else class="row row-tool row-plugin" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary>
      <span class="tool-icon"><Icon name="sparkle" :size="13" /></span>
      <span class="tool-name">{{ item.pluginId }}</span>
      <span class="tool-subject">{{ item.kind }}</span>
    </summary>
    <pre v-if="open" class="tool-detail">{{ details }}</pre>
  </details>
</template>
