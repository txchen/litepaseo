<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import type { AgentSummary } from "../shared/wire.ts";
import Icon from "./Icon.vue";
import { useDialog } from "./use-dialog.ts";

const props = defineProps<{ agent: AgentSummary; busy: boolean }>();
const emit = defineEmits<{ close: []; save: [title: string] }>();
const value = ref(props.agent.title ?? "");
const input = ref<HTMLInputElement | null>(null);
const sheet = ref<HTMLElement | null>(null);
useDialog(sheet, () => emit("close"));
onMounted(() =>
  nextTick(() => {
    input.value?.focus();
    input.value?.select();
  }),
);
function save() {
  const title = value.value.trim();
  if (!title) return;
  emit("save", title);
}
</script>

<template>
  <div class="overlay" @mousedown.self="!busy && emit('close')">
    <form ref="sheet" class="sheet sheet-small" role="dialog" aria-modal="true" aria-label="Rename session" tabindex="-1" @submit.prevent="save">
      <header class="sheet-head">
        <h2>Rename session</h2>
        <button type="button" class="icon-btn" aria-label="Close" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="sheet-body">
        <label class="field">
          <span>Name</span>
          <input ref="input" v-model="value" maxlength="200" :placeholder="agent.title || agent.provider" />
        </label>
        <p class="row-sub">{{ agent.project }} · {{ agent.provider }}</p>
      </div>
      <footer class="sheet-foot">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="busy || !value.trim()">Save</button>
      </footer>
    </form>
  </div>
</template>
