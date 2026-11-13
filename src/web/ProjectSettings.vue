<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import type { ProjectConfigState } from "../shared/wire.ts";
import Icon from "./Icon.vue";
import ProjectIcon from "./ProjectIcon.vue";
import ProjectEdit from "./ProjectEdit.vue";
import {
  configToDraft,
  draftToConfig,
  METADATA_PROMPT_KEYS,
  scriptHint,
  scriptId,
  scriptIsValid,
  scriptProblems,
  SERVICE_TYPE,
  type ConfigDraft,
  type MetadataPromptKey,
  type ScriptDraft,
} from "./project-config-form.ts";

/**
 * Paseo's project settings: worktree hooks, scripts and metadata prompts, saved to the project's
 * paseo.json on its host. Fields the form does not show are kept. The revision read here guards
 * the write, so a file changed on the host meanwhile is never overwritten.
 */
const props = defineProps<{
  hostId: string;
  hostLabel: string;
  project: { projectId: string; name: string; customName: string | null; iconRevision: string | null };
  rootPath: string;
  /** The host stores custom project icons; without it only the name is editable. */
  customIcons: boolean;
  request: (path: string, method?: string, body?: unknown, timeoutMs?: number) => Promise<unknown>;
}>();
const emit = defineEmits<{ close: [] }>();

const DOCS_URL = "https://paseo.sh/docs/worktrees";
const PROMPTS: Record<MetadataPromptKey, { title: string; placeholder: string }> = {
  branchName: { title: "Branch names", placeholder: "Prefix branches with feat/ or fix/, mb/ for personal branches" },
  commitMessage: { title: "Commit messages", placeholder: "Use Conventional Commits with a scope" },
  pullRequest: { title: "Pull requests", placeholder: "Lead with a one-paragraph summary, include a Test plan section" },
};

const loading = ref(true);
const saving = ref(false);
const readError = ref("");
/** The write failure, by the daemon's code: stale and write_failed get their own callouts. */
const writeError = ref<{ code: string; message: string } | null>(null);
const saved = ref(false);
/** Name and icon are edited in their own sheet (Paseo's pencil next to the title). */
const editingProject = ref(false);
const projectUpdated = ref(false);
const state = ref<ProjectConfigState | null>(null);
const draft = ref<ConfigDraft>(configToDraft(null));
const baseline = ref("");
const base = computed(() => `/hosts/${encodeURIComponent(props.hostId)}/project-config`);
const home = (path: string) => path.replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");

const output = computed(() => JSON.stringify(draftToConfig(draft.value, state.value?.config)));
const dirty = computed(() => !!state.value && output.value !== baseline.value);
const invalidScripts = computed(() => draft.value.scripts.some((s) => !scriptIsValid(s)));
const stale = computed(() => writeError.value?.code === "stale_project_config");
watch(output, () => (saved.value = projectUpdated.value = false));

function adopt(result: ProjectConfigState) {
  state.value = result;
  draft.value = configToDraft(result.config);
  baseline.value = JSON.stringify(draftToConfig(draft.value, result.config));
}
async function load() {
  loading.value = true;
  readError.value = "";
  writeError.value = null;
  try {
    adopt((await props.request(`${base.value}?root=${encodeURIComponent(props.rootPath)}`)) as ProjectConfigState);
  } catch (e) {
    readError.value = String((e as Error).message);
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (!state.value || saving.value || stale.value || invalidScripts.value) return;
  saving.value = true;
  writeError.value = null;
  try {
    const result = (await props.request(base.value, "PUT", {
      root: state.value.rootPath,
      config: draftToConfig(draft.value, state.value.config),
      revision: state.value.revision,
    })) as ProjectConfigState;
    adopt(result);
    saved.value = true;
  } catch (e) {
    const error = e as Error & { code?: string };
    writeError.value = { code: error.code ?? "", message: error.message };
  } finally {
    saving.value = false;
  }
}
function close() {
  if (saving.value) return;
  if (editingProject.value) return void (editingProject.value = false);
  if (editing.value) return closeScript();
  if (dirty.value && !confirm("Discard your unsaved project settings?")) return;
  emit("close");
}

// ---- Scripts: a list, each edited in its own small dialog (Paseo's script sheet) ----
const editing = ref<ScriptDraft | null>(null);
const touched = reactive({ name: false, command: false });
const scriptMenu = ref<string | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const problems = computed(() => {
  const script = editing.value;
  if (!script) return { name: "", command: "" };
  const p = scriptProblems(script);
  const name = script.name.trim();
  if (!p.name && draft.value.scripts.some((s) => s.id !== script.id && s.name.trim() === name))
    p.name = "Another script already has this name";
  return p;
});
let before: Pick<ScriptDraft, "name" | "commandText" | "type"> | null = null;
function openScript(script: ScriptDraft) {
  scriptMenu.value = null;
  editing.value = script;
  before = { name: script.name, commandText: script.commandText, type: script.type };
  touched.name = touched.command = false;
  void nextTick(() => nameInput.value?.focus());
}
function addScript() {
  const script: ScriptDraft = { id: scriptId(), name: "", commandText: "", commandKind: "missing", type: "", portText: "", raw: {} };
  draft.value.scripts.push(script);
  openScript(draft.value.scripts[draft.value.scripts.length - 1]);
}
/** Cancel restores the script as it was when opened; a new script left empty is dropped. */
function closeScript() {
  const script = editing.value;
  if (script && before) Object.assign(script, before);
  if (script && !script.name.trim() && !script.commandText.trim() && !script.type.trim() && !script.portText.trim())
    draft.value.scripts = draft.value.scripts.filter((s) => s.id !== script.id);
  editing.value = null;
}
function doneScript() {
  if (problems.value.name || problems.value.command) {
    touched.name = touched.command = true;
    return;
  }
  editing.value = null;
}
function removeScript(script: ScriptDraft) {
  scriptMenu.value = null;
  if (!confirm(`Remove ${script.name || "this script"}?`)) return;
  draft.value.scripts = draft.value.scripts.filter((s) => s.id !== script.id);
}
function toggleService(event: Event) {
  if (editing.value) editing.value.type = (event.target as HTMLInputElement).checked ? SERVICE_TYPE : "";
}
function onKey(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
    event.preventDefault();
    if (!editing.value && !editingProject.value) void save();
  }
}
onMounted(load);
</script>

<template>
  <div class="overlay" @mousedown.self="close" @keydown.esc="close" @keydown="onKey">
    <form class="sheet project-settings" role="dialog" aria-modal="true" aria-label="Project settings" @submit.prevent="save">
      <header class="sheet-head">
        <div class="ps-title">
          <div class="ps-title-row">
            <ProjectIcon
              :name="project.name"
              :size="28"
              :source="{ hostId, rootPath, projectId: project.projectId, projectIconRevision: project.iconRevision }"
            />
            <h2>{{ project.name }}</h2>
            <button
              v-if="project.projectId"
              type="button"
              class="icon-btn ps-edit"
              aria-label="Edit project"
              title="Edit project"
              @click="editingProject = true"
            >
              <Icon name="edit" :size="14" />
            </button>
          </div>
          <p class="path-hint"><Icon name="server" :size="12" />{{ hostLabel }} · {{ home(rootPath) }}</p>
        </div>
        <button type="button" class="icon-btn" aria-label="Close" @click="close"><Icon name="close" :size="16" /></button>
      </header>
      <div class="sheet-body ps-body" @click="scriptMenu = null">
        <p v-if="loading" class="sheet-note"><span class="spinner"></span> Reading paseo.json…</p>
        <div v-else-if="readError" class="ps-callout is-error" role="alert">
          <p><Icon name="alert" :size="14" />{{ readError }}</p>
          <button type="button" class="btn btn-outline" @click="load">Reload</button>
        </div>
        <template v-else>
          <section class="ps-group" aria-labelledby="ps-worktree">
            <h3 id="ps-worktree">Worktree lifecycle hooks</h3>
            <p class="ps-info">Commands that run when a worktree is created or torn down for this project</p>
            <div class="ps-section">
              <div class="ps-section-head">
                <label for="ps-setup">Setup</label>
                <a :href="DOCS_URL" target="_blank" rel="noopener" title="See docs for more details and the environment variables available to these commands">Docs</a>
              </div>
              <div v-if="state?.uncommittedSetup" class="ps-callout is-warn">
                <p><Icon name="alert" :size="14" /><b>Commit paseo.json changes</b></p>
                <p class="ps-callout-sub">New worktrees use the setup script from the base branch you select.</p>
              </div>
              <textarea id="ps-setup" v-model="draft.setupText" class="ps-code" placeholder="npm install" spellcheck="false" aria-label="Worktree setup commands"></textarea>
            </div>
            <div class="ps-section">
              <div class="ps-section-head">
                <label for="ps-teardown">Teardown</label>
                <a :href="DOCS_URL" target="_blank" rel="noopener" title="See docs for more details and the environment variables available to these commands">Docs</a>
              </div>
              <textarea id="ps-teardown" v-model="draft.teardownText" class="ps-code" placeholder="docker compose down" spellcheck="false" aria-label="Worktree teardown commands"></textarea>
            </div>
          </section>

          <section class="ps-group" aria-labelledby="ps-scripts">
            <div class="ps-group-head">
              <h3 id="ps-scripts">Scripts</h3>
              <button type="button" class="icon-btn" aria-label="Add script" title="Add script" @click="addScript"><Icon name="plus" :size="15" /></button>
            </div>
            <p class="ps-info">Long-running services and one-off commands you can launch from any agent in this project</p>
            <div class="card ps-scripts">
              <div v-if="!draft.scripts.length" class="card-row row-sub">No scripts yet.</div>
              <div v-for="script in draft.scripts" :key="script.id" class="card-row ps-script" :class="{ invalid: !scriptIsValid(script) }">
                <button type="button" class="ps-script-main" @click="openScript(script)">
                  <span class="row-title">{{ script.name || "Untitled script" }}</span>
                  <span class="row-sub">{{ scriptHint(script) || "No command" }}</span>
                </button>
                <div class="ps-script-more">
                  <button
                    type="button"
                    class="icon-btn"
                    :aria-label="'Open script menu for ' + (script.name || 'untitled script')"
                    @click.stop="scriptMenu = scriptMenu === script.id ? null : script.id"
                  >
                    <Icon name="more-v" :size="15" />
                  </button>
                  <div v-if="scriptMenu === script.id" class="menu ps-menu" role="menu" @click.stop>
                    <button type="button" role="menuitem" @click="openScript(script)"><Icon name="edit" :size="14" />Edit</button>
                    <button type="button" role="menuitem" class="menu-danger" @click="removeScript(script)"><Icon name="trash" :size="14" />Remove</button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="ps-group" aria-labelledby="ps-metadata">
            <h3 id="ps-metadata">Metadata generation</h3>
            <p class="ps-info">
              Project-specific instructions injected into the AI prompts Paseo uses to generate metadata — use them to enforce your
              team's conventions like branch naming, commit style, or PR format
            </p>
            <div v-for="key in METADATA_PROMPT_KEYS" :key="key" class="ps-section">
              <div class="ps-section-head"><label :for="'ps-prompt-' + key">{{ PROMPTS[key].title }}</label></div>
              <textarea :id="'ps-prompt-' + key" v-model="draft.prompts[key]" :placeholder="PROMPTS[key].placeholder"></textarea>
            </div>
          </section>

          <div v-if="stale" class="ps-callout is-error" role="alert">
            <p><Icon name="alert" :size="14" /><b>Config changed on disk</b></p>
            <p class="ps-callout-sub">Reload to fetch the latest paseo.json before saving. Your unsaved edits will be replaced.</p>
            <button type="button" class="btn btn-outline" @click="load">Reload</button>
          </div>
          <div v-else-if="writeError" class="ps-callout is-error" role="alert">
            <p><Icon name="alert" :size="14" />{{ writeError.message }}</p>
            <div class="ps-callout-actions">
              <button type="button" class="btn btn-outline" @click="save">Try again</button>
              <button type="button" class="btn btn-outline" @click="load">Reload</button>
            </div>
          </div>
        </template>
      </div>
      <footer class="sheet-foot">
        <span v-if="projectUpdated && !saved" class="sheet-note sheet-reset ps-saved"><Icon name="check" :size="14" />Project updated</span>
        <span v-if="saved && !dirty" class="sheet-note sheet-reset ps-saved"><Icon name="check" :size="14" />Project saved</span>
        <button type="button" class="btn btn-ghost" :disabled="saving" @click="close">{{ dirty ? "Cancel" : "Close" }}</button>
        <button class="btn btn-primary" :disabled="loading || !!readError || saving || !dirty || stale || invalidScripts">
          {{ saving ? "Saving…" : "Save" }}
        </button>
      </footer>
    </form>

    <ProjectEdit
      v-if="editingProject"
      :host-id="hostId"
      :root-path="rootPath"
      :project="project"
      :custom-icons="customIcons"
      :request="request"
      @saved="(projectUpdated = true), (saved = false)"
      @close="editingProject = false"
    />
    <div v-if="editing" class="overlay ps-script-overlay" @mousedown.self="closeScript" @keydown.esc.stop="closeScript">
      <form class="sheet sheet-small" role="dialog" aria-modal="true" :aria-label="editing.name ? 'Edit ' + editing.name : 'New script'" @submit.prevent="doneScript">
        <header class="sheet-head">
          <h2>{{ editing.name.trim() ? "Edit " + editing.name.trim() : "New script" }}</h2>
          <button type="button" class="icon-btn" aria-label="Close" @click="closeScript"><Icon name="close" :size="16" /></button>
        </header>
        <div class="sheet-body">
          <label class="field">
            <span>Name</span>
            <input ref="nameInput" v-model="editing.name" placeholder="dev" spellcheck="false" autocapitalize="off" aria-label="Script name" @blur="touched.name = true" />
          </label>
          <p v-if="touched.name && problems.name" class="ps-field-error">{{ problems.name }}</p>
          <label class="field">
            <span>Command</span>
            <textarea v-model="editing.commandText" class="ps-code" placeholder="npm run dev" spellcheck="false" aria-label="Script command" @blur="touched.command = true"></textarea>
          </label>
          <p v-if="touched.command && problems.command" class="ps-field-error">{{ problems.command }}</p>
          <label class="switch-row ps-service">
            <div class="grow">
              <div class="row-title">Run as a service</div>
              <div class="row-sub">Paseo supervises the process and assigns a port via $PASEO_PORT</div>
            </div>
            <input class="switch" type="checkbox" :checked="editing.type === SERVICE_TYPE" aria-label="Run as a service" @change="toggleService" />
          </label>
        </div>
        <footer class="sheet-foot">
          <button type="button" class="btn btn-ghost" @click="closeScript">Cancel</button>
          <button class="btn btn-primary">Save</button>
        </footer>
      </form>
    </div>
  </div>
</template>
