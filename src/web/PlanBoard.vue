<script setup lang="ts">
import { computed, ref } from "vue";
import type { AgentSummary, BoardCard as Card, CardPatch } from "../shared/wire.ts";
import { confirmDeleteTask } from "./confirm.ts";
import type { DirectoryStore } from "./directory-store.ts";
import Icon from "./Icon.vue";
import { newId } from "./id.ts";
import TaskDialog from "./TaskDialog.vue";
import type { Api } from "./use-api.ts";

export type Board = { revision: number; cards: Card[] };
const COLUMNS = ["Todo", "Doing", "Done"] as const;

/**
 * The hand-made plan: tasks in Todo/Doing/Done, each optionally linked to a conversation.
 * Moving a card never changes an agent. The board itself belongs to the app (`v-model:board`).
 */
const props = defineProps<{
  board: Board;
  /** Agents a task can link to. */
  store: DirectoryStore<AgentSummary>;
  /** The open agent, offered first as a link. */
  active: AgentSummary | null;
  hostLabels: Map<string, string>;
  api: Api;
  /** Runs a request with the app's busy flag and error toast. */
  action: (fn: () => Promise<void>) => Promise<void>;
  busy: boolean;
}>();
const emit = defineEmits<{ "update:board": [board: Board]; open: [key: string] }>();
const setBoard = (board: Board) => emit("update:board", board);

const cardTitle = ref("");
/** The conversation a new task links to: chosen explicitly, none by default. */
const cardLink = ref("");
/** The task open in the detail dialog. */
const openTaskId = ref<string | null>(null);
const openTask = computed(() => props.board.cards.find((c) => c.id === openTaskId.value) ?? null);
const cardsByColumn = computed(() => {
  const map = new Map<string, Card[]>(COLUMNS.map((c) => [c, []]));
  for (const card of props.board.cards) map.get(card.column)?.push(card);
  return map;
});

async function saveCards(cards: Card[]) {
  try {
    setBoard(await props.api("/board", "PUT", { revision: props.board.revision, cards }));
  } catch (e) {
    setBoard(await props.api("/board"));
    throw e;
  }
}
/** "<host>:<agent>" → the card's link fields; "" → no link. */
function linkFields(key: string): Pick<Card, "hostId" | "agentId"> {
  const agent = props.store.get(key);
  return agent ? { hostId: agent.hostId, agentId: agent.id } : { hostId: null, agentId: null };
}
async function addCard() {
  await props.action(async () => {
    if (!cardTitle.value.trim()) return;
    await saveCards([
      ...props.board.cards,
      { id: newId(), title: cardTitle.value.trim(), column: "Todo", ...linkFields(cardLink.value), createdAt: Date.now() },
    ]);
    cardTitle.value = "";
    cardLink.value = "";
  });
}
/** One card's change, applied by the server to the board as it is now (no lost updates). */
async function patchCard(card: Card, change: CardPatch) {
  await props.action(async () => {
    setBoard(await props.api(`/board/cards/${encodeURIComponent(card.id)}`, "PATCH", change));
  });
}
async function linkCard(card: Card, key: string) {
  const fields = linkFields(key);
  await patchCard(card, { link: fields.hostId && fields.agentId ? { hostId: fields.hostId, agentId: fields.agentId } : null });
}
async function commentCard(card: Card, text: string) {
  await props.action(async () => {
    setBoard(await props.api(`/board/cards/${encodeURIComponent(card.id)}/comments`, "POST", { text }));
  });
}
async function uncommentCard(card: Card, id: string) {
  await props.action(async () => {
    setBoard(await props.api(`/board/cards/${encodeURIComponent(card.id)}/comments/${encodeURIComponent(id)}`, "DELETE"));
  });
}
async function confirmRemove(card: Card) {
  if (!card.description && !card.comments?.length) return void removeCard(card);
  if (await confirmDeleteTask(card.title)) void removeCard(card);
}
async function removeCard(card: Card) {
  await props.action(() => saveCards(props.board.cards.filter((c) => c.id !== card.id)));
  if (openTaskId.value === card.id) openTaskId.value = null;
}
async function moveCard(card: Card, column: string) {
  await patchCard(card, { column });
}
/** A line of the description for the board card, without Markdown punctuation. */
function cardExcerpt(card: Card) {
  return (card.description ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~[\]()|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}
/** Conversations a task can link to: the open one first, then the most recent. */
const linkChoices = computed(() => {
  props.store.version.value;
  const recent = props.store.range(0, 30);
  const open = props.active;
  const list = open ? [open, ...recent.filter((a) => a.key !== open.key)] : recent;
  const many = props.hostLabels.size > 1;
  return list.map((a) => ({
    key: a.key,
    label: (a.title || `${a.provider} · ${a.project}`) + (many ? ` (${props.hostLabels.get(a.hostId) ?? a.hostId})` : ""),
  }));
});
/** The linked conversation of a card, or null when it is not in the directory (archived, host gone). */
function cardAgent(card: Card) {
  props.store.version.value;
  return card.hostId && card.agentId ? props.store.get(`${card.hostId}:${card.agentId}`) ?? null : null;
}
function openCard(card: Card) {
  if (card.hostId && card.agentId) emit("open", `${card.hostId}:${card.agentId}`);
}
</script>

<template>
  <form class="add-card" @submit.prevent="addCard">
    <input v-model="cardTitle" placeholder="New task" required />
    <select v-model="cardLink" class="card-link-select" aria-label="Link to conversation">
      <option value="">No conversation</option>
      <option v-for="c in linkChoices" :key="c.key" :value="c.key">{{ c.label }}</option>
    </select>
    <button class="btn btn-primary" :disabled="busy"><Icon name="plus" :size="15" />Add task</button>
  </form>
  <div class="board">
    <div v-for="column in COLUMNS" :key="column" class="column">
      <div class="column-head">
        <h3>{{ column }}</h3>
        <span class="count">{{ cardsByColumn.get(column)!.length }}</span>
      </div>
      <article v-for="card in cardsByColumn.get(column)" :key="card.id" class="card kanban-card">
        <button type="button" class="kanban-open" :aria-label="'Open task ' + card.title" @click="openTaskId = card.id">
          <span class="row-title">{{ card.title }}</span>
          <span v-if="cardExcerpt(card)" class="kanban-excerpt">{{ cardExcerpt(card) }}</span>
        </button>
        <div v-if="card.agentId" class="card-link">
          <button v-if="cardAgent(card)" class="link-btn" :title="'Open ' + (cardAgent(card)!.title || cardAgent(card)!.id)" @click="openCard(card)">
            <Icon name="chat" :size="13" /><span class="card-link-name">{{ cardAgent(card)!.title || cardAgent(card)!.provider }}</span>
          </button>
          <span v-else class="subtle small">Conversation unavailable</span>
          <button class="icon-btn" aria-label="Unlink conversation" title="Unlink conversation" :disabled="busy" @click="linkCard(card, '')">
            <Icon name="close" :size="13" />
          </button>
        </div>
        <select v-else class="card-link-select" aria-label="Link to conversation" :disabled="busy" value=""
          @change="linkCard(card, ($event.target as HTMLSelectElement).value)">
          <option value="" disabled>Link a conversation…</option>
          <option v-for="c in linkChoices" :key="c.key" :value="c.key">{{ c.label }}</option>
        </select>
        <div class="kanban-actions">
          <select :value="card.column" aria-label="Column" @change="moveCard(card, ($event.target as HTMLSelectElement).value)">
            <option v-for="c in COLUMNS" :key="c">{{ c }}</option>
          </select>
          <button v-if="card.comments?.length" type="button" class="kanban-count" :title="card.comments.length + ' comments'" @click="openTaskId = card.id">
            <Icon name="chat" :size="13" />{{ card.comments.length }}
          </button>
          <button type="button" class="icon-btn" aria-label="Edit task" title="Edit" @click="openTaskId = card.id">
            <Icon name="edit" :size="15" />
          </button>
          <button
            class="icon-btn"
            aria-label="Remove"
            @click="confirmRemove(card)"
          >
            <Icon name="trash" :size="15" />
          </button>
        </div>
      </article>
      <p v-if="!cardsByColumn.get(column)!.length" class="column-empty">Nothing here</p>
    </div>
  </div>
  <TaskDialog
    v-if="openTask"
    :key="openTask.id"
    :card="openTask"
    :columns="COLUMNS"
    :links="linkChoices"
    :linked-name="cardAgent(openTask) ? cardAgent(openTask)!.title || cardAgent(openTask)!.provider : null"
    :busy="busy"
    @close="openTaskId = null"
    @patch="patchCard(openTask, $event)"
    @comment="commentCard(openTask, $event)"
    @uncomment="uncommentCard(openTask, $event)"
    @remove="removeCard(openTask)"
    @open="openCard(openTask); openTaskId = null"
  />
</template>
