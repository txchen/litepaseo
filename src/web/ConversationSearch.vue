<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
const props = defineProps<{ base: string; api: (path: string) => Promise<any> }>();
const emit = defineEmits<{ jump: [seq: number, epoch: string] }>();
const query = ref(""), error = ref(""), busy = ref(false), searched = ref(false);
const results = ref<{seq: number; role: string; count?: number}[]>([]), cursor = ref<number | null>(null), epoch = ref("");
let generation = 0, submitted = "";
onUnmounted(() => generation++);
function reset() { generation++; results.value = []; cursor.value = null; searched.value = false; busy.value = false; error.value = ""; }
watch(query, reset);
watch(() => props.base, () => { query.value = ""; reset(); });
async function search(more = false) {
  if (busy.value || !query.value.trim()) return;
  const current = ++generation;
  if (!more) { results.value = []; cursor.value = null; submitted = query.value.trim(); }
  busy.value = true; error.value = "";
  try {
    const data = await props.api(props.base + '/search?q=' + encodeURIComponent(submitted) + (more && cursor.value !== null ? '&cursor=' + cursor.value : ''));
    if (current !== generation) return;
    if (more && epoch.value !== data.epoch) throw new Error('Conversation changed. Search again.');
    epoch.value = data.epoch;
    results.value = [...new Map((more ? [...results.value, ...data.locations] : data.locations).map((r: {seq: number; role: string; count?: number}) => [r.seq, r])).values()] as typeof results.value;
    cursor.value = data.nextCursor; searched.value = true;
  } catch (e) { if (current === generation) error.value = (e as Error).message; }
  finally { if (current === generation) busy.value = false; }
}
</script>
<template>
<section class="conversation-search">
  <p class="subtle small search-intro">Search user and agent messages across the full conversation history. Select a result to read it in context.</p>
  <form class="search-form" role="search" @submit.prevent="search(false)">
    <input v-model="query" type="search" maxlength="500" aria-label="Search conversation content" placeholder="Search all messages…">
    <button class="btn btn-primary btn-sm" :disabled="busy || !query.trim()">Search</button>
  </form>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <p v-if="searched && !results.length && !busy" class="subtle small" role="status">No matching messages.</p>
  <p v-if="busy" class="subtle small" role="status">Searching…</p>
  <ul v-if="results.length" class="search-results" aria-label="Search results">
    <li v-for="r in results" :key="r.seq">
      <button type="button" class="search-result" @click="emit('jump', r.seq, epoch)">
        <span class="search-result-role">{{ r.role === 'assistant' ? 'Agent reply' : 'Your message' }}</span> <span class="search-result-meta">#{{ r.seq }}{{ r.count ? ` · ${r.count} matches` : '' }}</span> <span class="search-result-go" aria-hidden="true">→</span>
      </button>
    </li>
  </ul>
  <button v-if="cursor !== null" type="button" class="btn btn-outline btn-sm search-more" :disabled="busy" @click="search(true)">More results</button>
</section>
</template>
<style scoped>
.conversation-search { display: grid; gap: 10px; align-content: start; padding: 12px; overflow: auto; }
.search-intro, .conversation-search .form-error { margin: 0; }
.conversation-search > p { margin: 0; }
.search-form { display: flex; gap: 6px; align-items: center; }
.search-form input { min-width: 0; width: 100%; }
.search-form .btn { flex: none; height: 32px; }
.search-results { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.search-result { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border-radius: var(--radius-sm); text-align: left; font-size: 13px; }
.search-result-meta { color: var(--fg-muted); font-size: 12px; }
.search-result-go { margin-left: auto; color: var(--fg-faint); }
.search-more { justify-self: start; }
@media (hover: hover) {
  .search-result:hover { background: var(--hover); }
  .search-result:hover .search-result-go { color: var(--fg); }
}
</style>
