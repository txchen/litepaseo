<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
const props = defineProps<{ provider: string }>();
const kind = computed(() => props.provider.toLowerCase());
</script>

<template>
  <svg v-if="kind === 'codex' || kind === 'openai'" class="icon provider-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" aria-hidden="true">
    <path v-for="angle in [0, 60, 120, 180, 240, 300]" :key="angle" :transform="`rotate(${angle} 12 12)`" d="M12 3.2C14.3 1.8 17.4 3 18.1 5.5L18.1 12.4L12 15.9L8.6 13.9V7.1L14.5 3.7" />
  </svg>
  <svg v-else-if="kind === 'pi'" class="icon provider-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 7c2-2 3-2 5-2h13M8 5v8c0 3-1 5-3 6M16 5v11c0 3 3 3 4 1" />
  </svg>
  <svg v-else-if="kind === 'claude' || kind === 'anthropic'" class="icon provider-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
    <path v-for="angle in [0, 30, 60, 90, 120, 150]" :key="angle" :transform="`rotate(${angle} 12 12)`" d="M12 3v18" />
  </svg>
  <Icon v-else :name="kind === 'gemini' ? 'sparkle' : 'bot'" :size="18" class="provider-icon" />
</template>
