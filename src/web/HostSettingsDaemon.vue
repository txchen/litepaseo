<script setup lang="ts">
import { ref } from "vue";
import type { Api } from "./use-api.ts";

/** Host settings · Daemon: its version and status, restart and self-update (run by the page). */
const props = defineProps<{
  api: Api;
  /** The host's `/api` path. */
  base: string;
  version: string;
  desktopManaged: boolean;
  features: Record<string, boolean>;
  /** Unsaved edits block restarting. */
  dirty: boolean;
  locked: boolean;
  restarting: boolean;
  lifecycleJob: any;
}>();
/** The last lifecycle or status failure. */
const error = defineModel<string>("error", { required: true });
const emit = defineEmits<{ lifecycle: [action: "restart" | "update"] }>();
const message = (e: unknown) => (e as Error).message || "Request failed";

const status = ref("");
const statusBusy = ref(false);
async function showStatus() {
  if (status.value) {
    status.value = "";
    return;
  }
  statusBusy.value = true;
  try {
    status.value = JSON.stringify(await props.api(props.base + "/status"), null, 2);
  } catch (e) {
    error.value = message(e);
  } finally {
    statusBusy.value = false;
  }
}
</script>

<template>
  <h2 id="hs-daemon" class="section-label">Daemon</h2>
  <div class="card">
    <div class="card-row hs-daemon">
      <div class="grow">
        <div class="row-title">Paseo {{ version || "version unknown" }}</div>
        <div class="row-sub">
          <template v-if="desktopManaged">Managed by Paseo Desktop. Update it through Desktop.</template>
          <template v-else-if="!features.daemonSelfUpdate">This installation cannot update itself remotely.</template>
          <template v-else-if="dirty">Save or discard your changes before restarting.</template>
          <template v-else>Restarting interrupts running agents briefly.</template>
        </div>
      </div>
      <div class="hs-row-actions">
        <button v-if="features.daemonStatusRpc" type="button" class="btn btn-outline btn-sm" :disabled="statusBusy" @click="showStatus">
          {{ status ? "Hide status" : "Status" }}
        </button>
        <button v-if="features.daemonStatusRpc" type="button" class="btn btn-outline btn-sm" :disabled="dirty || locked" @click="emit('lifecycle', 'restart')">
          Restart…
        </button>
        <button
          v-if="features.daemonStatusRpc && features.daemonSelfUpdate && !desktopManaged"
          type="button"
          class="btn btn-outline btn-sm"
          :disabled="dirty || locked"
          @click="emit('lifecycle', 'update')"
        >
          Update & restart…
        </button>
      </div>
    </div>
  </div>
  <p
    v-if="lifecycleJob && !restarting"
    role="status"
    class="setting-note"
    :class="{ 'is-error': lifecycleJob.state === 'failed' }"
  >
    {{ lifecycleJob.phase }}<span v-if="lifecycleJob.version"> · {{ lifecycleJob.version }}</span><span v-if="lifecycleJob.error">: {{ lifecycleJob.error }}</span>
  </p>
  <p v-if="error" class="setting-note is-error" role="alert">{{ error }}</p>
  <pre v-if="status" class="hs-output">{{ status }}</pre>
</template>
