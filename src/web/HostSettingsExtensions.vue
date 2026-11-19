<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { confirmAction } from "./confirm.ts";
import { canonical } from "./host-settings-form.ts";
import Icon from "./Icon.vue";
import type { Api } from "./use-api.ts";

/**
 * Host settings · Paseo skills and host plugins. Unlike the rest of the page these apply at once,
 * separately from Save. Both are read again each time the settings are (`loads` changes).
 */
const props = defineProps<{
  api: Api;
  /** The host's `/api` path. */
  base: string;
  features: Record<string, boolean>;
  /** Counts the settings reads. */
  loads: number;
}>();
const emit = defineEmits<{
  /** Whether the skills section shows (the page's section links follow it). */
  skills: [shown: boolean];
}>();
const message = (e: unknown) => (e as Error).message || "Request failed";

// ---- Skills -------------------------------------------------------------------------------------
const skills = ref<any>(null);
const skillsSaved = ref("");
const skillsBusy = ref(false);
const skillsNote = ref<{ text: string; error?: boolean } | null>(null);
const skillsDirty = computed(() => !!skills.value && canonical(selection()) !== skillsSaved.value);
watch(() => !!skills.value, (shown) => emit("skills", shown), { immediate: true });
function selection() {
  const s = skills.value.selection;
  return s.mode === "all" ? { mode: "all" } : { mode: "custom", skills: [...(s.skills ?? [])].sort() };
}
async function loadSkills() {
  if (!props.features.skillManagement) return;
  try {
    skills.value = await props.api(props.base + "/skills");
    skillsSaved.value = canonical(selection());
  } catch (e) {
    skillsNote.value = { text: message(e), error: true };
  }
}
function setSkillMode(mode: string) {
  skills.value.selection = mode === "custom" ? { mode, skills: skills.value.selection.skills ?? [...skills.value.installed] } : { mode };
}
async function saveSkills() {
  skillsBusy.value = true;
  skillsNote.value = null;
  try {
    let result = await props.api(props.base + "/skills", "PUT", { selection: selection() });
    if (result.confirmationRequired) {
      const ok = await confirmAction({ title: "Remove these Paseo skills from this host?", message: result.confirmationRequired.removals.join(", "), confirmLabel: "Remove skills", danger: true });
      if (!ok) return;
      result = await props.api(props.base + "/skills", "PUT", {
        selection: selection(),
        confirmedRemovals: result.confirmationRequired.removals,
      });
    }
    skills.value = result;
    skillsSaved.value = canonical(selection());
    skillsNote.value = { text: "Skill selection applied." };
  } catch (e) {
    skillsNote.value = { text: message(e), error: true };
  } finally {
    skillsBusy.value = false;
  }
}

// ---- Plugins ------------------------------------------------------------------------------------
const plugins = ref<any[]>([]);
const pluginSource = ref("");
const pluginBusy = ref<string | null>(null);
const pluginNote = ref<{ text: string; error?: boolean } | null>(null);
const pluginsShown = computed(() => !!props.features.pluginManagement);
async function loadPlugins() {
  if (!pluginsShown.value) return;
  try {
    plugins.value = await props.api(props.base + "/plugins");
  } catch (e) {
    pluginNote.value = { text: message(e), error: true };
  }
}
async function managePlugin(id: string, action: string) {
  const name = plugins.value.find((p) => p.id === id)?.name ?? id;
  if (action === "remove" && !(await confirmAction({ title: `Remove plugin ${name} from this host?`, confirmLabel: "Remove plugin", danger: true }))) return;
  pluginBusy.value = id || "install";
  pluginNote.value = null;
  try {
    await props.api(
      props.base + "/plugins" + (id ? "/" + encodeURIComponent(id) + "/" + action : ""),
      "POST",
      id ? {} : { source: pluginSource.value.trim() },
      120_000,
    );
    if (!id) pluginSource.value = "";
    pluginNote.value = { text: id ? `${name}: ${action === "remove" ? "removed" : action + "d"}.` : "Plugin installed." };
    plugins.value = await props.api(props.base + "/plugins");
  } catch (e) {
    pluginNote.value = { text: message(e), error: true };
  } finally {
    pluginBusy.value = null;
  }
}

watch(() => props.loads, () => void Promise.all([loadSkills(), loadPlugins()]), { immediate: true });
</script>

<template>
  <!-- Skills: applied on their own, not with Save -------------------------------------->
  <template v-if="skills">
    <h2 id="hs-skills" class="section-label">Paseo skills</h2>
    <p class="subtle hs-hint">Skills Paseo installs for agents on this host. Applied immediately, separately from Save.</p>
    <div class="card form-card">
      <label class="field">
        <span>Installed skills · {{ skills.state }}</span>
        <select :value="skills.selection.mode" :disabled="skillsBusy" @change="setSkillMode(($event.target as HTMLSelectElement).value)">
          <option value="all">All Paseo skills</option>
          <option value="custom">Only the skills I choose</option>
        </select>
      </label>
      <div v-if="skills.selection.mode === 'custom'" class="hs-skill-list">
        <label v-for="name in skills.available" :key="name" class="hs-check">
          <input v-model="skills.selection.skills" type="checkbox" :value="name" :disabled="skillsBusy" />{{ name }}
        </label>
      </div>
      <div class="hs-actions">
        <button type="button" class="btn btn-outline btn-sm" :disabled="!skillsDirty || skillsBusy" @click="saveSkills">
          {{ skillsBusy ? "Applying…" : "Apply skill selection" }}
        </button>
        <span v-if="skillsNote" class="setting-note" :class="{ 'is-error': skillsNote.error }" role="status">{{ skillsNote.text }}</span>
      </div>
    </div>
  </template>

  <!-- Plugins: each action applies immediately ------------------------------------------>
  <template v-if="pluginsShown">
    <h2 id="hs-plugins" class="section-label">Host plugins</h2>
    <p class="subtle hs-hint">Plugin code runs on this host with its user's permissions. Actions apply immediately.</p>
    <p v-if="pluginNote" class="setting-note" :class="{ 'is-error': pluginNote.error }" role="status">{{ pluginNote.text }}</p>
    <div class="card">
      <p v-if="!plugins.length" class="card-row subtle">No plugins installed.</p>
      <div v-for="p in plugins" :key="p.id" class="card-row hs-plugin">
        <div class="grow">
          <div class="row-title">
            {{ p.name ?? p.id }}
            <span class="badge" :class="{ 'is-error': p.status === 'error' || p.error, 'is-running': p.status === 'running' }">{{ p.status }}</span>
          </div>
          <div v-if="p.description" class="row-sub">{{ p.description }}</div>
          <div v-if="p.error" class="row-sub is-error">{{ p.error }}</div>
        </div>
        <div class="hs-row-actions">
          <button type="button" class="btn btn-outline btn-sm" :disabled="!!pluginBusy" @click="managePlugin(p.id, p.enabled ? 'disable' : 'enable')">
            {{ p.enabled ? "Disable" : "Enable" }}
          </button>
          <button type="button" class="btn btn-outline btn-sm" :disabled="!!pluginBusy" @click="managePlugin(p.id, 'reload')">Reload</button>
          <button type="button" class="icon-btn hs-danger" :disabled="!!pluginBusy" :aria-label="'Remove ' + (p.name ?? p.id)" title="Remove" @click="managePlugin(p.id, 'remove')">
            <span v-if="pluginBusy === p.id" class="spinner"></span><Icon v-else name="trash" :size="14" />
          </button>
        </div>
      </div>
      <div v-if="features.pluginSourceInstallation" class="card-row hs-add">
        <input v-model="pluginSource" placeholder="npm package, Git URL or host directory" aria-label="Install trusted plugin" @keydown.enter.prevent="pluginSource.trim() && managePlugin('', 'install')" />
        <button type="button" class="btn btn-outline btn-sm" :disabled="!pluginSource.trim() || !!pluginBusy" @click="managePlugin('', 'install')">
          {{ pluginBusy === "install" ? "Installing…" : "Install" }}
        </button>
      </div>
    </div>
  </template>
</template>
