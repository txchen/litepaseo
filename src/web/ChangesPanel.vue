<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import Icon from "./Icon.vue";

interface ReviewComment {
  id: string;
  path: string;
  line: string;
  text: string;
}

const props = defineProps<{
  hostId: string;
  cwd: string;
  workspaceId?: string | null;
  api: (path: string, method?: string, body?: unknown, timeoutMs?: number) => Promise<any>;
}>();
const emit = defineEmits<{
  sendReview: [prompt: string];
}>();

const view = ref<"diff" | "commits">("diff");
const compareMode = ref<"uncommitted" | "base">("uncommitted");
const baseRef = ref("");
const editingBase = ref(false);
const baseDraft = ref("");

const files = ref<any[]>([]);
const error = ref("");
const notice = ref("");
const busy = ref(false);
const truncated = ref(false);
let generation = 0;
const expanded = ref(new Set<string>());

// Commits & commit file diff
const commits = ref<any[]>([]);
const commitsLoading = ref(false);
const commitDiffs = ref<Record<string, any>>({});
const expandedCommitFiles = ref(new Set<string>());
const MAX_COMMIT_DIFF_CACHE = 30;

// PR & Git actions
const prStatus = ref<any>(null);
const gitBusy = ref(false);
const commitOpen = ref(false);
const commitMsg = ref("");
const prOpen = ref(false);
const prTitle = ref("");
const prBody = ref("");

// Inline review comments (#3)
const comments = ref<ReviewComment[]>([]);
const activeCommentKey = ref<string | null>(null);
const commentDraft = ref("");
let commentSeq = 0;

let contextGeneration = 0;
onUnmounted(() => {
  generation++;
  contextGeneration++;
});

const hostBase = () => `/hosts/${encodeURIComponent(props.hostId)}`;

async function load() {
  const current = ++generation;
  busy.value = true;
  error.value = "";
  files.value = [];
  truncated.value = false;
  expanded.value = new Set();
  try {
    const qs = new URLSearchParams({ cwd: props.cwd, mode: compareMode.value });
    if (compareMode.value === "base" && baseRef.value.trim()) qs.set("baseRef", baseRef.value.trim());
    const result = await props.api(`${hostBase()}/changes?${qs}`);
    if (current !== generation) return;
    files.value = result.files ?? [];
    truncated.value = !!result.diffTooLarge;
    if (result.baseRef && !baseRef.value) baseRef.value = result.baseRef;
  } catch (e) {
    if (current === generation) error.value = (e as Error).message;
  } finally {
    if (current === generation) busy.value = false;
  }
}

async function loadPrStatus() {
  const ctx = contextGeneration;
  try {
    const res = await props.api(`${hostBase()}/git/pr-status?cwd=${encodeURIComponent(props.cwd)}`);
    if (ctx === contextGeneration) prStatus.value = res;
  } catch {
    if (ctx === contextGeneration) prStatus.value = null;
  }
}

async function loadCommits() {
  const ctx = contextGeneration;
  commitsLoading.value = true;
  error.value = "";
  try {
    const res = await props.api(`${hostBase()}/git/commits?cwd=${encodeURIComponent(props.cwd)}`);
    if (ctx !== contextGeneration) return;
    commits.value = res.commits ?? [];
    if (res.baseRef && !baseRef.value) baseRef.value = res.baseRef;
  } catch (e) {
    if (ctx === contextGeneration) error.value = (e as Error).message;
  } finally {
    if (ctx === contextGeneration) commitsLoading.value = false;
  }
}

function pruneCommitDiffCache() {
  const keys = Object.keys(commitDiffs.value);
  if (keys.length <= MAX_COMMIT_DIFF_CACHE) return;
  for (const k of keys) {
    if (Object.keys(commitDiffs.value).length <= MAX_COMMIT_DIFF_CACHE) break;
    if (!expandedCommitFiles.value.has(k)) delete commitDiffs.value[k];
  }
}
async function loadCommitFile(sha: string, filePath: string) {
  const ctx = contextGeneration;
  const key = `${sha}:${filePath}`;
  if (commitDiffs.value[key]) return;
  try {
    const res = await props.api(
      `${hostBase()}/git/commit-diff?cwd=${encodeURIComponent(props.cwd)}&sha=${encodeURIComponent(sha)}&path=${encodeURIComponent(filePath)}`,
    );
    if (ctx !== contextGeneration) return;
    commitDiffs.value[key] = res.file ?? { status: "empty", hunks: [] };
    pruneCommitDiffCache();
  } catch (e) {
    if (ctx === contextGeneration) commitDiffs.value[key] = { error: (e as Error).message };
  }
}
function toggleCommitFile(sha: string, filePath: string, open: boolean) {
  const key = `${sha}:${filePath}`;
  const next = new Set(expandedCommitFiles.value);
  if (open) {
    next.add(key);
    expandedCommitFiles.value = next;
    void loadCommitFile(sha, filePath);
  } else {
    next.delete(key);
    expandedCommitFiles.value = next;
    pruneCommitDiffCache();
  }
}

async function saveBaseBranch() {
  const next = baseDraft.value.trim();
  if (!next) return;
  editingBase.value = false;
  baseRef.value = next;
  if (props.workspaceId) {
    try {
      await props.api(`${hostBase()}/workspaces/${encodeURIComponent(props.workspaceId)}/base-branch`, "POST", { baseRef: next });
    } catch {
      // Still apply locally to diff compare.
    }
  }
  if (compareMode.value === "base") void load();
}

async function doCommit() {
  gitBusy.value = true;
  error.value = notice.value = "";
  try {
    await props.api(`${hostBase()}/git/commit`, "POST", { cwd: props.cwd, message: commitMsg.value.trim() || undefined, addAll: true }, 60_000);
    commitMsg.value = "";
    commitOpen.value = false;
    notice.value = "Committed changes.";
    await Promise.all([load(), loadPrStatus(), view.value === "commits" ? loadCommits() : Promise.resolve()]);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    gitBusy.value = false;
  }
}

async function doPush() {
  gitBusy.value = true;
  error.value = notice.value = "";
  try {
    await props.api(`${hostBase()}/git/push`, "POST", { cwd: props.cwd }, 60_000);
    notice.value = "Pushed to remote.";
    await loadPrStatus();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    gitBusy.value = false;
  }
}

async function doCreatePr() {
  gitBusy.value = true;
  error.value = notice.value = "";
  try {
    const res = await props.api(
      `${hostBase()}/git/pr`,
      "POST",
      { cwd: props.cwd, title: prTitle.value.trim() || undefined, body: prBody.value.trim() || undefined, baseRef: baseRef.value.trim() || undefined },
      60_000,
    );
    prOpen.value = false;
    prTitle.value = prBody.value = "";
    notice.value = res.url ? `PR created: ${res.url}` : "PR created.";
    await loadPrStatus();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    gitBusy.value = false;
  }
}

async function copy(path: string) {
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    error.value = "Could not copy path.";
  }
}

// ---- Review comments ---------------------------------------------------------------------------
function openComment(filePath: string, lineLabel: string) {
  const key = `${filePath}::${lineLabel}`;
  if (activeCommentKey.value === key) {
    activeCommentKey.value = null;
    return;
  }
  activeCommentKey.value = key;
  commentDraft.value = "";
}
function addComment(filePath: string, lineLabel: string) {
  const text = commentDraft.value.trim();
  if (!text) return;
  comments.value.push({ id: `c-${++commentSeq}`, path: filePath, line: lineLabel, text });
  commentDraft.value = "";
  activeCommentKey.value = null;
}
function removeComment(id: string) {
  comments.value = comments.value.filter((c) => c.id !== id);
}
function sendAllReviews() {
  if (!comments.value.length) return;
  const lines = [
    "Please address the following code review comments:",
    "",
    ...comments.value.map((c, i) => `${i + 1}. \`${c.path}\` (${c.line}): ${c.text}`),
  ];
  emit("sendReview", lines.join("\n"));
  comments.value = [];
}

const prInfo = computed(() => {
  const p = prStatus.value;
  if (!p || !p.pr) return null;
  const checks = Array.isArray(p.checks) ? p.checks : [];
  const failed = checks.filter((c: any) => c.conclusion === "failure" || c.state === "failure").length;
  const pending = checks.filter((c: any) => c.status === "in_progress" || c.status === "queued" || c.state === "pending").length;
  const passed = checks.length - failed - pending;
  return { pr: p.pr, checksCount: checks.length, failed, pending, passed };
});

watch(() => [props.hostId, props.cwd], () => {
  contextGeneration++;
  files.value = [];
  commits.value = [];
  commitDiffs.value = {};
  expandedCommitFiles.value = new Set();
  comments.value = [];
  prStatus.value = null;
  baseRef.value = "";
  editingBase.value = false;
  baseDraft.value = "";
  commitOpen.value = false;
  commitMsg.value = "";
  prOpen.value = false;
  prTitle.value = "";
  prBody.value = "";
  activeCommentKey.value = null;
  commentDraft.value = "";
  error.value = "";
  notice.value = "";
  void load();
  void loadPrStatus();
  if (view.value === "commits") void loadCommits();
}, { immediate: true });

watch(compareMode, () => {
  if (view.value === "diff") void load();
});
watch(view, (v) => {
  if (v === "commits") {
    if (!commits.value.length) void loadCommits();
  } else {
    expandedCommitFiles.value = new Set();
    pruneCommitDiffCache();
  }
});
</script>

<template>
  <section class="changes-panel">
    <div class="changes-top">
      <div class="segmented segmented-sm" role="tablist">
        <button type="button" role="tab" :aria-selected="view === 'diff'" :class="{ chosen: view === 'diff' }" @click="view = 'diff'">Diff</button>
        <button type="button" role="tab" :aria-selected="view === 'commits'" :class="{ chosen: view === 'commits' }" @click="view = 'commits'">Commits</button>
      </div>
      <div v-if="view === 'diff'" class="segmented segmented-sm" role="radiogroup" aria-label="Compare mode">
        <button type="button" :class="{ chosen: compareMode === 'uncommitted' }" @click="compareMode = 'uncommitted'">Uncommitted</button>
        <button type="button" :class="{ chosen: compareMode === 'base' }" @click="compareMode = 'base'">vs {{ baseRef || "Base" }}</button>
      </div>
      <button type="button" class="icon-btn" :disabled="busy || commitsLoading" title="Refresh" aria-label="Refresh changes" @click="view === 'diff' ? load() : loadCommits(); loadPrStatus()">
        <Icon name="refresh" :size="14" />
      </button>
    </div>

    <div v-if="view === 'diff' && compareMode === 'base'" class="base-bar">
      <template v-if="editingBase">
        <input v-model="baseDraft" placeholder="main" aria-label="Base branch" @keydown.enter.prevent="saveBaseBranch" />
        <button type="button" class="btn btn-sm btn-primary" @click="saveBaseBranch">Set</button>
        <button type="button" class="btn btn-sm btn-ghost" @click="editingBase = false">Cancel</button>
      </template>
      <template v-else>
        <span class="row-sub">Base: <code>{{ baseRef || "default" }}</code></span>
        <button type="button" class="link-btn" @click="baseDraft = baseRef; editingBase = true">Change base</button>
      </template>
    </div>

    <div v-if="prInfo" class="pr-bar">
      <a :href="prInfo.pr.url" target="_blank" rel="noopener noreferrer" class="pr-link">
        <Icon name="branch" :size="13" />
        <strong>#{{ prInfo.pr.number }}</strong>
        <span class="pr-title">{{ prInfo.pr.title }}</span>
        <Icon name="external" :size="12" />
      </a>
      <span v-if="prInfo.checksCount" class="pr-checks" :class="prInfo.failed ? 'is-danger' : prInfo.pending ? 'is-warn' : 'is-ok'">
        {{ prInfo.failed ? `${prInfo.failed} failed` : prInfo.pending ? `${prInfo.pending} running` : `${prInfo.passed} passed` }}
      </span>
    </div>

    <div class="git-actions">
      <button type="button" class="btn btn-sm btn-outline" :disabled="gitBusy" @click="commitOpen = !commitOpen; prOpen = false">Commit</button>
      <button type="button" class="btn btn-sm btn-outline" :disabled="gitBusy" @click="doPush">{{ gitBusy ? "Working…" : "Push" }}</button>
      <button v-if="!prInfo" type="button" class="btn btn-sm btn-outline" :disabled="gitBusy" @click="prOpen = !prOpen; commitOpen = false">Create PR</button>
    </div>

    <form v-if="commitOpen" class="git-form" @submit.prevent="doCommit">
      <textarea v-model="commitMsg" rows="2" placeholder="Commit message (leave blank to auto-generate)" :disabled="gitBusy"></textarea>
      <div class="form-actions">
        <button type="button" class="btn btn-sm btn-ghost" @click="commitOpen = false">Cancel</button>
        <button type="submit" class="btn btn-sm btn-primary" :disabled="gitBusy">{{ gitBusy ? "Committing…" : "Commit all" }}</button>
      </div>
    </form>

    <form v-if="prOpen" class="git-form" @submit.prevent="doCreatePr">
      <input v-model="prTitle" placeholder="PR title (leave blank to auto-generate)" :disabled="gitBusy" />
      <textarea v-model="prBody" rows="2" placeholder="PR description (optional)" :disabled="gitBusy"></textarea>
      <div class="form-actions">
        <button type="button" class="btn btn-sm btn-ghost" @click="prOpen = false">Cancel</button>
        <button type="submit" class="btn btn-sm btn-primary" :disabled="gitBusy">{{ gitBusy ? "Creating…" : "Create PR" }}</button>
      </div>
    </form>

    <p v-if="notice" class="setting-note" role="status">{{ notice }}</p>
    <p v-if="error" class="setting-note is-error" role="alert">{{ error }}</p>

    <div v-if="comments.length" class="review-tray" role="region" aria-label="Pending review comments">
      <div class="review-tray-head">
        <strong>{{ comments.length }} review {{ comments.length === 1 ? "comment" : "comments" }}</strong>
        <button type="button" class="btn btn-sm btn-primary" @click="sendAllReviews">Send to agent</button>
      </div>
      <div v-for="c in comments" :key="c.id" class="review-chip">
        <span class="grow"><code>{{ c.path }}:{{ c.line }}</code> — {{ c.text }}</span>
        <button type="button" class="icon-btn" aria-label="Remove comment" @click="removeComment(c.id)"><Icon name="close" :size="12" /></button>
      </div>
    </div>

    <template v-if="view === 'diff'">
      <p v-if="truncated" class="row-sub">Diff exceeds the host limit; some changes are omitted.</p>
      <p v-if="!busy && !error && !files.length" class="row-sub">No {{ compareMode === "uncommitted" ? "uncommitted " : "" }}changes.</p>
      <details v-for="file in files" :key="file.path" @toggle="($event.target as HTMLDetailsElement).open ? expanded.add(file.path) : expanded.delete(file.path)">
        <summary>
          <span class="file-sum-path">{{ file.oldPath ? file.oldPath + " → " : "" }}{{ file.path }}</span>
          <span class="file-sum-stat"><em class="stat-add">+{{ file.additions }}</em> <em class="stat-del">−{{ file.deletions }}</em></span>
        </summary>
        <div class="file-bar">
          <button type="button" class="link-btn" @click="copy(file.path)">Copy path</button>
          <button type="button" class="link-btn" @click="openComment(file.path, 'file')">+ Comment on file</button>
        </div>
        <form v-if="activeCommentKey === file.path + '::file'" class="review-form" @submit.prevent="addComment(file.path, 'file')">
          <textarea v-model="commentDraft" rows="2" placeholder="Write review comment for this file…"></textarea>
          <div class="form-actions">
            <button type="button" class="btn btn-sm btn-ghost" @click="activeCommentKey = null">Cancel</button>
            <button type="submit" class="btn btn-sm btn-primary" :disabled="!commentDraft.trim()">Add comment</button>
          </div>
        </form>
        <p v-if="file.status === 'binary'" class="row-sub">Binary file changed.</p>
        <p v-else-if="file.status === 'too_large'" class="row-sub">File diff is too large to display.</p>
        <template v-if="expanded.has(file.path)">
          <div v-for="(hunk, i) in file.hunks" :key="i" class="diff-hunk-block">
            <div class="hunk">@@ −{{ hunk.oldStart }},{{ hunk.oldCount }} +{{ hunk.newStart }},{{ hunk.newCount }} @@</div>
            <template v-for="(line, j) in hunk.lines" :key="j">
              <div class="diff-line" :class="line.type">
                <button
                  type="button"
                  class="diff-comment-btn"
                  title="Add review comment on this line"
                  aria-label="Add review comment"
                  @click="openComment(file.path, `L${line.newLineNumber ?? line.oldLineNumber ?? (hunk.newStart + j)}`)"
                >+</button>
                <span class="diff-code">{{ line.type === "add" ? "+" : line.type === "remove" ? "−" : " " }}{{ line.content }}</span>
              </div>
              <form
                v-if="activeCommentKey === `${file.path}::L${line.newLineNumber ?? line.oldLineNumber ?? (hunk.newStart + j)}`"
                class="review-form"
                @submit.prevent="addComment(file.path, `L${line.newLineNumber ?? line.oldLineNumber ?? (hunk.newStart + j)}`)"
              >
                <textarea v-model="commentDraft" rows="2" placeholder="Write review comment on this line…"></textarea>
                <div class="form-actions">
                  <button type="button" class="btn btn-sm btn-ghost" @click="activeCommentKey = null">Cancel</button>
                  <button type="submit" class="btn btn-sm btn-primary" :disabled="!commentDraft.trim()">Add comment</button>
                </div>
              </form>
            </template>
          </div>
        </template>
      </details>
    </template>

    <template v-else>
      <p v-if="commitsLoading && !commits.length" class="row-sub">Loading commits…</p>
      <p v-else-if="!commits.length" class="row-sub">No commits found.</p>
      <details v-for="c in commits" :key="c.sha" class="commit-item">
        <summary>
          <code class="commit-sha">{{ c.shortSha }}</code>
          <span class="commit-subj">{{ c.subject }}</span>
          <span v-if="!c.isOnRemote" class="hs-tag">unpushed</span>
        </summary>
        <p class="row-sub">{{ c.authorName }} · {{ new Date(c.authorDate).toLocaleString() }}</p>
        <details
          v-for="cf in c.files ?? []"
          :key="cf.path"
          class="commit-file"
          @toggle="toggleCommitFile(c.sha, cf.path, ($event.target as HTMLDetailsElement).open)"
        >
          <summary>{{ cf.path }} <span class="file-sum-stat"><em class="stat-add">+{{ cf.additions ?? 0 }}</em> <em class="stat-del">−{{ cf.deletions ?? 0 }}</em></span></summary>
          <template v-if="expandedCommitFiles.has(c.sha + ':' + cf.path)">
            <p v-if="!commitDiffs[c.sha + ':' + cf.path]" class="row-sub">Loading diff…</p>
            <p v-else-if="commitDiffs[c.sha + ':' + cf.path].error" class="setting-note is-error">{{ commitDiffs[c.sha + ':' + cf.path].error }}</p>
            <pre v-else v-for="(hunk, hi) in commitDiffs[c.sha + ':' + cf.path].hunks ?? []" :key="hi"><code><span class="hunk">@@ −{{ hunk.oldStart }},{{ hunk.oldCount }} +{{ hunk.newStart }},{{ hunk.newCount }} @@
</span><span v-for="(line, lj) in hunk.lines" :key="lj" :class="line.type">{{ line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' ' }}{{ line.content }}</span></code></pre>
          </template>
        </details>
      </details>
    </template>
  </section>
</template>

<style scoped>
.changes-panel { padding: 12px; overflow: auto; height: 100%; font-size: 13px; display: flex; flex-direction: column; gap: 8px; }
.changes-top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.base-bar, .git-actions, .file-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.base-bar input { max-width: 150px; padding: 3px 8px; font-size: 12px; }
.pr-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-1); }
.pr-link { display: inline-flex; align-items: center; gap: 5px; color: var(--fg); text-decoration: none; min-width: 0; flex: 1; }
.pr-link:hover { color: var(--accent); }
.pr-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-checks { font-size: 11px; padding: 1px 6px; border-radius: 999px; flex-shrink: 0; }
.pr-checks.is-ok { background: color-mix(in srgb, var(--unread) 16%, transparent); color: var(--unread); }
.pr-checks.is-warn { background: var(--warn-soft); color: var(--warn); }
.pr-checks.is-danger { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--danger); }
.git-form, .review-form { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-1); }
.review-tray { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 1px solid var(--accent); border-radius: 10px; background: var(--accent-soft); }
.review-tray-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.review-chip { display: flex; align-items: center; gap: 6px; font-size: 12px; }
details { border-top: 1px solid var(--border); padding-top: 8px; }
summary { cursor: pointer; display: flex; align-items: baseline; gap: 6px; overflow-wrap: anywhere; }
.file-sum-path { flex: 1; min-width: 0; }
.file-sum-stat { font-family: var(--mono); font-size: 11.5px; flex-shrink: 0; }
.stat-add { color: var(--unread); font-style: normal; }
.stat-del { color: var(--danger); font-style: normal; }
.diff-hunk-block { margin-top: 6px; overflow-x: auto; font-family: var(--mono); font-size: 12px; }
.diff-line { display: flex; align-items: flex-start; white-space: pre; }
.diff-comment-btn { width: 18px; min-width: 18px; border: 0; background: transparent; color: var(--fg-faint); cursor: pointer; font-family: var(--mono); padding: 0; opacity: 0.35; }
.diff-line:hover .diff-comment-btn, .diff-comment-btn:focus-visible { opacity: 1; color: var(--accent); }
.diff-code { flex: 1; }
.add { background: #22884422; }
.remove { background: #cc333322; }
.hunk { color: var(--fg-muted); font-family: var(--mono); font-size: 11.5px; }
pre { overflow: auto; font-size: 12px; margin: 4px 0; }
code span { display: block; white-space: pre; }
.commit-sha { font-size: 11.5px; color: var(--accent); }
.commit-subj { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.commit-file { margin-left: 10px; border-top: 0; padding-top: 4px; }
</style>
