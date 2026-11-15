<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import Icon from "./Icon.vue";
const props = defineProps<{
  host: { id: string; label: string };
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}>();
const emit = defineEmits<{ back: [] }>();
const base = `/hosts/${encodeURIComponent(props.host.id)}`;
const config = ref<Record<string, any> | null>(null),
  original = ref<Record<string, any>>({});
const features = ref<Record<string, boolean>>({}),
  version = ref("");
const desktopManaged = ref(false),
  lifecycleJob = ref<any>(null);
let lifecycleTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
onUnmounted(() => {
  disposed = true;
  clearTimeout(lifecycleTimer);
});
const revision = ref(""),
  busy = ref(false),
  error = ref(""),
  message = ref("");
const newProviderId = ref("");
const skills = ref<any>(null),
  plugins = ref<any[]>([]),
  pluginSource = ref(""),
  status = ref("");
const providers = ref<any[]>([]),
  diagnostic = ref("");
const dirty = computed(() => JSON.stringify(config.value) !== JSON.stringify(original.value));
const flags = [
  [
    "idleRuntimeCleanup",
    "Release idle agents",
    "Release safe, resumable idle runtimes to save memory.",
    "idleRuntimeCleanupSetting",
  ],
  [
    "resumeOnStartup",
    "Resume agents after restart",
    "Resume interrupted agents when this daemon starts.",
    "resumeOnStartupSetting",
  ],
  [
    "autoArchiveAfterMerge",
    "Archive merged workspaces",
    "Automatically archive workspaces after their changes are merged.",
    "",
  ],
  [
    "enableTerminalAgentHooks",
    "Terminal agent hooks",
    "Track supported agents launched from terminals.",
    "",
  ],
  ["pluginsEnabled", "Enable host plugins", "Allow this host to run its configured plugins.", ""],
];
function receive(result: any) {
  config.value = structuredClone(result.config);
  original.value = structuredClone(result.config);
  revision.value = result.revision;
  features.value = result.features;
  if (result.desktopManaged !== undefined) desktopManaged.value = result.desktopManaged;
  if (result.version) version.value = result.version;
}
async function load() {
  if (dirty.value && config.value && !confirm("Discard unsaved host settings?")) return;
  busy.value = true;
  error.value = message.value = "";
  try {
    receive(await props.api(base + "/settings"));
    if (features.value.skillManagement) skills.value = await props.api(base + "/skills");
    if (features.value.plugins) plugins.value = await props.api(base + "/plugins");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function save() {
  busy.value = true;
  error.value = message.value = "";
  try {
    const patch = Object.fromEntries(
      Object.entries(config.value!).filter(
        ([k, v]) => JSON.stringify(v) !== JSON.stringify(original.value[k]),
      ),
    );
    for (const [id, p] of Object.entries((patch.providers ?? {}) as Record<string, any>)) {
      if (original.value.providers?.[id]?.command && !p.command)
        throw new Error(
          "Clear command overrides in the host configuration; this form can only replace them.",
        );
    }
    // Array editors keep optional fields empty while typing; omit them on the wire.
    for (const key of ["agentProfiles", "terminalProfiles"])
      if (patch[key]) {
        patch[key] = patch[key].map((p: any) =>
          Object.fromEntries(
            Object.entries(p).filter(
              ([k, v]) =>
                !(["model", "modeId", "thinkingOptionId", "icon", "color"].includes(k) && v === ""),
            ),
          ),
        );
        const ids = patch[key].map((p: any) => p.id);
        if (
          new Set(ids).size !== ids.length ||
          patch[key].some((p: any) => !p.name.trim() || !(p.provider ?? p.command)?.trim())
        )
          throw new Error("Every profile needs a unique ID, name and provider or command.");
      }
    if (patch.metadataGeneration)
      patch.metadataGeneration.providers = patch.metadataGeneration.providers.map((p: any) =>
        Object.fromEntries(Object.entries(p).filter(([, v]) => v !== "")),
      );
    const result = await props.api(base + "/settings", "PATCH", {
      revision: revision.value,
      patch,
    });
    receive(result);
    message.value = "Saved on this host. Launch settings apply to future agents and terminals.";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function back() {
  if (!dirty.value || confirm("Discard unsaved host settings?")) emit("back");
}
async function managePlugin(id: string, action: string) {
  if (action === "remove" && !confirm(`Remove plugin ${id} from this host?`)) return;
  busy.value = true;
  error.value = "";
  try {
    await props.api(
      base + "/plugins" + (id ? "/" + encodeURIComponent(id) + "/" + action : ""),
      "POST",
      id ? {} : { source: pluginSource.value },
    );
    plugins.value = await props.api(base + "/plugins");
    pluginSource.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function pollLifecycle() {
  clearTimeout(lifecycleTimer);
  try {
    const result = await props.api(base + "/lifecycle");
    if (disposed) return;
    lifecycleJob.value = result;
    if (result?.state === "complete" && result.version) version.value = result.version;
    if (result?.state === "running") lifecycleTimer = setTimeout(() => void pollLifecycle(), 2000);
  } catch (e) {
    if (!disposed) {
      error.value = "Could not check the operation. Reopen this page to check its outcome.";
    }
  }
}
async function lifecycle(action: string) {
  if (
    !confirm(
      `${action === "restart" ? "Restart" : "Update and restart"} ${props.host.label}? Running agents may be interrupted and this host will disconnect temporarily.`,
    )
  )
    return;
  busy.value = true;
  error.value = message.value = "";
  try {
    lifecycleJob.value = await props.api(base + "/lifecycle/" + action, "POST", {});
    void pollLifecycle();
  } catch (e) {
    error.value = (e as Error).message + ". Check host status before retrying.";
  } finally {
    busy.value = false;
  }
}
async function showStatus() {
  busy.value = true;
  error.value = "";
  try {
    status.value = JSON.stringify(await props.api(base + "/status"), null, 2);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function saveSkills() {
  busy.value = true;
  error.value = message.value = "";
  try {
    let result = await props.api(base + "/skills", "PUT", {
      selection: skills.value.selection.mode === "all" ? { mode: "all" } : skills.value.selection,
    });
    if (result.confirmationRequired) {
      if (
        !confirm("Remove these managed skills? " + result.confirmationRequired.removals.join(", "))
      )
        return;
      result = await props.api(base + "/skills", "PUT", {
        selection: skills.value.selection.mode === "all" ? { mode: "all" } : skills.value.selection,
        confirmedRemovals: result.confirmationRequired.removals,
      });
    }
    skills.value = result;
    message.value = "Skill selection saved on this host.";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function addProfile(key: string) {
  const c = config.value!;
  (c[key] ??= []).push(
    key === "agentProfiles"
      ? {
          id: crypto.randomUUID(),
          name: "",
          provider: providers.value[0]?.id ?? "codex",
          notes: "",
        }
      : { id: crypto.randomUUID(), name: "", command: "", args: [] },
  );
}
function move(list: any[], index: string | number, direction: number) {
  const i = Number(index);
  const j = i + direction;
  if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
}
async function diagnose(id: string) {
  busy.value = true;
  error.value = "";
  try {
    diagnostic.value = JSON.stringify(
      await props.api(base + "/provider-diagnostic/" + encodeURIComponent(id)),
      null,
      2,
    );
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
const providerIds = computed(() => [
  ...new Set([...providers.value.map((p) => p.id), ...Object.keys(config.value?.providers ?? {})]),
]);
function editProvider(id: string) {
  const c = config.value!;
  c.providers ??= {};
  return (c.providers[id] ??= {});
}
function addProvider() {
  const id = newProviderId.value.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(id) || providerIds.value.includes(id)) {
    error.value = "Choose a unique provider ID using lowercase letters, digits and hyphens.";
    return;
  }
  config.value!.providers ??= {};
  config.value!.providers[id] = { extends: "codex", label: id, enabled: true };
  newProviderId.value = "";
}
function setProvider(id: string, enabled: boolean) {
  const c = config.value!;
  c.providers ??= {};
  c.providers[id] = { ...c.providers[id], enabled };
}
onMounted(() => {
  void load();
  void pollLifecycle();
  void props
    .api(base + "/providers")
    .then((p) => {
      providers.value = p;
    })
    .catch(() => {});
});
</script>

<template>
  <section class="page host-settings">
    <header class="page-head">
      <button class="icon-btn" aria-label="Back to hosts" @click="back">
        <Icon name="back" :size="18" />
      </button>
      <div>
        <h1>{{ host.label }}</h1>
        <p class="subtle">
          Host settings · affects every client connected to this daemon<span v-if="version">
            · {{ version }}</span
          >
        </p>
      </div>
    </header>
    <div class="page-body">
      <div class="hs-actions">
        <button class="btn btn-outline" :disabled="busy" @click="load">Reload</button
        ><button
          class="btn btn-primary"
          :disabled="busy || !config || !dirty || lifecycleJob?.state === 'running'"
          @click="save"
        >
          {{ busy ? "Working…" : "Save changes" }}</button
        ><span v-if="dirty && config" class="subtle">Unsaved changes</span>
      </div>
      <p v-if="error" class="setting-note is-error" role="alert">{{ error }}</p>
      <p v-if="message" class="setting-note" role="status">{{ message }}</p>
      <fieldset
        v-if="config"
        :disabled="busy || lifecycleJob?.state === 'running'"
        class="hs-fields"
      >
        <h2 class="section-label">Agents & workspaces</h2>
        <div class="card">
          <template v-for="[key, label, hint, gate] in flags" :key="key"
            ><label
              v-if="(!gate || features[gate]) && (key in config || !!gate)"
              class="card-row switch-row"
              ><div class="grow">
                <div class="row-title">{{ label }}</div>
                <div class="row-sub">{{ hint }}</div>
              </div>
              <input v-model="config[key]" type="checkbox" class="switch" /></label
          ></template>
          <label v-if="config.mcp" class="card-row switch-row"
            ><div class="grow">
              <div class="row-title">Paseo orchestration tools</div>
              <div class="row-sub">Inject Paseo tools into agents.</div>
            </div>
            <input v-model="config.mcp.injectIntoAgents" type="checkbox" class="switch"
          /></label>
          <label v-if="config.browserTools" class="card-row switch-row"
            ><div class="grow">
              <div class="row-title">Browser tools</div>
              <div class="row-sub">
                Allow agents to use browser automation supported by this host.
              </div>
            </div>
            <input v-model="config.browserTools.enabled" type="checkbox" class="switch"
          /></label>
          <label v-if="config.usage" class="card-row switch-row"
            ><div class="grow row-title">Collect provider usage</div>
            <input v-model="config.usage.enabled" type="checkbox" class="switch"
          /></label>
        </div>
        <div class="card form-card">
          <label class="field"
            ><span>Additional system instructions</span
            ><textarea
              v-model="config.appendSystemPrompt"
              rows="5"
              placeholder="Instructions appended for agents on this host"
            /></label
          ><label v-if="features.resumeOnStartupSetting" class="field"
            ><span>Restart recovery prompt</span
            ><textarea
              v-model="config.resumePrompt"
              rows="3"
              placeholder="Prompt used when resuming interrupted work"
            />
          </label>
        </div>

        <template v-if="features.agentProfiles">
          <h2 class="section-label">Agent profiles</h2>
          <p class="subtle">Named launch settings, also available to orchestrating agents.</p>
          <div v-for="(p, i) in config.agentProfiles ?? []" :key="p.id" class="card form-card">
            <div class="hs-grid">
              <label class="field"><span>Name</span><input v-model="p.name" /></label
              ><label class="field"
                ><span>Provider</span><input v-model="p.provider" list="hs-providers" /></label
              ><label class="field"
                ><span>Model (optional)</span
                ><input v-model="p.model" :list="'hs-models-' + p.provider" /></label
              ><label class="field"
                ><span>Mode ID (optional)</span><input v-model="p.modeId" /></label
              ><label class="field"
                ><span>Thinking level ID (optional)</span><input v-model="p.thinkingOptionId"
              /></label>
            </div>
            <label class="field"
              ><span>When to use</span><textarea v-model="p.notes" rows="2" />
            </label>
            <div class="hs-actions">
              <button
                class="btn btn-outline"
                :disabled="i === 0"
                @click="move(config.agentProfiles, i, -1)"
              >
                Move up</button
              ><button class="btn btn-outline" @click="config.agentProfiles.splice(i, 1)">
                Remove profile
              </button>
            </div>
          </div>
          <button class="btn btn-outline" @click="addProfile('agentProfiles')">
            Add agent profile
          </button>
        </template>
        <template v-if="skills"
          ><h2 class="section-label">Paseo skills</h2>
          <div class="card form-card">
            <label class="field"
              ><span>Installed skills · {{ skills.state }}</span
              ><select
                v-model="skills.selection.mode"
                @change="
                  skills.selection.mode === 'custom' &&
                  (skills.selection.skills ??= [...skills.installed])
                "
              >
                <option value="all">All Paseo skills</option>
                <option value="custom">Choose skills</option>
              </select></label
            ><template v-if="skills.selection.mode === 'custom'"
              ><label v-for="name in skills.available" :key="name" class="switch-row"
                ><span>{{ name }}</span
                ><input
                  v-model="skills.selection.skills"
                  type="checkbox"
                  :value="name" /></label></template
            ><button class="btn btn-outline" @click="saveSkills">Save skill selection</button>
          </div></template
        >
        <h2 class="section-label">Providers</h2>
        <div class="card">
          <div v-for="id in providerIds" :key="id" class="card-row">
            <label class="grow switch-row"
              ><span>{{ providers.find((p) => p.id === id)?.label ?? id }}</span
              ><input
                type="checkbox"
                class="switch"
                :checked="config.providers?.[id]?.enabled !== false"
                @change="setProvider(id, ($event.target as HTMLInputElement).checked)" /></label
            ><button class="btn btn-outline" @click="diagnose(id)">Diagnostic</button>
          </div>
        </div>
        <details v-for="id in providerIds" :key="'edit-' + id" class="card form-card">
          <summary @click="editProvider(id)">Configure {{ id }}</summary>
          <template v-if="config.providers?.[id]"
            ><div v-if="config.providers[id].extends" class="hs-grid">
              <label class="field"
                ><span>Display name</span><input v-model="config.providers[id].label" /></label
              ><label class="field"
                ><span>Based on</span
                ><select v-model="config.providers[id].extends">
                  <option
                    v-for="name in ['claude', 'codex', 'copilot', 'opencode', 'pi', 'omp', 'acp']"
                    :key="name"
                  >
                    {{ name }}
                  </option>
                </select></label
              >
            </div>
            <label v-if="config.providers[id].extends" class="field"
              ><span>Command override (one argument per line)</span
              ><textarea
                :value="(config.providers[id].command ?? []).join('\n')"
                @change="
                  ($event.target as HTMLTextAreaElement).value.trim()
                    ? (config.providers[id].command = ($event.target as HTMLTextAreaElement).value
                        .split('\n')
                        .filter(Boolean))
                    : delete config.providers[id].command
                "
              /></label
            ><label class="switch-row"
              ><span>Paseo tools for this provider</span
              ><input
                type="checkbox"
                :checked="config.providers[id].paseoTools?.enabled !== false"
                @change="
                  config.providers[id].paseoTools = {
                    ...config.providers[id].paseoTools,
                    enabled: ($event.target as HTMLInputElement).checked,
                  }
                "
            /></label>
            <div
              v-for="(m, i) in config.providers[id].additionalModels ?? []"
              :key="i"
              class="hs-grid"
            >
              <label class="field"><span>Model ID</span><input v-model="m.id" /></label
              ><label class="field"><span>Model label</span><input v-model="m.label" /></label
              ><label class="switch-row"
                ><span>Default model</span><input v-model="m.isDefault" type="checkbox" /></label
              ><button
                class="btn btn-outline"
                @click="config.providers[id].additionalModels.splice(i, 1)"
              >
                Remove model
              </button>
            </div>
            <button
              class="btn btn-outline"
              @click="(config.providers[id].additionalModels ??= []).push({ id: '', label: '' })"
            >
              Add model
            </button></template
          >
        </details>
        <div class="card form-card">
          <label class="field"
            ><span>New custom provider ID</span
            ><input v-model="newProviderId" placeholder="my-codex" /></label
          ><button class="btn btn-outline" @click="addProvider">Add custom provider</button>
        </div>
        <details v-if="diagnostic" open>
          <summary>Provider diagnostic</summary>
          <pre class="hs-output">{{ diagnostic }}</pre>
        </details>
        <h2 class="section-label">Metadata generation</h2>
        <p class="subtle">
          Ordered providers for branch names, commit messages and pull requests. An empty list uses
          automatic selection.
        </p>
        <div
          v-for="(p, i) in config.metadataGeneration?.providers ?? []"
          :key="i"
          class="card form-card"
        >
          <div class="hs-grid">
            <label class="field"
              ><span>Provider</span><input v-model="p.provider" list="hs-providers" /></label
            ><label class="field"
              ><span>Model (optional)</span
              ><input v-model="p.model" :list="'hs-models-' + p.provider" /></label
            ><label class="field"
              ><span>Thinking level ID (optional)</span><input v-model="p.thinkingOptionId"
            /></label>
          </div>
          <div class="hs-actions">
            <button
              class="btn btn-outline"
              :disabled="i === 0"
              @click="move(config.metadataGeneration.providers, i, -1)"
            >
              Move up</button
            ><button
              class="btn btn-outline"
              @click="config.metadataGeneration.providers.splice(i, 1)"
            >
              Remove
            </button>
          </div>
        </div>
        <button
          class="btn btn-outline"
          @click="
            (config.metadataGeneration ??= { providers: [] }).providers.push({
              provider: providers[0]?.id ?? 'codex',
            })
          "
        >
          Add metadata provider
        </button>
        <h2 class="section-label">Terminal profiles</h2>
        <p class="subtle">
          Commands run on this host when a profile is selected for a new terminal.
        </p>
        <div v-for="(p, i) in config.terminalProfiles ?? []" :key="p.id" class="card form-card">
          <div class="hs-grid">
            <label class="field"><span>Name</span><input v-model="p.name" /></label
            ><label class="field"
              ><span>Command</span><input v-model="p.command" placeholder="/bin/bash"
            /></label>
          </div>
          <label class="field"
            ><span>Arguments (one per line)</span
            ><textarea
              :value="(p.args ?? []).join('\n')"
              rows="2"
              @input="
                p.args = ($event.target as HTMLTextAreaElement).value.split('\n').filter(Boolean)
              "
            />
          </label>
          <div class="hs-actions">
            <button
              class="btn btn-outline"
              :disabled="i === 0"
              @click="move(config.terminalProfiles, i, -1)"
            >
              Move up</button
            ><button class="btn btn-outline" @click="config.terminalProfiles.splice(i, 1)">
              Remove profile
            </button>
          </div>
        </div>
        <button class="btn btn-outline" @click="addProfile('terminalProfiles')">
          Add terminal profile
        </button>
        <template v-if="config.relay && features.relayConfig"
          ><h2 class="section-label">Relay</h2>
          <div class="card">
            <label class="card-row switch-row"
              ><div class="grow">
                <div class="row-title">Enable relay connections</div>
                <div class="row-sub">
                  Changing this may disconnect clients connected through the relay.
                </div>
              </div>
              <input v-model="config.relay.enabled" type="checkbox" class="switch" /></label
            ><label
              v-if="config.relay.requireProtectedSecurity !== undefined"
              class="card-row switch-row"
              ><div class="grow row-title">Require protected relay sessions</div>
              <input v-model="config.relay.requireProtectedSecurity" type="checkbox" class="switch"
            /></label></div
        ></template>
        <template v-if="features.pluginManagement"
          ><h2 class="section-label">Host plugins</h2>
          <div v-for="p in plugins" :key="p.id" class="card form-card">
            <div class="row-title">{{ p.name ?? p.id }} · {{ p.status }}</div>
            <p class="subtle">{{ p.description }}</p>
            <p v-if="p.error" class="setting-note is-error">{{ p.error }}</p>
            <div class="hs-actions">
              <button
                class="btn btn-outline"
                @click="managePlugin(p.id, p.enabled ? 'disable' : 'enable')"
              >
                {{ p.enabled ? "Disable" : "Enable" }}</button
              ><button class="btn btn-outline" @click="managePlugin(p.id, 'reload')">Reload</button
              ><button class="btn btn-outline" @click="managePlugin(p.id, 'remove')">Remove</button>
            </div>
          </div>
          <div v-if="features.pluginSourceInstallation" class="card form-card">
            <label class="field"
              ><span>Install trusted plugin</span
              ><input v-model="pluginSource" placeholder="Package, Git URL or host directory"
            /></label>
            <p class="subtle">Plugin code runs on this host with its user permissions.</p>
            <button
              class="btn btn-outline"
              :disabled="!pluginSource.trim()"
              @click="managePlugin('', 'install')"
            >
              Install plugin
            </button>
          </div></template
        >
        <h2 class="section-label">Daemon</h2>
        <p class="subtle">Running version: {{ version || "Unknown" }}</p>
        <div class="hs-actions">
          <button v-if="features.daemonStatusRpc" class="btn btn-outline" @click="showStatus">
            Full status</button
          ><button
            v-if="features.daemonStatusRpc"
            class="btn btn-outline"
            :disabled="dirty"
            @click="lifecycle('restart')"
          >
            Restart daemon…</button
          ><button
            v-if="features.daemonSelfUpdate && !desktopManaged"
            class="btn btn-outline"
            :disabled="dirty"
            @click="lifecycle('update')"
          >
            Update & restart daemon…
          </button>
        </div>
        <p v-if="desktopManaged" class="subtle">
          This daemon is managed by Paseo Desktop. Update it through Desktop.
        </p>
        <p v-if="!features.daemonSelfUpdate && !desktopManaged" class="subtle">
          This installation does not support remote self-update.
        </p>
        <p
          v-if="lifecycleJob"
          role="status"
          class="setting-note"
          :class="{ 'is-error': lifecycleJob.state === 'failed' }"
        >
          {{ lifecycleJob.phase
          }}<span v-if="lifecycleJob.version"> · {{ lifecycleJob.version }}</span
          ><span v-if="lifecycleJob.error">: {{ lifecycleJob.error }}</span>
        </p>
        <pre v-if="status" class="hs-output">{{ status }}</pre>
        <datalist id="hs-providers">
          <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.label }}</option></datalist
        ><datalist v-for="p in providers" :id="'hs-models-' + p.id" :key="p.id">
          <option v-for="m in p.models" :key="m.id" :value="m.id">{{ m.label }}</option>
        </datalist>
      </fieldset>
    </div>
  </section>
</template>
<style scoped>
.hs-fields {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.hs-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.hs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(230px, 100%), 1fr));
  gap: 12px;
}
.hs-output {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
}
.form-card {
  margin-top: 12px;
}
</style>
