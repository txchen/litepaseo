<script lang="ts">
import { ref } from "vue";

/** Icon URLs that failed (no icon on the host): shared, so remounted rows do not ask again. */
const failed = ref(new Set<string>());
const TILE_COLORS = ["#4f7cc2", "#5a9e6f", "#c27a4f", "#9a6fc2", "#c25a7a", "#4fa7b0", "#b09a3f"];
export const tileColor = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TILE_COLORS[h % TILE_COLORS.length];
};
export const initial = (name: string) => (Array.from(name.trim())[0] ?? "?").toUpperCase();

export interface ProjectIconSource {
  hostId: string;
  rootPath: string;
  projectId?: string;
  projectIconRevision?: string | null;
}
/** The daemon's effective icon (custom or found in the project root); the revision busts caches. */
export function projectIconUrl(p: ProjectIconSource) {
  if (!p.rootPath) return null;
  let url = `/api/hosts/${encodeURIComponent(p.hostId)}/project-icon?cwd=${encodeURIComponent(p.rootPath)}`;
  if (p.projectId) url += `&project=${encodeURIComponent(p.projectId)}&v=${encodeURIComponent(p.projectIconRevision ?? "")}`;
  return url;
}
</script>

<script setup lang="ts">
import { computed } from "vue";

// A project's icon tile: its image, or a colored letter when it has none.
const props = defineProps<{ name: string; source?: ProjectIconSource | null; src?: string | null; size?: number }>();
const url = computed(() => {
  if (props.src !== undefined) return props.src;
  const u = props.source ? projectIconUrl(props.source) : null;
  return u && !failed.value.has(u) ? u : null;
});
function onError() {
  const u = url.value;
  if (!u || props.src !== undefined || failed.value.has(u)) return;
  failed.value = new Set(failed.value).add(u);
}
</script>

<template>
  <span
    class="group-icon"
    :style="{
      ...(url ? {} : { background: tileColor(name) }),
      ...(size ? { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.55) + 'px', borderRadius: Math.round(size * 0.28) + 'px' } : {}),
    }"
  >
    <img v-if="url" :src="url" alt="" loading="lazy" @error="onError" />
    <template v-else>{{ initial(name) }}</template>
  </span>
</template>
