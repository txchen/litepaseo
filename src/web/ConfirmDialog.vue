<script setup lang="ts">
import { ref } from "vue";
import type { ConfirmRequest } from "./confirm.ts";
import { useDialog } from "./use-dialog.ts";

/** The one confirmation dialog, driven by confirmAction(); App mounts it per request. */
const props = defineProps<{ request: ConfirmRequest }>();
const sheet = ref<HTMLElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
const okButton = ref<HTMLButtonElement | null>(null);
useDialog(sheet, () => props.request.answer(false), {
  initialFocus: () => (props.request.danger ? cancelButton.value : okButton.value),
});
</script>

<template>
  <div class="overlay confirm-overlay" @mousedown.self="request.answer(false)">
    <form
      ref="sheet"
      class="sheet sheet-small"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      :aria-describedby="request.message ? 'confirm-message' : undefined"
      tabindex="-1"
      @submit.prevent="request.answer(true)"
    >
      <header class="sheet-head">
        <h2 id="confirm-title">{{ request.title }}</h2>
      </header>
      <div v-if="request.message" class="sheet-body">
        <p id="confirm-message" class="confirm-message">{{ request.message }}</p>
      </div>
      <footer class="sheet-foot">
        <button ref="cancelButton" type="button" class="btn btn-ghost" @click="request.answer(false)">{{ request.cancelLabel ?? "Cancel" }}</button>
        <button ref="okButton" class="btn" :class="request.danger ? 'btn-danger' : 'btn-primary'">{{ request.confirmLabel ?? "OK" }}</button>
      </footer>
    </form>
  </div>
</template>
