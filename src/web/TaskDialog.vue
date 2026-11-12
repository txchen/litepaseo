<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { BoardCard, CardPatch } from "../shared/wire.ts";
import { renderMarkdown } from "./markdown.ts";
import { formatMessageTimestamp } from "./timeline-display.ts";
import Icon from "./Icon.vue";

/**
 * One task: title, column, linked conversation, a Markdown description and comments. Every
 * change goes to the server as a per-card edit, so it never overwrites another tab's edits.
 */
const props = defineProps<{
  card: BoardCard;
  columns: readonly string[];
  links: { key: string; label: string }[];
  /** The linked conversation's name, or null when it is not available any more. */
  linkedName: string | null;
  busy: boolean;
}>();
const emit = defineEmits<{
  close: [];
  patch: [patch: CardPatch];
  comment: [text: string];
  uncomment: [id: string];
  remove: [];
  open: [];
}>();
const DESCRIPTION_MAX = 20_000, COMMENT_MAX = 5_000;

const title = ref(props.card.title);
watch(() => props.card.title, (t) => (title.value = t));
function saveTitle() {
  const t = title.value.trim();
  if (!t) title.value = props.card.title;
  else if (t !== props.card.title) emit("patch", { title: t });
}

// Description: rendered until clicked; edited as Markdown text.
const editing = ref(false);
const description = ref(props.card.description ?? "");
const descriptionInput = ref<HTMLTextAreaElement | null>(null);
watch(() => props.card.description, (d) => { if (!editing.value) description.value = d ?? ""; });
const descriptionHtml = computed(() => renderMarkdown(props.card.description ?? ""));
const dirty = computed(() => editing.value && description.value !== (props.card.description ?? ""));
function editDescription() {
  editing.value = true;
  void nextTick(() => {
    autosize(descriptionInput.value);
    descriptionInput.value?.focus();
  });
}
function saveDescription() {
  if (dirty.value) emit("patch", { description: description.value });
  editing.value = false;
}
function cancelDescription() {
  description.value = props.card.description ?? "";
  editing.value = false;
}

const comment = ref("");
const commentInput = ref<HTMLTextAreaElement | null>(null);
function addComment() {
  const text = comment.value.trim();
  if (!text || props.busy) return;
  emit("comment", text);
  comment.value = "";
  void nextTick(() => autosize(commentInput.value));
}
function onCommentKey(event: KeyboardEvent) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    addComment();
  }
}
function onDescriptionKey(event: KeyboardEvent) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    saveDescription();
  } else if (event.key === "Escape") {
    event.stopPropagation();
    cancelDescription();
  }
}
function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.5)) + "px";
}

const comments = computed(() => (props.card.comments ?? []).map((m) => ({
  ...m,
  html: renderMarkdown(m.text),
  when: formatMessageTimestamp(new Date(m.at)),
})));
const linkKey = computed(() => (props.card.hostId && props.card.agentId ? `${props.card.hostId}:${props.card.agentId}` : ""));
function relink(key: string) {
  const [hostId, ...rest] = key.split(":");
  emit("patch", { link: key ? { hostId, agentId: rest.join(":") } : null });
}
const stamp = computed(() => {
  const parts: string[] = [];
  if (props.card.createdAt) parts.push("Created " + formatMessageTimestamp(new Date(props.card.createdAt)));
  if (props.card.updatedAt) parts.push("updated " + formatMessageTimestamp(new Date(props.card.updatedAt)));
  return parts.join(" · ");
});

/** Closing keeps work: an edited description is saved; a written comment asks first. */
function close() {
  saveTitle();
  if (dirty.value) saveDescription();
  if (comment.value.trim() && !confirm("Discard the comment you started?")) return;
  emit("close");
}
function remove() {
  if (confirm(`Delete “${props.card.title}”? Its description and comments are deleted too.`)) emit("remove");
}
function deleteComment(id: string) {
  if (confirm("Delete this comment?")) emit("uncomment", id);
}
</script>

<template>
  <div class="overlay" @mousedown.self="close" @keydown.esc="close">
    <section class="sheet task-sheet" role="dialog" aria-modal="true" :aria-label="'Task: ' + card.title">
      <header class="sheet-head task-head">
        <input
          v-model="title"
          class="task-title"
          aria-label="Title"
          maxlength="300"
          @blur="saveTitle"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
        />
        <button type="button" class="icon-btn" aria-label="Close" @click="close"><Icon name="close" :size="16" /></button>
      </header>
      <div class="sheet-body task-body">
        <div class="task-meta">
          <select :value="card.column" aria-label="Column" :disabled="busy" @change="emit('patch', { column: ($event.target as HTMLSelectElement).value })">
            <option v-for="c in columns" :key="c">{{ c }}</option>
          </select>
          <div class="task-link">
            <button v-if="linkKey && linkedName" type="button" class="link-btn" :title="'Open ' + linkedName" @click="emit('open')">
              <Icon name="chat" :size="13" /><span class="card-link-name">{{ linkedName }}</span>
            </button>
            <span v-else-if="linkKey" class="subtle small">Conversation unavailable</span>
            <select class="card-link-select" aria-label="Link to conversation" :value="linkKey" :disabled="busy" @change="relink(($event.target as HTMLSelectElement).value)">
              <option value="">No conversation</option>
              <option v-if="linkKey && !links.some((l) => l.key === linkKey)" :value="linkKey">{{ linkedName ?? "Unavailable conversation" }}</option>
              <option v-for="l in links" :key="l.key" :value="l.key">{{ l.label }}</option>
            </select>
          </div>
        </div>

        <section class="task-section">
          <h3>Description</h3>
          <template v-if="editing">
            <textarea
              ref="descriptionInput"
              v-model="description"
              class="task-textarea"
              aria-label="Description"
              :maxlength="DESCRIPTION_MAX"
              placeholder="Markdown: what this task is, notes, checklists…"
              @input="autosize($event.target as HTMLTextAreaElement)"
              @keydown="onDescriptionKey"
            ></textarea>
            <div class="task-actions">
              <span class="subtle small">Markdown · ⌘/Ctrl+Enter to save</span>
              <button type="button" class="btn btn-ghost" @click="cancelDescription">Cancel</button>
              <button type="button" class="btn btn-primary" :disabled="busy" @click="saveDescription">Save</button>
            </div>
          </template>
          <button v-else-if="!card.description" type="button" class="task-empty" @click="editDescription">Add a description…</button>
          <div v-else class="prose task-description" role="button" tabindex="0" title="Click to edit"
            @click="($event.target as HTMLElement).closest('a') || editDescription()"
            @keydown.enter="editDescription" v-html="descriptionHtml"></div>
        </section>

        <section class="task-section">
          <h3>Comments <span v-if="comments.length" class="subtle">{{ comments.length }}</span></h3>
          <ol v-if="comments.length" class="task-comments">
            <li v-for="m in comments" :key="m.id" class="task-comment">
              <div class="task-comment-head">
                <span class="subtle small">{{ m.when }}</span>
                <button type="button" class="icon-btn" aria-label="Delete comment" title="Delete comment" :disabled="busy"
                  @click="deleteComment(m.id)">
                  <Icon name="trash" :size="13" />
                </button>
              </div>
              <div class="prose" v-html="m.html"></div>
            </li>
          </ol>
          <form class="task-new-comment" @submit.prevent="addComment">
            <textarea
              ref="commentInput"
              v-model="comment"
              class="task-textarea"
              rows="2"
              aria-label="New comment"
              :maxlength="COMMENT_MAX"
              placeholder="Write a comment… (Markdown, ⌘/Ctrl+Enter to post)"
              @input="autosize($event.target as HTMLTextAreaElement)"
              @keydown="onCommentKey"
            ></textarea>
            <div class="task-actions">
              <button class="btn btn-primary" :disabled="busy || !comment.trim()">Comment</button>
            </div>
          </form>
        </section>
      </div>
      <footer class="sheet-foot task-foot">
        <span class="subtle small">{{ stamp }}</span>
        <button type="button" class="btn btn-ghost task-delete" :disabled="busy" @click="remove"><Icon name="trash" :size="14" />Delete task</button>
      </footer>
    </section>
  </div>
</template>
