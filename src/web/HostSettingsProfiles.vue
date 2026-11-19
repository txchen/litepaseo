<script setup lang="ts">
import { computed, ref } from "vue";
import type { HostProviderInfo } from "../shared/wire.ts";
import { confirmAction } from "./confirm.ts";
import { newAgentProfile, newMetadataProvider, newTerminalProfile, type Draft, type ProviderRow } from "./host-settings-form.ts";
import Icon from "./Icon.vue";

/**
 * Host settings · the ordered lists: agent profiles, metadata generation and terminal profiles.
 * Edits the draft in place; the model pickers offer what the host reports for each provider.
 */
const props = defineProps<{
  draft: Draft;
  features: Record<string, boolean>;
  providers: HostProviderInfo[];
  rows: ProviderRow[];
}>();

// ---- Model pickers shared by agent profiles and metadata generation ---------------------------
const launchProviders = computed(() =>
  props.rows.filter((r) => !r.removed && r.enabled).map((r) => ({ id: r.id, label: r.label })),
);
const info = (id: string) => props.providers.find((p) => p.id === id);
const modelsFor = (provider: string) => info(provider)?.models ?? [];
const modesFor = (provider: string) => info(provider)?.modes ?? [];
function thinkingFor(provider: string, model: string) {
  const models = modelsFor(provider);
  return (models.find((m) => m.id === model) ?? models.find((m) => m.isDefault) ?? models[0])?.thinking ?? [];
}
const labelOf = (list: { id: string; label: string }[], id: string) => list.find((x) => x.id === id)?.label ?? id;
function changeProvider(p: { model: string; thinkingOptionId: string; modeId?: string }) {
  p.model = p.thinkingOptionId = "";
  if (p.modeId !== undefined) p.modeId = "";
}
function changeModel(p: { provider: string; model: string; thinkingOptionId: string }) {
  if (p.thinkingOptionId && !thinkingFor(p.provider, p.model).some((t) => t.id === p.thinkingOptionId)) p.thinkingOptionId = "";
}

// ---- Lists ------------------------------------------------------------------------------------
const openItems = ref<Record<string, boolean>>({});
function move<T>(list: T[], i: number, by: number) {
  const j = i + by;
  if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j]!, list[i]!];
}
function addAgentProfile() {
  const p = newAgentProfile(launchProviders.value[0]?.id ?? "codex");
  (props.draft.agentProfiles ??= []).push(p);
  openItems.value[p.key] = true;
}
function addTerminalProfile() {
  const p = newTerminalProfile();
  (props.draft.terminalProfiles ??= []).push(p);
  openItems.value[p.key] = true;
}
function addMetadataProvider() {
  (props.draft.metadataProviders ??= []).push(newMetadataProvider(launchProviders.value[0]?.id ?? "codex"));
}
async function removeItem<T extends { name?: string }>(list: T[], i: number, what: string) {
  const item = list[i], name = item?.name?.trim();
  if (name && !(await confirmAction({ title: `Remove ${what} ${name}?`, confirmLabel: "Remove", danger: true }))) return;
  // The list may have changed while the question was open: remove the item asked about.
  const at = list.indexOf(item);
  if (at >= 0) list.splice(at, 1);
}
function profileSummary(p: { provider: string; model: string; modeId: string; thinkingOptionId: string }) {
  const parts = [labelOf(launchProviders.value, p.provider) || "No provider", p.model ? labelOf(modelsFor(p.provider), p.model) : "Default model"];
  if (p.thinkingOptionId) parts.push(labelOf(thinkingFor(p.provider, p.model), p.thinkingOptionId));
  if (p.modeId) parts.push(labelOf(modesFor(p.provider), p.modeId));
  return parts.join(" · ");
}
</script>

<template>
  <!-- Agent profiles ----------------------------------------------------------------->
  <template v-if="features.agentProfiles">
    <div class="hs-head">
      <h2 id="hs-profiles" class="section-label">Agent profiles</h2>
      <button type="button" class="btn btn-outline btn-sm" @click="addAgentProfile"><Icon name="plus" :size="13" />Add agent profile</button>
    </div>
    <p class="subtle hs-hint">Named launch settings, also offered to orchestrating agents.</p>
    <div class="card">
      <p v-if="!draft.agentProfiles?.length" class="card-row subtle">No agent profiles yet.</p>
      <div v-for="(p, i) in draft.agentProfiles ?? []" :key="p.key" class="hs-item" :class="{ 'is-open': openItems[p.key] }">
        <button type="button" class="card-row hs-item-head" :aria-expanded="!!openItems[p.key]" @click="openItems[p.key] = !openItems[p.key]">
          <span class="grow">
            <span class="row-title">{{ p.name.trim() || "Untitled profile" }}</span>
            <span class="row-sub">{{ profileSummary(p) }}</span>
          </span>
          <Icon name="chevron" :size="15" class="hs-chevron" />
        </button>
        <div v-if="openItems[p.key]" class="hs-item-body">
          <div class="hs-grid">
            <label class="field">
              <span>Name</span>
              <input v-model="p.name" :aria-invalid="!p.name.trim()" placeholder="Review" />
            </label>
            <label class="field">
              <span>Provider</span>
              <select v-model="p.provider" aria-label="Provider" @change="changeProvider(p)">
                <option v-if="p.provider && !launchProviders.some((x) => x.id === p.provider)" :value="p.provider">{{ p.provider }} (not enabled)</option>
                <option v-for="x in launchProviders" :key="x.id" :value="x.id">{{ x.label }}</option>
              </select>
            </label>
            <label class="field">
              <span>Model</span>
              <select v-model="p.model" aria-label="Model" @change="changeModel(p)">
                <option value="">Provider default</option>
                <option v-if="p.model && !modelsFor(p.provider).some((m) => m.id === p.model)" :value="p.model">{{ p.model }} (not reported)</option>
                <option v-for="m in modelsFor(p.provider)" :key="m.id" :value="m.id">{{ m.label }}</option>
              </select>
            </label>
            <label class="field">
              <span>Thinking</span>
              <select v-model="p.thinkingOptionId" aria-label="Thinking">
                <option value="">Model default</option>
                <option v-if="p.thinkingOptionId && !thinkingFor(p.provider, p.model).some((t) => t.id === p.thinkingOptionId)" :value="p.thinkingOptionId">
                  {{ p.thinkingOptionId }} (not reported)
                </option>
                <option v-for="t in thinkingFor(p.provider, p.model)" :key="t.id" :value="t.id">{{ t.label }}</option>
              </select>
            </label>
            <label class="field">
              <span>Mode</span>
              <select v-model="p.modeId" aria-label="Mode">
                <option value="">Provider default</option>
                <option v-if="p.modeId && !modesFor(p.provider).some((m) => m.id === p.modeId)" :value="p.modeId">{{ p.modeId }} (not reported)</option>
                <option v-for="m in modesFor(p.provider)" :key="m.id" :value="m.id">{{ m.label }}</option>
              </select>
            </label>
          </div>
          <label class="field">
            <span>When to use</span>
            <textarea v-model="p.notes" rows="4" placeholder="Shown to orchestrating agents choosing a profile"></textarea>
          </label>
          <div class="hs-actions">
            <button type="button" class="btn btn-outline btn-sm" :disabled="i === 0" @click="move(draft.agentProfiles!, i, -1)">Move up</button>
            <button type="button" class="btn btn-outline btn-sm" :disabled="i === draft.agentProfiles!.length - 1" @click="move(draft.agentProfiles!, i, 1)">
              Move down
            </button>
            <button type="button" class="btn btn-outline btn-sm hs-danger" @click="removeItem(draft.agentProfiles!, i, 'agent profile')">
              <Icon name="trash" :size="13" />Remove
            </button>
          </div>
        </div>
      </div>
    </div>
  </template>

  <!-- Metadata generation ------------------------------------------------------------>
  <template v-if="draft.metadataProviders">
    <div class="hs-head">
      <h2 id="hs-metadata" class="section-label">Metadata generation</h2>
      <button type="button" class="btn btn-outline btn-sm" @click="addMetadataProvider"><Icon name="plus" :size="13" />Add provider</button>
    </div>
    <p class="subtle hs-hint">Providers tried in order for branch names, commit messages and pull requests. None: Paseo picks automatically.</p>
    <div class="card">
      <p v-if="!draft.metadataProviders.length" class="card-row subtle">Automatic selection.</p>
      <div v-for="(p, i) in draft.metadataProviders" :key="p.key" class="card-row hs-meta-row">
        <span class="hs-order">{{ i + 1 }}</span>
        <select v-model="p.provider" :aria-label="'Metadata provider ' + (i + 1)" @change="changeProvider(p)">
          <option v-if="p.provider && !launchProviders.some((x) => x.id === p.provider)" :value="p.provider">{{ p.provider }} (not enabled)</option>
          <option v-for="x in launchProviders" :key="x.id" :value="x.id">{{ x.label }}</option>
        </select>
        <select v-model="p.model" :aria-label="'Metadata model ' + (i + 1)" @change="changeModel(p)">
          <option value="">Default model</option>
          <option v-if="p.model && !modelsFor(p.provider).some((m) => m.id === p.model)" :value="p.model">{{ p.model }} (not reported)</option>
          <option v-for="m in modelsFor(p.provider)" :key="m.id" :value="m.id">{{ m.label }}</option>
        </select>
        <select v-model="p.thinkingOptionId" :aria-label="'Metadata thinking ' + (i + 1)">
          <option value="">Default thinking</option>
          <option v-if="p.thinkingOptionId && !thinkingFor(p.provider, p.model).some((t) => t.id === p.thinkingOptionId)" :value="p.thinkingOptionId">
            {{ p.thinkingOptionId }}
          </option>
          <option v-for="t in thinkingFor(p.provider, p.model)" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
        <span class="hs-row-actions">
          <button type="button" class="icon-btn hs-up" :disabled="i === 0" aria-label="Move up" title="Move up" @click="move(draft.metadataProviders, i, -1)">
            <Icon name="chevron" :size="14" />
          </button>
          <button type="button" class="icon-btn" aria-label="Remove" title="Remove" @click="draft.metadataProviders.splice(i, 1)">
            <Icon name="close" :size="14" />
          </button>
        </span>
      </div>
    </div>
  </template>

  <!-- Terminal profiles -------------------------------------------------------------->
  <div class="hs-head">
    <h2 id="hs-terminals" class="section-label">Terminal profiles</h2>
    <button type="button" class="btn btn-outline btn-sm" @click="addTerminalProfile"><Icon name="plus" :size="13" />Add terminal profile</button>
  </div>
  <p class="subtle hs-hint">Commands offered when opening a new terminal on this host.</p>
  <div class="card">
    <p v-if="!draft.terminalProfiles?.length" class="card-row subtle">No terminal profiles yet.</p>
    <div v-for="(p, i) in draft.terminalProfiles ?? []" :key="p.key" class="hs-item" :class="{ 'is-open': openItems[p.key] }">
      <button type="button" class="card-row hs-item-head" :aria-expanded="!!openItems[p.key]" @click="openItems[p.key] = !openItems[p.key]">
        <span class="grow">
          <span class="row-title">{{ p.name.trim() || "Untitled terminal" }}</span>
          <span class="row-sub hs-mono">{{ [p.command, ...p.argsText.split("\n")].filter((x) => x.trim()).join(" ") || "No command" }}</span>
        </span>
        <Icon name="chevron" :size="15" class="hs-chevron" />
      </button>
      <div v-if="openItems[p.key]" class="hs-item-body">
        <div class="hs-grid">
          <label class="field">
            <span>Name</span>
            <input v-model="p.name" :aria-invalid="!p.name.trim()" placeholder="Shell" />
          </label>
          <label class="field">
            <span>Command</span>
            <input v-model="p.command" class="hs-mono" :aria-invalid="!p.command.trim()" placeholder="/bin/bash" spellcheck="false" />
          </label>
        </div>
        <label class="field">
          <span>Arguments <small class="subtle">· one per line</small></span>
          <textarea v-model="p.argsText" rows="2" class="hs-mono" spellcheck="false"></textarea>
        </label>
        <div class="hs-actions">
          <button type="button" class="btn btn-outline btn-sm" :disabled="i === 0" @click="move(draft.terminalProfiles!, i, -1)">Move up</button>
          <button type="button" class="btn btn-outline btn-sm" :disabled="i === draft.terminalProfiles!.length - 1" @click="move(draft.terminalProfiles!, i, 1)">
            Move down
          </button>
          <button type="button" class="btn btn-outline btn-sm hs-danger" @click="removeItem(draft.terminalProfiles!, i, 'terminal profile')">
            <Icon name="trash" :size="13" />Remove
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
