<script setup lang="ts">
import { computed } from "vue";
import type { Draft } from "./host-settings-form.ts";

/** Host settings · General: behaviour toggles and the prompts added to every agent. Edits the draft in place. */
const props = defineProps<{ draft: Draft; features: Record<string, boolean> }>();

/** [key, title, description, feature gate]: gated settings show only on hosts that support them. */
const flags: [string, string, string, string][] = [
  ["idleRuntimeCleanup", "Release idle agents", "Free memory held by idle agents that can be resumed later.", "idleRuntimeCleanupSetting"],
  ["resumeOnStartup", "Resume agents after restart", "Continue interrupted agents when the daemon starts.", "resumeOnStartupSetting"],
  ["autoArchiveAfterMerge", "Archive merged workspaces", "Archive a workspace once its changes are merged.", ""],
  ["enableTerminalAgentHooks", "Terminal agent hooks", "Track supported agents launched from terminals.", ""],
  ["pluginsEnabled", "Host plugins", "Run the plugins configured on this host.", "plugins"],
];
const shownFlags = computed(() => {
  const v = props.draft.values ?? {};
  return flags.filter(([key, , , gate]) => (gate ? props.features[gate] : key in v));
});
</script>

<template>
  <h2 id="hs-general" class="section-label">General</h2>
  <div class="card">
    <label v-for="[key, title, hint] in shownFlags" :key="key" class="card-row switch-row">
      <div class="grow">
        <div class="row-title">{{ title }}</div>
        <div class="row-sub">{{ hint }}</div>
      </div>
      <input v-model="draft.values[key]" type="checkbox" class="switch" :aria-label="title" />
    </label>
    <label v-if="draft.values.mcp" class="card-row switch-row">
      <div class="grow">
        <div class="row-title">Paseo orchestration tools</div>
        <div class="row-sub">Give agents Paseo's tools for starting and managing other agents.</div>
      </div>
      <input v-model="draft.values.mcp.injectIntoAgents" type="checkbox" class="switch" aria-label="Paseo orchestration tools" />
    </label>
    <label v-if="draft.values.browserTools" class="card-row switch-row">
      <div class="grow">
        <div class="row-title">Browser tools</div>
        <div class="row-sub">Let agents automate a browser on this host.</div>
      </div>
      <input v-model="draft.values.browserTools.enabled" type="checkbox" class="switch" aria-label="Browser tools" />
    </label>
    <label v-if="draft.values.usage" class="card-row switch-row">
      <div class="grow">
        <div class="row-title">Provider usage</div>
        <div class="row-sub">Collect usage limits from providers for the usage panel.</div>
      </div>
      <input v-model="draft.values.usage.enabled" type="checkbox" class="switch" aria-label="Provider usage" />
    </label>
  </div>
  <div class="card form-card">
    <label class="field">
      <span>Additional system instructions</span>
      <textarea v-model="draft.values.appendSystemPrompt" rows="4" placeholder="Appended to every agent's instructions on this host"></textarea>
    </label>
    <label v-if="features.resumeOnStartupSetting" class="field">
      <span>Restart recovery prompt</span>
      <textarea v-model="draft.values.resumePrompt" rows="2" placeholder="Sent to agents resumed after a restart"></textarea>
    </label>
  </div>
</template>
