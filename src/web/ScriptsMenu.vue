<script setup lang="ts">
import { ref, watch } from "vue";
import type { WorkspaceScriptInfo } from "../shared/wire.ts";
import Icon from "./Icon.vue";

const props = defineProps<{
  hostId: string;
  workspaceId: string;
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}>();

const open = ref(false);
const scripts = ref<WorkspaceScriptInfo[]>([]);
const loading = ref(false);
const busy = ref<string | null>(null);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await props.api(`/hosts/${encodeURIComponent(props.hostId)}/workspaces/${encodeURIComponent(props.workspaceId)}/scripts`);
    scripts.value = Array.isArray(res.scripts) ? res.scripts : [];
  } catch (e) {
    error.value = (e as Error).message || "Could not load scripts.";
  } finally {
    loading.value = false;
  }
}

function toggle() {
  open.value = !open.value;
  if (open.value) void load();
}

const isRunning = (s: WorkspaceScriptInfo) => s.lifecycle === "running" || s.lifecycle === "starting";

async function runAction(s: WorkspaceScriptInfo, action: "start" | "stop") {
  busy.value = s.scriptName;
  error.value = "";
  try {
    const res = await props.api(
      `/hosts/${encodeURIComponent(props.hostId)}/workspaces/${encodeURIComponent(props.workspaceId)}/scripts/${encodeURIComponent(s.scriptName)}/${action}`,
      "POST",
      {},
    );
    if (Array.isArray(res.scripts)) scripts.value = res.scripts;
    else await load();
  } catch (e) {
    error.value = (e as Error).message || `Could not ${action} script.`;
  } finally {
    busy.value = null;
  }
}

watch(() => [props.hostId, props.workspaceId], () => {
  open.value = false;
  scripts.value = [];
});
</script>

<template>
  <div class="scripts-wrap">
    <button
      type="button"
      class="icon-btn head-tool"
      :class="{ chosen: open }"
      :aria-expanded="open"
      aria-label="Workspace scripts"
      title="Workspace scripts & services"
      @click="toggle"
    >
      <Icon name="play" :size="15" />
    </button>
    <div v-if="open" class="scripts-popover" role="dialog" aria-label="Workspace scripts">
      <header class="scripts-head">
        <strong>Scripts</strong>
        <button type="button" class="icon-btn" :disabled="loading" title="Refresh" aria-label="Refresh scripts" @click="load">
          <span v-if="loading" class="spinner spinner-sm"></span><Icon v-else name="refresh" :size="13" />
        </button>
        <button type="button" class="icon-btn" aria-label="Close" @click="open = false"><Icon name="close" :size="13" /></button>
      </header>
      <p v-if="error" class="setting-note is-error" role="alert">{{ error }}</p>
      <p v-else-if="loading && !scripts.length" class="row-sub">Loading scripts…</p>
      <p v-else-if="!scripts.length" class="row-sub">No scripts configured in paseo.json for this project.</p>
      <div v-for="s in scripts" :key="s.scriptName" class="script-row">
        <span class="status-dot" :class="isRunning(s) ? 'is-running' : s.lifecycle === 'failed' ? 'is-error' : 'is-idle'"></span>
        <div class="grow">
          <div class="row-title">{{ s.scriptName }} <small v-if="s.port" class="hs-tag">:{{ s.port }}</small></div>
          <div class="row-sub">{{ s.type }} · {{ s.lifecycle }}<template v-if="s.health"> · {{ s.health }}</template></div>
        </div>
        <a v-if="s.proxyUrl && isRunning(s)" :href="s.proxyUrl" target="_blank" rel="noopener noreferrer" class="icon-btn" title="Open service URL" aria-label="Open service URL">
          <Icon name="external" :size="13" />
        </a>
        <button
          v-if="isRunning(s)"
          type="button"
          class="btn btn-sm btn-outline"
          :disabled="busy === s.scriptName"
          @click="runAction(s, 'stop')"
        >
          <Icon name="stop" :size="11" />Stop
        </button>
        <button
          v-else
          type="button"
          class="btn btn-sm btn-primary"
          :disabled="busy === s.scriptName"
          @click="runAction(s, 'start')"
        >
          <Icon name="play" :size="11" />Run
        </button>
      </div>
    </div>
  </div>
</template>
