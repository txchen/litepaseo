<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { PluginRegistryDetail, PluginRegistryIndex } from "../shared/wire.ts";
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

// ---- Plugin Gallery -----------------------------------------------------------------------------
const galleryOpen = ref(false);
const gallery = ref<PluginRegistryIndex | null>(null);
const galleryLoading = ref(false);
const galleryError = ref("");
const galleryQuery = ref("");
const galleryCategory = ref("");
const galleryDetail = ref<Record<string, PluginRegistryDetail>>({});
const galleryExpanded = ref<string | null>(null);
const installedIds = computed(() => {
  const ids = new Set<string>();
  for (const p of plugins.value) {
    if (p.id) ids.add(String(p.id));
    if (p.registryId) ids.add(String(p.registryId));
  }
  return ids;
});

const filteredGallery = computed(() => {
  const list = gallery.value?.plugins ?? [];
  const q = galleryQuery.value.trim().toLowerCase();
  const cat = galleryCategory.value;
  return list.filter((p) => {
    if (cat && !p.categories.includes(cat)) return false;
    if (!q) return true;
    return `${p.name} ${p.id} ${p.description} ${p.author.github} ${p.author.name ?? ""}`.toLowerCase().includes(q);
  });
});

async function openGallery() {
  galleryOpen.value = !galleryOpen.value;
  if (!galleryOpen.value || gallery.value) return;
  galleryLoading.value = true;
  galleryError.value = "";
  try {
    gallery.value = (await props.api(props.base + "/plugin-registry")) as PluginRegistryIndex;
  } catch (e) {
    galleryError.value = message(e);
  } finally {
    galleryLoading.value = false;
  }
}

async function toggleGalleryDetail(id: string) {
  if (galleryExpanded.value === id) {
    galleryExpanded.value = null;
    return;
  }
  galleryExpanded.value = id;
  if (galleryDetail.value[id]) return;
  const parts = id.split("/");
  if (parts.length !== 2) return;
  try {
    const detail = (await props.api(
      `${props.base}/plugin-registry/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}`,
    )) as PluginRegistryDetail;
    galleryDetail.value = { ...galleryDetail.value, [id]: detail };
  } catch {
    /* keep summary view */
  }
}

async function installFromGallery(id: string) {
  pluginBusy.value = "gallery:" + id;
  pluginNote.value = null;
  try {
    await props.api(props.base + "/plugins", "POST", { source: id }, 120_000);
    pluginNote.value = { text: `Installed ${id}.` };
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
      <div v-if="features.pluginRegistry" class="card-row hs-gallery-bar">
        <span class="row-sub grow">Browse vetted plugins from the Paseo plugin registry.</span>
        <button type="button" class="btn btn-outline btn-sm" @click="openGallery">
          {{ galleryOpen ? "Hide gallery" : "Browse gallery" }}
        </button>
      </div>
    </div>

    <div v-if="galleryOpen && features.pluginRegistry" class="card hs-gallery">
      <div class="card-row hs-gallery-filters">
        <input v-model="galleryQuery" placeholder="Search plugins…" aria-label="Search plugin gallery" />
        <select v-if="gallery?.categories?.length" v-model="galleryCategory" aria-label="Plugin category">
          <option value="">All categories</option>
          <option v-for="c in gallery.categories" :key="c.slug" :value="c.slug">{{ c.label }}</option>
        </select>
      </div>
      <p v-if="galleryLoading" class="card-row subtle"><span class="spinner spinner-sm"></span> Loading plugin gallery…</p>
      <p v-else-if="galleryError" class="card-row setting-note is-error" role="alert">{{ galleryError }}</p>
      <p v-else-if="!filteredGallery.length" class="card-row subtle">No matching plugins found.</p>
      <div v-for="item in filteredGallery" :key="item.id" class="card-row hs-plugin hs-gallery-item">
        <div class="grow">
          <div class="row-title">
            <button type="button" class="link-btn" @click="toggleGalleryDetail(item.id)">{{ item.name }}</button>
            <span v-if="item.version" class="hs-tag">v{{ item.version }}</span>
            <span v-if="installedIds.has(item.id)" class="badge">installed</span>
          </div>
          <div class="row-sub">{{ item.description }}</div>
          <div class="row-sub">
            by {{ item.author.name || item.author.github }}
            <template v-if="typeof item.installs === 'number'"> · {{ item.installs }} installs</template>
            <template v-if="item.repositoryUrl"> · <a :href="item.repositoryUrl" target="_blank" rel="noopener noreferrer">Repo</a></template>
          </div>
          <pre v-if="galleryExpanded === item.id && galleryDetail[item.id]?.readme" class="hs-output hs-gallery-readme">{{ galleryDetail[item.id]!.readme.slice(0, 3000) }}</pre>
        </div>
        <div v-if="features.pluginSourceInstallation" class="hs-row-actions">
          <button
            type="button"
            class="btn btn-outline btn-sm"
            :disabled="!!pluginBusy || installedIds.has(item.id)"
            @click="installFromGallery(item.id)"
          >
            {{ pluginBusy === "gallery:" + item.id ? "Installing…" : installedIds.has(item.id) ? "Installed" : "Install" }}
          </button>
        </div>
      </div>
    </div>
  </template>
</template>
