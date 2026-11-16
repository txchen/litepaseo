<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import Icon from "./Icon.vue";
defineProps<{ src: string }>();
const emit = defineEmits<{ close: [] }>();
const viewport = ref<HTMLDivElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const previousFocus = document.activeElement;
onMounted(() => viewport.value?.focus({ preventScroll: true }));
onUnmounted(() => {
  if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
});
</script>

<template>
  <div ref="viewport" class="lightbox" role="dialog" aria-modal="true" aria-label="Image" tabindex="0"
    @click.self="emit('close')" @keydown.stop @keydown.esc.stop="emit('close')" @keydown.tab.prevent="closeButton?.focus()">
    <button ref="closeButton" class="lightbox-close" aria-label="Close image" @click="emit('close')"><Icon name="close" :size="22" /></button>
    <img :src="src" alt="Image preview" />
  </div>
</template>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 60;
  overflow: auto;
  overscroll-behavior: contain;
  padding: calc(64px + env(safe-area-inset-top, 0px)) 24px calc(24px + env(safe-area-inset-bottom, 0px));
  background: rgba(0, 0, 0, 0.88);
}
.lightbox img {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: none;
  margin: 0 auto;
  border-radius: 8px;
  box-shadow: var(--shadow-lg);
}
.lightbox-close {
  position: fixed;
  top: calc(12px + env(safe-area-inset-top, 0px));
  right: calc(16px + env(safe-area-inset-right, 0px));
  z-index: 1;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 1px solid #666;
  border-radius: 50%;
  color: #fff;
  background: #222;
  cursor: pointer;
}
.lightbox-close:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
@media (max-width: 700px) { .lightbox { padding-left: 12px; padding-right: 12px; } }
</style>
