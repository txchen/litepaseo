<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { HostState } from "../shared/wire.ts";
import Icon from "./Icon.vue";
import { tildeHome } from "./format.ts";
import { useDialog } from "./use-dialog.ts";

const props = defineProps<{
  hosts: HostState[];
  initialHostId: string | null;
  api: (path: string, method?: string, body?: unknown, timeoutMs?: number) => Promise<any>;
}>();
const emit = defineEmits<{
  close: [];
  added: [hostId: string, cwd: string];
}>();

const sheet = ref<HTMLElement | null>(null);
const existingInput = ref<HTMLInputElement | null>(null);
const cloneInput = ref<HTMLInputElement | null>(null);
const newFolderInput = ref<HTMLInputElement | null>(null);
useDialog(sheet, () => emit("close"));

const connected = computed(() => props.hosts.filter((h) => h.state === "connected"));
const hostId = ref(connected.value.find((h) => h.id === props.initialHostId)?.id ?? connected.value[0]?.id ?? "");
const mode = ref<"existing" | "clone" | "new">("existing");
const busy = ref(false);
const error = ref("");

// Existing tab state (draft preserved across tab switches)
const cwd = ref("");
const suggestions = ref<{ path: string; name?: string }[]>([]);
const loadingSuggestions = ref(false);

const filteredSuggestions = computed(() => {
  const q = cwd.value.trim().toLowerCase();
  if (!q) return suggestions.value.slice(0, 12);
  return suggestions.value
    .filter((s) => s.path.toLowerCase().includes(q) || (s.name?.toLowerCase().includes(q) ?? false))
    .slice(0, 12);
});

// Clone tab state
const ghQuery = ref("");
const ghRepos = ref<{ fullName: string; description?: string | null; isPrivate?: boolean }[]>([]);
const ghSearching = ref(false);
const selectedRepo = ref("");
const targetDir = ref("");
const targetDirTouched = ref(false);
const cloneProtocol = ref<"https" | "ssh">("ssh");

// New folder tab state
const parentPath = ref("");
const parentPathTouched = ref(false);
const folderName = ref("");

const inferredParent = computed(() => {
  const first = suggestions.value[0]?.path;
  if (!first) return "";
  const idx = first.lastIndexOf("/");
  return idx > 0 ? first.slice(0, idx) : "";
});

let suggestionGeneration = 0;
async function loadSuggestions() {
  const id = hostId.value;
  if (!id) return;
  const gen = ++suggestionGeneration;
  loadingSuggestions.value = true;
  try {
    const res = await props.api(`/hosts/${encodeURIComponent(id)}/project-suggestions`);
    if (gen !== suggestionGeneration || id !== hostId.value) return;
    suggestions.value = (res.suggestions ?? [])
      .map((s: any) => ({
        path: s.path ?? s.rootPath ?? s.cwd ?? "",
        name: s.name ?? s.displayName,
      }))
      .filter((s: { path: string }) => !!s.path);
    if (!parentPathTouched.value) parentPath.value = inferredParent.value;
    if (!targetDirTouched.value && selectedRepo.value && inferredParent.value) {
      const repoName = selectedRepo.value.split("/").pop() || selectedRepo.value;
      targetDir.value = `${inferredParent.value.replace(/\/+$/, "")}/${repoName}`;
    }
  } catch {
    if (gen === suggestionGeneration && id === hostId.value) suggestions.value = [];
  } finally {
    if (gen === suggestionGeneration) loadingSuggestions.value = false;
  }
}

watch(hostId, () => {
  suggestionGeneration++;
  suggestions.value = [];
  if (!parentPathTouched.value) parentPath.value = "";
  if (!targetDirTouched.value) targetDir.value = "";
  void loadSuggestions();
}, { immediate: true });

watch(mode, (m) => {
  error.value = "";
  void nextTick(() => {
    if (m === "existing") existingInput.value?.focus();
    else if (m === "clone") cloneInput.value?.focus();
    else newFolderInput.value?.focus();
  });
});

function onDialogKeydown(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
  if (event.key === "1") {
    event.preventDefault();
    mode.value = "existing";
  } else if (event.key === "2") {
    event.preventDefault();
    mode.value = "clone";
  } else if (event.key === "3") {
    event.preventDefault();
    mode.value = "new";
  }
}

async function addByPath(pathToAdd?: string) {
  const target = (pathToAdd ?? cwd.value).trim();
  if (!hostId.value || !target) return;
  busy.value = true;
  error.value = "";
  try {
    await props.api(`/hosts/${encodeURIComponent(hostId.value)}/projects`, "POST", { cwd: target });
    emit("added", hostId.value, target);
    emit("close");
  } catch (e) {
    error.value = (e as Error).message || "Could not add project.";
  } finally {
    busy.value = false;
  }
}

async function searchGithub() {
  if (!hostId.value || !ghQuery.value.trim()) return;
  ghSearching.value = true;
  error.value = "";
  try {
    const res = await props.api(`/hosts/${encodeURIComponent(hostId.value)}/github/search?q=${encodeURIComponent(ghQuery.value.trim())}`);
    ghRepos.value = (res.repositories ?? [])
      .map((r: any) => ({
        fullName: r.fullName ?? r.nameWithOwner ?? r.repo ?? "",
        description: r.description ?? null,
        isPrivate: r.isPrivate === true || r.private === true,
      }))
      .filter((r: { fullName: string }) => !!r.fullName);
  } catch (e) {
    error.value = (e as Error).message || "Could not search GitHub.";
  } finally {
    ghSearching.value = false;
  }
}

function selectRepo(fullName: string) {
  selectedRepo.value = fullName;
  if (!targetDirTouched.value && inferredParent.value) {
    const repoName = fullName.split("/").pop() || fullName;
    targetDir.value = `${inferredParent.value.replace(/\/+$/, "")}/${repoName}`;
  }
}

async function cloneRepo() {
  if (!hostId.value || !selectedRepo.value.trim() || !targetDir.value.trim()) return;
  busy.value = true;
  error.value = "";
  try {
    const res = await props.api(
      `/hosts/${encodeURIComponent(hostId.value)}/projects/clone`,
      "POST",
      { repo: selectedRepo.value.trim(), targetDirectory: targetDir.value.trim(), cloneProtocol: cloneProtocol.value },
      120_000,
    );
    emit("added", hostId.value, res.path || targetDir.value.trim());
    emit("close");
  } catch (e) {
    error.value = (e as Error).message || "Could not clone repository.";
  } finally {
    busy.value = false;
  }
}

async function createNewFolder() {
  if (!hostId.value || !parentPath.value.trim() || !folderName.value.trim()) return;
  busy.value = true;
  error.value = "";
  try {
    const res = await props.api(
      `/hosts/${encodeURIComponent(hostId.value)}/projects/create-directory`,
      "POST",
      { parentPath: parentPath.value.trim(), name: folderName.value.trim() },
    );
    emit("added", hostId.value, res.path || `${parentPath.value.trim().replace(/\/+$/, "")}/${folderName.value.trim()}`);
    emit("close");
  } catch (e) {
    error.value = (e as Error).message || "Could not create project folder.";
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void nextTick(() => existingInput.value?.focus());
});
</script>

<template>
  <div class="overlay" @mousedown.self="emit('close')">
    <section
      ref="sheet"
      class="sheet add-project-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Add project"
      tabindex="-1"
      @keydown="onDialogKeydown"
    >
      <header class="sheet-head">
        <h2>Add project</h2>
        <button type="button" class="icon-btn" aria-label="Close" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="add-project-body">
        <label v-if="connected.length > 1" class="field">
          <span>Host</span>
          <select v-model="hostId">
            <option v-for="h in connected" :key="h.id" :value="h.id">{{ h.label }}</option>
          </select>
        </label>
        <div class="segmented segmented-sm" role="tablist">
          <button type="button" role="tab" :aria-selected="mode === 'existing'" :class="{ chosen: mode === 'existing' }" @click="mode = 'existing'">Existing</button>
          <button type="button" role="tab" :aria-selected="mode === 'clone'" :class="{ chosen: mode === 'clone' }" @click="mode = 'clone'">Clone</button>
          <button type="button" role="tab" :aria-selected="mode === 'new'" :class="{ chosen: mode === 'new' }" @click="mode = 'new'">New folder</button>
        </div>
        <p v-if="error" class="setting-note is-error" role="alert">{{ error }}</p>

        <template v-if="mode === 'existing'">
          <form class="add-project-form" @submit.prevent="addByPath()">
            <label class="field">
              <span>Directory path or filter recent folders</span>
              <input ref="existingInput" v-model="cwd" placeholder="/home/user/code/my-repo" :disabled="busy" />
            </label>
            <div v-if="filteredSuggestions.length || loadingSuggestions" class="add-project-suggestions">
              <span class="subtle">Recent folders on this host · click to select, then confirm</span>
              <p v-if="loadingSuggestions && !suggestions.length" class="subtle"><span class="spinner spinner-sm"></span> Loading…</p>
              <button
                v-for="s in filteredSuggestions"
                :key="s.path"
                type="button"
                class="suggestion-row"
                :class="{ chosen: cwd.trim() === s.path }"
                :disabled="busy"
                @click="cwd = s.path"
                @dblclick="addByPath(s.path)"
              >
                <Icon name="folder" :size="14" />
                <span class="grow">
                  <span class="row-title">{{ s.name || s.path.split('/').pop() }}</span>
                  <span class="row-sub mono">{{ tildeHome(s.path) }}</span>
                </span>
                <span class="row-sub">{{ cwd.trim() === s.path ? "Selected" : "Select" }}</span>
              </button>
            </div>
            <div class="form-actions">
              <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
              <button type="submit" class="btn btn-primary" :disabled="busy || !cwd.trim()">{{ busy ? "Adding…" : "Add project" }}</button>
            </div>
          </form>
        </template>

        <template v-else-if="mode === 'clone'">
          <form class="archived-search" @submit.prevent="searchGithub">
            <input ref="cloneInput" v-model="ghQuery" placeholder="Search GitHub repos (owner/name or keyword)…" />
            <button type="submit" class="btn btn-sm btn-outline" :disabled="ghSearching || !ghQuery.trim()">{{ ghSearching ? "Searching…" : "Search" }}</button>
          </form>
          <div v-if="ghRepos.length" class="add-project-suggestions">
            <button
              v-for="r in ghRepos"
              :key="r.fullName"
              type="button"
              class="suggestion-row"
              :class="{ chosen: selectedRepo === r.fullName }"
              @click="selectRepo(r.fullName)"
            >
              <Icon name="branch" :size="14" />
              <span class="grow">
                <span class="row-title">{{ r.fullName }} <small v-if="r.isPrivate" class="hs-tag">private</small></span>
                <span v-if="r.description" class="row-sub">{{ r.description }}</span>
              </span>
            </button>
          </div>
          <form class="add-project-form" @submit.prevent="cloneRepo">
            <label class="field">
              <span>Repository (owner/repo)</span>
              <input v-model="selectedRepo" placeholder="owner/repo" :disabled="busy" />
            </label>
            <label class="field">
              <span>Target directory on host</span>
              <input v-model="targetDir" placeholder="/home/user/code/repo" :disabled="busy" @input="targetDirTouched = true" />
            </label>
            <div class="segmented segmented-sm">
              <button type="button" :class="{ chosen: cloneProtocol === 'ssh' }" @click="cloneProtocol = 'ssh'">SSH</button>
              <button type="button" :class="{ chosen: cloneProtocol === 'https' }" @click="cloneProtocol = 'https'">HTTPS</button>
            </div>
            <div class="form-actions">
              <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
              <button type="submit" class="btn btn-primary" :disabled="busy || !selectedRepo.trim() || !targetDir.trim()">{{ busy ? "Cloning…" : "Clone & add" }}</button>
            </div>
          </form>
        </template>

        <template v-else>
          <form class="add-project-form" @submit.prevent="createNewFolder">
            <label class="field">
              <span>Parent directory on host</span>
              <input v-model="parentPath" placeholder="/home/user/code" :disabled="busy" @input="parentPathTouched = true" />
            </label>
            <label class="field">
              <span>New folder name</span>
              <input ref="newFolderInput" v-model="folderName" placeholder="my-new-project" :disabled="busy" />
            </label>
            <p v-if="parentPath.trim() && folderName.trim()" class="row-sub mono">
              Will create: {{ tildeHome(parentPath.trim().replace(/\/+$/, "") + "/" + folderName.trim()) }}
            </p>
            <div class="form-actions">
              <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
              <button type="submit" class="btn btn-primary" :disabled="busy || !parentPath.trim() || !folderName.trim()">{{ busy ? "Creating…" : "Create & add" }}</button>
            </div>
          </form>
        </template>
      </div>
    </section>
  </div>
</template>
