<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import type { WorkspaceSummary } from "../shared/wire.ts";
import Icon from "./Icon.vue";

const props = defineProps<{ thread: WorkspaceSummary; busy: boolean }>();
/** null resets to the name Paseo derives from the branch or directory. */
const emit = defineEmits<{ close: []; save: [title: string | null] }>();
const value = ref(props.thread.title ?? props.thread.name);
const input = ref<HTMLInputElement | null>(null);
onMounted(() =>
  nextTick(() => {
    input.value?.focus();
    input.value?.select();
  }),
);
function save() {
  const title = value.value.trim();
  emit("save", title ? title : null);
}
</script>

<template>
  <div class="overlay" @mousedown.self="!busy && emit('close')" @keydown.esc="emit('close')">
    <form class="sheet sheet-small" role="dialog" aria-modal="true" aria-label="Rename thread" @submit.prevent="save">
      <header class="sheet-head">
        <h2>Rename thread</h2>
        <button type="button" class="icon-btn" aria-label="Close" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="sheet-body">
        <label class="field">
          <span>Name</span>
          <input ref="input" v-model="value" maxlength="200" :placeholder="thread.name" />
        </label>
        <p class="row-sub">{{ thread.project }}{{ thread.branch ? " · " + thread.branch : "" }}</p>
      </div>
      <footer class="sheet-foot">
        <button v-if="thread.title" type="button" class="btn btn-ghost sheet-reset" :disabled="busy" @click="emit('save', null)">
          Reset to default
        </button>
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="busy || !value.trim()">Save</button>
      </footer>
    </form>
  </div>
</template>
