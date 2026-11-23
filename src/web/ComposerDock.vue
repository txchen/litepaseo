<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { AgentBackgroundWorkItem, AgentSummary, SlashCommandOption } from "../shared/wire.ts";
import AgentControls from "./AgentControls.vue";
import AttachmentPanel from "./AttachmentPanel.vue";
import BackgroundWorkBar from "./BackgroundWorkBar.vue";
import ComposerAutocomplete, { type AutocompleteTrigger } from "./ComposerAutocomplete.vue";
import DictationButton from "./DictationButton.vue";
import { prefs } from "./preferences.ts";
import Icon from "./Icon.vue";
import PermissionForm from "./PermissionForm.vue";
import { agentPath as path, type Api } from "./use-api.ts";
import type { Composer } from "./use-composer.ts";

/** Below the open conversation: permission requests, delivery notices, the send queue and the composer. */
const props = defineProps<{
  composer: Composer;
  agent: AgentSummary;
  api: Api;
  busy: boolean;
  hostConnected: boolean;
  backgroundWork?: AgentBackgroundWorkItem[];
}>();
const emit = defineEmits<{
  /** The open agent's current model, as the composer chip names it ("" when unknown). */
  model: [label: string];
}>();
const {
  element, autosize, attachments, selectedAttachments, attachmentsReady,
  prompt, composerHasContent, uncertain, savedDrafts, restoreDraft, warning,
  checkingDelivery, deliveryNotice, checkDelivery, acknowledgeMessage,
  queued, editingQueued, queuedText, controlQueue, removeQueued, editQueued, interruptWith,
  dictationReady, notice, showNotice,
  behavior, running, deliveryModes, deliveryMode, composerSuggestion,
  send, stop, respond,
} = props.composer;
const coarsePointer = matchMedia("(pointer: coarse)").matches;

const attachmentPanel = ref<InstanceType<typeof AttachmentPanel> | null>(null);
const agentControls = ref<InstanceType<typeof AgentControls> | null>(null);
const autocomplete = ref<InstanceType<typeof ComposerAutocomplete> | null>(null);

// ---- Background work stop --------------------------------------------------------------------
const stoppingBg = ref<string | null>(null);
async function stopBackgroundWork(item: AgentBackgroundWorkItem) {
  stoppingBg.value = item.id;
  try {
    await props.api(path(props.agent) + "/background-work/stop", "POST", item);
  } catch (e) {
    showNotice((e as Error).message || "Could not stop background task.");
  } finally {
    stoppingBg.value = null;
  }
}

// ---- Composer / slash commands and @ file mentions autocomplete ------------------------------
const acTrigger = ref<AutocompleteTrigger | null>(null);
const acCommands = ref<SlashCommandOption[]>([]);
const acFiles = ref<string[]>([]);
const acLoading = ref(false);
const acDismissedAt = ref<string | null>(null);
const cmdCache = new Map<string, { at: number; list: SlashCommandOption[] }>();
let fileSearchTimer: ReturnType<typeof setTimeout> | undefined;
let fileSearchSeq = 0;

function detectTrigger(): AutocompleteTrigger | null {
  const el = element.value;
  const text = prompt.value;
  const caret = el ? (el.selectionStart ?? text.length) : text.length;
  const before = text.slice(0, caret);
  // Slash command only at the very start of the prompt (no whitespace yet).
  const slash = /^\/([^\s]*)$/.exec(before);
  if (slash) return { mode: "slash", query: slash[1]!, start: 0, end: caret };
  // File mention after start or whitespace.
  const mention = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (mention) {
    const query = mention[1]!;
    const start = caret - query.length - 1;
    return { mode: "file", query, start, end: caret };
  }
  return null;
}

async function loadCommands() {
  const key = props.agent.key;
  const hit = cmdCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) {
    acCommands.value = hit.list;
    return;
  }
  acLoading.value = true;
  try {
    const list = (await props.api(path(props.agent) + "/commands")) as SlashCommandOption[];
    const clean = Array.isArray(list) ? list : [];
    cmdCache.set(key, { at: Date.now(), list: clean });
    if (props.agent.key === key) acCommands.value = clean;
  } catch {
    if (props.agent.key === key) acCommands.value = [];
  } finally {
    if (props.agent.key === key) acLoading.value = false;
  }
}

function scheduleFileSearch(q: string) {
  clearTimeout(fileSearchTimer);
  const key = props.agent.key;
  const hostId = props.agent.hostId;
  const cwd = props.agent.cwd;
  fileSearchTimer = setTimeout(async () => {
    const seq = ++fileSearchSeq;
    acLoading.value = true;
    try {
      const res = await props.api(`/hosts/${encodeURIComponent(hostId)}/fs/search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}&limit=30`);
      if (seq === fileSearchSeq && props.agent.key === key) acFiles.value = Array.isArray(res.files) ? res.files : [];
    } catch {
      if (seq === fileSearchSeq && props.agent.key === key) acFiles.value = [];
    } finally {
      if (seq === fileSearchSeq && props.agent.key === key) acLoading.value = false;
    }
  }, q ? 120 : 0);
}

function refreshAutocomplete() {
  const next = detectTrigger();
  if (!next) {
    acTrigger.value = null;
    acDismissedAt.value = null;
    return;
  }
  const sig = `${next.mode}:${next.start}:${next.query}`;
  if (acDismissedAt.value === sig) return;
  acDismissedAt.value = null;
  const prevMode = acTrigger.value?.mode;
  acTrigger.value = next;
  if (next.mode === "slash") {
    if (prevMode !== "slash" || !acCommands.value.length) void loadCommands();
  } else {
    scheduleFileSearch(next.query);
  }
}

function applyAutocomplete(replacement: string, trigger: AutocompleteTrigger) {
  const text = prompt.value;
  prompt.value = text.slice(0, trigger.start) + replacement + text.slice(trigger.end);
  acTrigger.value = null;
  const caret = trigger.start + replacement.length;
  void nextTick(() => {
    autosize();
    const el = element.value;
    if (el) {
      el.focus();
      el.setSelectionRange(caret, caret);
    }
  });
}

watch(() => props.agent.key, () => {
  acTrigger.value = null;
  acFiles.value = [];
  acCommands.value = cmdCache.get(props.agent.key)?.list ?? [];
});
watch(() => agentControls.value?.modelLabel, (label) => emit("model", label && label !== "Model" ? label : ""), { immediate: true });

const dictationPreview = ref("");
const dictationPreviewElement = ref<HTMLDivElement | null>(null);
watch(dictationPreview, () => {
  const el = dictationPreviewElement.value;
  if (el) el.scrollTop = el.scrollHeight;
}, { flush: "post" });
/** Dictated text goes where the cursor is, with spacing that reads naturally. */
function insertDictation(text: string) {
  const el = element.value;
  const current = prompt.value;
  const start = el && document.activeElement === el ? el.selectionStart : current.length;
  const end = el && document.activeElement === el ? el.selectionEnd : current.length;
  const before = current.slice(0, start), after = current.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  prompt.value = before + lead + text + after;
  void nextTick(() => {
    if (!el) return;
    el.focus();
    const at = (before + lead + text).length;
    el.setSelectionRange(at, at);
    autosize();
  });
}

const dragging = ref(false);
function onDragLeave(event: DragEvent) {
  const form = event.currentTarget as HTMLElement;
  if (!form.contains(event.relatedTarget as Node | null)) dragging.value = false;
}
/** Pasted screenshots and files become attachments; plain text pastes stay text. */
function pasteFiles(event: ClipboardEvent) {
  const data = event.clipboardData;
  if (!data) return;
  let files = Array.from(data.files);
  if (!files.length)
    files = Array.from(data.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
  if (!files.length) return;
  event.preventDefault();
  void attachmentPanel.value?.addFiles(files);
}

const placeholder = computed(() => {
  if (composerSuggestion.value && !coarsePointer) return composerSuggestion.value;
  if (!running.value) return "Message this agent…";
  return deliveryMode.value === "queue" ? "Queue a message for when this turn ends"
    : deliveryMode.value === "steer" ? "Guide the current turn with a new instruction"
    : "Interrupt and send a new message";
});
function onKey(event: KeyboardEvent) {
  if (autocomplete.value?.onKeyDown(event)) return;
  if (event.key === "Tab" && !event.shiftKey && composerSuggestion.value) {
    event.preventDefault();
    prompt.value = composerSuggestion.value;
    void nextTick(autosize);
    return;
  }
  if (event.key !== "Enter" || event.isComposing) return;
  const mod = event.metaKey || event.ctrlKey;
  const enterSends = !coarsePointer && prefs.sendShortcut === "enter" && !event.shiftKey;
  if (enterSends || mod) {
    event.preventDefault();
    acTrigger.value = null;
    void send();
  }
}

defineExpose({
  focusModel: () => agentControls.value?.focusModel(),
  cycleThinking: () => agentControls.value?.cycleThinking(),
});
</script>

<template>
  <div class="dock">
    <div class="dock-inner">
      <PermissionForm v-for="p in agent.pendingPermissions" :key="agent.key + ':' + p.id" :permission="p" :busy="busy" @respond="respond(p, $event)" />

      <p v-if="deliveryNotice" class="composer-notice" role="status">{{ deliveryNotice }}</p>
      <p v-if="warning" class="composer-notice is-warn" role="status"><Icon name="alert" :size="13" />{{ warning }}</p>
      <p v-if="notice" class="composer-notice" role="status">
        <Icon name="alert" :size="13" />{{ notice }}
        <button type="button" class="icon-btn" aria-label="Dismiss" @click="notice = ''"><Icon name="close" :size="12" /></button>
      </p>
      <details v-if="savedDrafts.length" class="saved-drafts">
        <summary>Other saved drafts ({{ savedDrafts.length }})</summary>
        <div v-for="draft in savedDrafts" :key="draft.slot" class="saved-draft">
          <p class="saved-draft-text">{{ draft.text }}</p>
          <button type="button" class="btn btn-sm btn-outline" @click="restoreDraft(draft.slot)">Restore draft</button>
        </div>
      </details>
      <div v-if="uncertain && !busy" class="uncertain">
        <Icon name="alert" :size="15" />
        <span class="grow">Delivery unknown. Check the conversation before sending again. Message: {{ uncertain.text }} {{ uncertain.attachmentNames?.join(", ") }}</span>
        <button class="btn btn-ghost" :disabled="checkingDelivery" @click="checkDelivery">{{ checkingDelivery ? "Checking…" : "Check delivery" }}</button>
        <button class="btn btn-ghost" @click="acknowledgeMessage">I checked</button>
      </div>

      <BackgroundWorkBar v-if="backgroundWork?.length" :items="backgroundWork" :stopping-id="stoppingBg" @stop="stopBackgroundWork" />

      <div v-if="queued.length" class="send-queue" role="list" aria-label="Queued messages">
        <div v-for="m in queued" :key="m.id" class="queue-item" :class="{ 'is-error': m.error }" role="listitem">
          <Icon :name="m.error ? 'alert' : 'clock'" :size="14" class="queue-icon" />
          <div class="queue-body">
            <template v-if="editingQueued === m.id">
              <textarea v-model="queuedText" aria-label="Queued message text" rows="3" />
              <button type="button" class="btn btn-ghost" :disabled="busy" @click="editQueued(m)">Save</button>
              <button type="button" class="btn btn-ghost" @click="editingQueued = null">Cancel</button>
            </template>
            <span v-else class="queue-text" :title="m.text">{{ m.text || "(attachments only)" }}</span>
            <span v-if="m.attachmentNames.length" class="queue-meta">{{ m.attachmentNames.join(", ") }}</span>
            <span class="queue-meta">{{ m.sending ? 'Sending…' : m.error ? 'Delivery unknown · queue paused' : m.paused ? 'Paused' : !hostConnected ? 'Waiting for host' : 'Waiting for turn to finish' }}</span>
            <span v-if="m.error" class="queue-meta queue-error">{{ m.error }}</span>
          </div>
          <button class="btn btn-ghost" :disabled="busy || m.sending" @click="controlQueue(m, m.paused ? 'resume' : 'pause')">{{ m.paused ? 'Resume' : 'Pause' }}</button>
          <button class="btn btn-ghost" :disabled="busy || m.sending || queued[0].id === m.id" @click="controlQueue(m, 'up')" aria-label="Move queued message up">↑</button>
          <button v-if="m.error" class="btn btn-ghost" :disabled="busy" @click="controlQueue(m, 'check')">Check delivery</button>
          <button type="button" class="queue-send" :disabled="busy || !!uncertain || m.sending"
            :title="running ? 'Send now: stops the running turn' : 'Send now'" @click="interruptWith(m)">
            {{ running ? "Interrupt" : "Send" }}
          </button>
          <button type="button" class="icon-btn" :disabled="busy || m.sending" aria-label="Edit queued message" title="Edit" @click="editingQueued = m.id; queuedText = m.text"><Icon name="edit" :size="14" /></button>
          <button type="button" class="icon-btn" :disabled="busy || m.sending" aria-label="Remove queued message" title="Remove" @click="removeQueued(m)"><Icon name="close" :size="14" /></button>
        </div>
      </div>

      <form
        class="composer"
        :class="{ 'is-dragging': dragging }"
        @submit.prevent="send"
        @dragover.prevent="dragging = true"
        @dragleave="onDragLeave"
        @drop.prevent="dragging = false; attachmentPanel?.addFiles($event.dataTransfer?.files)"
        @paste="pasteFiles"
      >
        <ComposerAutocomplete
          ref="autocomplete"
          :trigger="acTrigger"
          :commands="acCommands"
          :files="acFiles"
          :loading="acLoading"
          @select="applyAutocomplete"
          @close="acDismissedAt = acTrigger ? `${acTrigger.mode}:${acTrigger.start}:${acTrigger.query}` : null; acTrigger = null"
        />
        <AttachmentPanel ref="attachmentPanel" :store="attachments" :agent-key="agent.key" :base="'/api' + path(agent)" :busy="busy || !!uncertain" />
        <div v-if="dictationPreview" ref="dictationPreviewElement" class="dictation-preview" role="status" aria-live="polite">{{ dictationPreview }}</div>
        <textarea
          ref="element"
          v-model="prompt"
          rows="1"
          :placeholder="placeholder"
          :required="!selectedAttachments.length"
          @input="autosize(); refreshAutocomplete()"
          @click="refreshAutocomplete"
          @keyup="refreshAutocomplete"
          @keydown="onKey"
        ></textarea>
        <div class="composer-bar">
          <button
            type="button"
            class="composer-tool"
            aria-label="Attach files"
            :title="attachmentPanel?.hint"
            :disabled="busy || !!uncertain || !attachmentPanel?.available"
            @click="attachmentPanel?.pick()"
          >
            <Icon name="plus" :size="18" />
          </button>
          <AgentControls
            ref="agentControls"
            :agent="agent"
            :path="path(agent)"
            :api="api"
            :disabled="busy || !hostConnected"
            @notice="showNotice"
          />
          <div class="composer-actions">
            <label v-if="running" class="chip-behavior" :class="'is-' + behavior"
              :title="behavior === 'queue' ? 'Queue: send when the current turn ends' : behavior === 'steer' ? 'Steer: send instructions into the current turn; Paseo may interrupt if steering is unavailable' : 'Interrupt: stop the current turn and start a new one'">
              <span>{{ behavior === 'queue' ? 'Queue' : behavior === 'steer' ? 'Steer' : 'Interrupt' }}</span>
              <Icon name="chevron" :size="11" class="behavior-caret" />
              <select v-model="behavior" aria-label="Message delivery mode">
                <option value="queue">Queue</option>
                <option v-if="deliveryModes.includes('steer')" value="steer">Steer</option>
                <option value="interrupt">Interrupt</option>
              </select>
            </label>
            <DictationButton
              v-if="dictationReady"
              :key="agent.key"
              :disabled="busy"
              @text="insertDictation"
              @preview="dictationPreview = $event"
              @notice="showNotice"
            />
            <button
              v-if="running"
              type="button"
              class="disc disc-stop"
              :class="{ 'is-primary': !composerHasContent }"
              aria-label="Stop turn"
              title="Stop turn"
              :disabled="busy"
              @click="stop"
            >
              <Icon name="stop" :size="18" />
            </button>
            <button
              v-if="!running || composerHasContent"
              class="disc disc-send"
              aria-label="Send"
              title="Send (Enter) · Shift+Enter for a new line"
              :disabled="busy || !!uncertain || !attachmentsReady || !composerHasContent"
            >
              <Icon name="send" :size="17" />
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
</template>
