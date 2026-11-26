<script setup lang="ts">
import { ref } from "vue";
import type { AgentSummary, WorkspaceSummary } from "../shared/wire.ts";
import Icon from "./Icon.vue";
import { useMenu } from "./use-menu.ts";

// The thread actions Paseo's sidebar offers: rename, pin, unread/read, archive.
const props = defineProps<{ thread: WorkspaceSummary; agent?: AgentSummary | null; x: number; y: number }>();
const emit = defineEmits<{
  close: [];
  rename: [thread: WorkspaceSummary];
  renameAgent: [agent: AgentSummary];
  pin: [thread: WorkspaceSummary, pinned: boolean];
  unread: [thread: WorkspaceSummary];
  read: [thread: WorkspaceSummary];
  labels: [thread: WorkspaceSummary];
  fork: [thread: WorkspaceSummary];
  selectMultiple: [thread: WorkspaceSummary];
  archive: [thread: WorkspaceSummary];
}>();
const element = ref<HTMLElement | null>(null);

function pick(fn: () => void) {
  fn();
  emit("close");
}
const { position } = useMenu(element, { x: props.x, y: props.y }, () => emit("close"));
</script>

<template>
  <div
    ref="element"
    class="menu"
    role="menu"
    :aria-label="'Actions for ' + thread.name"
    :style="{ left: position.left + 'px', top: position.top + 'px' }"
  >
    <div class="menu-title">{{ thread.name }}</div>
    <button role="menuitem" @click="pick(() => emit('rename', thread))"><Icon name="edit" :size="14" />{{ agent ? "Rename workspace…" : "Rename…" }}</button>
    <button v-if="agent" role="menuitem" @click="pick(() => emit('renameAgent', agent!))"><Icon name="edit" :size="14" />Rename session…</button>
    <button role="menuitem" @click="pick(() => emit('pin', thread, !thread.pinnedAt))">
      <Icon name="pin" :size="14" />{{ thread.pinnedAt ? "Unpin" : "Pin to top" }}
    </button>
    <button v-if="thread.unread" role="menuitem" @click="pick(() => emit('read', thread))">
      <Icon name="check" :size="14" />Mark as read
    </button>
    <button v-else role="menuitem" @click="pick(() => emit('unread', thread))">
      <Icon name="dot" :size="14" />Mark as unread
    </button>
    <button role="menuitem" @click="pick(() => emit('labels', thread))"><Icon name="layers" :size="14" />Labels…</button>
    <button role="menuitem" @click="pick(() => emit('fork', thread))"><Icon name="branch" :size="14" />Fork conversation…</button>
    <button role="menuitem" @click="pick(() => emit('selectMultiple', thread))"><Icon name="list" :size="14" />Select…</button>
    <div class="menu-sep"></div>
    <button role="menuitem" class="menu-danger" @click="pick(() => emit('archive', thread))">
      <Icon name="archive" :size="14" />Archive…
    </button>
  </div>
</template>
