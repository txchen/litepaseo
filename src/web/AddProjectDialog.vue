<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
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
useDialog(sheet, () => emit("close"));

const connected = computed(() => props.hosts.filter((h) => h.state === "connected"));
const hostId = ref(connected.value.find((h) => h.id === props.initialHostId)?.id ?? connected.value[0]?.id ?? "");
const mode = ref<"path" | "github">("path");
const cwd = ref("");
const suggestions = ref<{ path: string; name?: string }[]>([]);
const loadingSuggestions = ref(false);
const busy = ref(false);
const error = ref("");

// GitHub clone state
const ghQuery = ref("");
const ghRepos = ref<{ fullName: string; description?: string | null; isPrivate?: boolean }[]>([]);
const ghSearching = ref(false);
const selectedRepo = ref("");
const targetDir = ref("");
const cloneProtocol = ref<"https" | "ssh">("ssh");

async function loadSuggestions() {
  if (!hostId.value) return;
  loadingSuggestions.value = true;
  try {
    const res = await props.api(`/hosts/${encodeURIComponent(hostId.value)}/project-suggestions`);
    suggestions.value = (res.suggestions ?? []).map((s: any) => ({
      path: s.path ?? s.rootPath ?? s.cwd ?? "",
      name: s.name ?? s.displayName,
    })).filter((s: { path: string }) => !!s.path);
  } catch {
    suggestions.value = [];
  } finally {
    loadingSuggestions.value = false;
  }
}

watch(hostId, () => {
  suggestions.value = [];
  void loadSuggestions();
}, { immediate: true });

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
    ghRepos.value = (res.repositories ?? []).map((r: any) => ({
      fullName: r.fullName ?? r.nameWithOwner ?? r.repo ?? "",
      description: r.description ?? null,
      isPrivate: r.isPrivate === true || r.private === true,
    })).filter((r: { fullName: string }) => !!r.fullName);
  } catch (e) {
    error.value = (e as Error).message || "Could not search GitHub.";
  } finally {
    ghSearching.value = false;
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

onMounted(() => void loadSuggestions());
</script>

<template>
  <div class="overlay" @mousedown.self="emit('close')">
    <section ref="sheet" class="sheet add-project-sheet" role="dialog" aria-modal="true" aria-label="Add project" tabindex="-1">
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
          <button type="button" role="tab" :aria-selected="mode === 'path'" :class="{ chosen: mode === 'path' }" @click="mode = 'path'">Host directory</button>
          <button type="button" role="tab" :aria-selected="mode === 'github'" :class="{ chosen: mode === 'github' }" @click="mode = 'github'">Clone from GitHub</button>
        </div>
        <p v-if="error" class="setting-note is-error" role="alert">{{ error }}</p>

        <template v-if="mode === 'path'">
          <form class="add-project-form" @submit.prevent="addByPath()">
            <label class="field">
              <span>Directory path on host</span>
              <input v-model="cwd" placeholder="/home/user/code/my-repo" :disabled="busy" autofocus />
            </label>
            <div class="form-actions">
              <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
              <button type="submit" class="btn btn-primary" :disabled="busy || !cwd.trim()">{{ busy ? "Adding…" : "Add project" }}</button>
            </div>
          </form>
          <div v-if="suggestions.length || loadingSuggestions" class="add-project-suggestions">
            <span class="subtle">Recent repositories on this host</span>
            <p v-if="loadingSuggestions && !suggestions.length" class="subtle"><span class="spinner spinner-sm"></span> Loading…</p>
            <button
              v-for="s in suggestions.slice(0, 10)"
              :key="s.path"
              type="button"
              class="suggestion-row"
              :disabled="busy"
              @click="addByPath(s.path)"
            >
              <Icon name="folder" :size="14" />
              <span class="grow">
                <span class="row-title">{{ s.name || s.path.split('/').pop() }}</span>
                <span class="row-sub mono">{{ tildeHome(s.path) }}</span>
              </span>
              <span class="row-sub">Add</span>
            </button>
          </div>
        </template>

        <template v-else>
          <form class="archived-search" @submit.prevent="searchGithub">
            <input v-model="ghQuery" placeholder="Search GitHub repos (owner/name or keyword)…" />
            <button type="submit" class="btn btn-sm btn-outline" :disabled="ghSearching || !ghQuery.trim()">{{ ghSearching ? "Searching…" : "Search" }}</button>
          </form>
          <div v-if="ghRepos.length" class="add-project-suggestions">
            <button
              v-for="r in ghRepos"
              :key="r.fullName"
              type="button"
              class="suggestion-row"
              :class="{ chosen: selectedRepo === r.fullName }"
              @click="selectedRepo = r.fullName"
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
              <input v-model="targetDir" placeholder="/home/user/code/repo" :disabled="busy" />
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
      </div>
    </section>
  </div>
</template>
