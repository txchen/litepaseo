<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
const props = defineProps<{ hostId: string; cwd: string; api: (path: string) => Promise<any> }>();
const files = ref<any[]>([]), error = ref(""), busy = ref(false), truncated = ref(false);
let generation = 0;
const expanded = ref(new Set<string>());
onUnmounted(() => generation++);
async function load() {
  const current = ++generation; busy.value = true; error.value = ""; files.value = []; truncated.value = false; expanded.value = new Set();
  try {
    const result = await props.api(`/hosts/${encodeURIComponent(props.hostId)}/changes?cwd=${encodeURIComponent(props.cwd)}`);
    if (current !== generation) return;
    files.value = result.files; truncated.value = !!result.diffTooLarge;
  } catch (e) { if (current === generation) error.value = (e as Error).message; }
  finally { if (current === generation) busy.value = false; }
}
async function copy(path: string) { try { await navigator.clipboard.writeText(path); } catch { error.value = "Could not copy path."; } }
watch(() => [props.hostId, props.cwd], () => { files.value = []; void load(); }, { immediate: true });
</script>
<template>
  <section class="changes-panel">
    <p>Workspace uncommitted changes · includes changes from all contributors.</p>
    <button class="btn" :disabled="busy" @click="load">{{ busy ? 'Loading…' : 'Refresh changes' }}</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="truncated">Diff exceeds the host limit; some changes are omitted.</p>
    <p v-if="!busy && !error && !files.length">No uncommitted changes.</p>
    <details v-for="file in files" :key="file.path" @toggle="($event.target as HTMLDetailsElement).open ? expanded.add(file.path) : expanded.delete(file.path)">
      <summary>{{ file.oldPath ? file.oldPath + ' → ' : '' }}{{ file.path }} <span>+{{ file.additions }} −{{ file.deletions }}</span></summary>
      <button class="btn btn-ghost" @click="copy(file.path)">Copy path</button>
      <p v-if="file.status === 'binary'">Binary file changed.</p>
      <p v-else-if="file.status === 'too_large'">File diff is too large to display.</p>
      <template v-if="expanded.has(file.path)">
      <pre v-for="(hunk, i) in file.hunks" :key="i"><code><span class="hunk">@@ −{{ hunk.oldStart }},{{ hunk.oldCount }} +{{ hunk.newStart }},{{ hunk.newCount }} @@
</span><span v-for="(line, j) in hunk.lines" :key="j" :class="line.type">{{ line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' ' }}{{ line.content }}</span></code></pre>
      </template>
    </details>
  </section>
</template>
<style scoped>
.changes-panel { padding: 12px; overflow: auto; height: 100%; font-size: 13px; }
details { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 8px; }
summary { cursor: pointer; overflow-wrap: anywhere; }
pre { overflow: auto; font-size: 12px; } code span { display: block; white-space: pre; }
.add { background: #22884422; } .remove { background: #cc333322; } .hunk { color: var(--fg-muted); }
</style>
