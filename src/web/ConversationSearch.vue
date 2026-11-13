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
  <p>Search user and agent messages across the full conversation history. Select a result to read it in context.</p>
  <form @submit.prevent="search(false)"><input v-model="query" type="search" maxlength="500" aria-label="Search conversation content" placeholder="Search all messages…"><button class="btn" :disabled="busy || !query.trim()">Search</button></form>
  <p v-if="error" role="alert">{{ error }}</p>
  <p v-if="searched && !results.length && !busy">No matching messages.</p>
  <p v-if="busy">Searching…</p>
  <button v-for="r in results" :key="r.seq" class="btn result" @click="emit('jump', r.seq, epoch)">{{ r.role === 'assistant' ? 'Agent reply' : 'Your message' }} · #{{ r.seq }}{{ r.count ? ` · ${r.count} matches` : '' }} →</button>
  <button v-if="cursor !== null" class="btn" :disabled="busy" @click="search(true)">More results</button>
</section>
</template>
<style scoped>
.conversation-search { padding: 12px; overflow: auto; } form { display: flex; gap: 6px; } input { min-width: 0; width: 100%; } .result { display: block; margin: 8px 0; text-align: left; width: 100%; }
</style>
