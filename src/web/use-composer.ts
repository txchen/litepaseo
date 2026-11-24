import { computed, nextTick, onUnmounted, provide, reactive, ref, watch, type Ref } from "vue";
import type { AgentSummary, MessageDeliveryMode, Permission, ServerQueuedMessage as QueuedMessage } from "../shared/wire.ts";
import { AttachmentStore, type LocalAttachment } from "./attachment-store.ts";
import { ComposerStore } from "./composer-store.ts";
import { OptimisticStore } from "./optimistic-messages.ts";
import { prefs } from "./preferences.ts";
import { openStream } from "./event-stream.ts";
import { newId } from "./id.ts";
import { localStorageOrNull, safeSetItem } from "./safe-storage.ts";
import { SUGGESTIONS } from "./suggestions.ts";
import { agentPath as path, type Api } from "./use-api.ts";

/** No turn in flight: the moment a queued message may go. */
function turnIdle(a: AgentSummary) {
  return a.turnActive === false || (a.turnActive === undefined && a.status !== "running" && a.status !== "initializing");
}

/**
 * Writing to the open agent: per-agent drafts and staged attachments, sending (now, steered,
 * interrupting or queued), the delivery check for messages whose outcome is unknown, the send
 * queue, next-input suggestions and short composer notices. It lives as long as the app, so
 * drafts, uploads and queues survive switching pages; ComposerDock renders it.
 */
export function useComposer({ active, selectedKey, authenticated, api, action, busy, showLatest, baselineSeqEnd }: {
  active: Readonly<Ref<AgentSummary | null>>;
  selectedKey: Readonly<Ref<string | null>>;
  authenticated: Readonly<Ref<boolean>>;
  api: Api;
  action: (fn: () => Promise<void>) => Promise<void>;
  busy: Readonly<Ref<boolean>>;
  /** Scrolls the open conversation to its newest message. */
  showLatest: () => void;
  /** Highest known timeline seqEnd of the open conversation, used for fallback deduplication. */
  baselineSeqEnd?: () => number;
}) {
  const drafts = new ComposerStore(() => localStorage);
  const attachments = new AttachmentStore();
  const optimistic = new OptimisticStore();
  /** The composer textarea (ComposerDock binds it). */
  const element = ref<HTMLTextAreaElement | null>(null);
  function autosize() {
    const el = element.value;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4)) + "px";
  }

  // ---- Send queue: messages waiting for the turn to end -----------------------------------------
  const queued = ref<QueuedMessage[]>([]);
  const queueAttempts = new Map<string, string>();
  const editingQueued = ref<string | null>(null), queuedText = ref("");
  let queueRead = 0;
  async function refreshQueue() {
    const a = active.value;
    const read = ++queueRead;
    if (!a || !authenticated.value) { queued.value = []; return; }
    try {
      const result = await api(path(a) + "/queue");
      if (read === queueRead && active.value?.key === a.key) queued.value = Array.isArray(result) ? result : [];
    } catch { /* The connection status already reports connectivity failures. */ }
  }
  /** Every agent's queue size, for the sidebar. */
  const queueSummary = ref<Record<string, { count: number; paused: boolean }>>({});
  let queueSummaryStream: { close(): void } | null = null;
  watch(authenticated, signedIn => {
    queueSummaryStream?.close(); queueSummary.value = {};
    if (signedIn) queueSummaryStream = openStream({ url: () => '/api/queue/stream', onMessage: data => { queueSummary.value = data as typeof queueSummary.value; } });
  });
  let queueStream: { close(): void } | null = null;
  watch([selectedKey, authenticated], () => {
    queueStream?.close(); queueStream = null;
    queueRead++; queued.value = [];
    const a = active.value;
    if (a && authenticated.value) queueStream = openStream({ url: () => '/api' + path(a) + '/queue/stream', onMessage: data => {
      if (authenticated.value && active.value?.key === a.key && Array.isArray(data)) { queueRead++; queued.value = data; }
    } });
  });
  async function controlQueue(m: QueuedMessage, command: string) {
    const a = active.value; if (!a) return;
    await action(async () => { await api(path(a) + '/queue/' + encodeURIComponent(m.id) + '/control', 'POST', { action: command }); await refreshQueue(); });
  }
  async function removeQueued(m: QueuedMessage) {
    const a = active.value;
    if (!a) return;
    await action(async () => { await api(path(a) + "/queue/" + encodeURIComponent(m.id), "DELETE"); await refreshQueue(); });
  }
  async function editQueued(m: QueuedMessage) {
    const a = active.value;
    if (!a) return;
    const text = queuedText.value;
    await action(async () => { await api(path(a) + "/queue/" + encodeURIComponent(m.id), "PATCH", { text }); editingQueued.value = null; await refreshQueue(); });
  }
  async function interruptWith(m: QueuedMessage) {
    const a = active.value;
    if (!a || busy.value || uncertain.value) return;
    await action(async () => { await api(path(a) + "/queue/" + encodeURIComponent(m.id) + "/send", "POST"); await refreshQueue(); });
  }

  // ---- Voice input and notices --------------------------------------------------------------------
  /** Voice input shows only once a transcription service is set up in Settings. */
  const dictationReady = ref(false);
  async function loadDictation() {
    try { dictationReady.value = !!(await api("/dictation")).configured; } catch { /* keep the last answer */ }
  }
  /** Short-lived composer messages (dictation, model switches): cleared after a while or on dismiss. */
  const notice = ref("");
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function showNotice(text: string) {
    notice.value = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice.value = ""), 8000);
  }

  // ---- The draft ----------------------------------------------------------------------------------
  const selectedAttachments = computed(() => selectedKey.value ? attachments.get(selectedKey.value) : []);
  const prompt = computed({
    get: () => selectedKey.value ? drafts.state(selectedKey.value).text : "",
    set: (text: string) => { if (selectedKey.value) drafts.setText(selectedKey.value, text); },
  });
  const composerHasContent = computed(() => !!prompt.value.trim() || selectedAttachments.value.length > 0);
  const attachmentsReady = computed(() => selectedAttachments.value.every(e => !!e.id && !e.uploading && !e.error));
  const uncertain = computed(() => selectedKey.value ? drafts.unresolved(selectedKey.value)[0] ?? null : null);
  const savedDrafts = computed(() => selectedKey.value
    ? drafts.saved(selectedKey.value).filter(d => d.text !== prompt.value) : []);
  function restoreDraft(slot: string) {
    if (selectedKey.value) drafts.restore(selectedKey.value, slot);
  }

  // ---- Delivery check: messages whose outcome is unknown ------------------------------------------
  const checkingDelivery = ref(false), deliveryNotice = ref("");
  async function checkDelivery() {
    const agent = active.value;
    if (!agent || busy.value || checkingDelivery.value || document.hidden) return;
    const pending = drafts.unresolved(agent.key);
    if (!pending.length) return;
    const generation = drafts.generation;
    checkingDelivery.value = true;
    try {
      const result = await api(path(agent) + "/messages/status", "POST", { messageIds: pending.slice(0, 20).map(p => p.messageId) });
      if (generation !== drafts.generation) return;
      for (const id of result.confirmed ?? []) {
        const message = pending.find(p => p.messageId === id);
        if (message) { attachments.consume(agent.key, message.attachmentIds ?? []); drafts.confirm(agent.key, id); }
      }
      if (active.value?.key === agent.key) deliveryNotice.value = result.confirmed?.length ? "Delivery confirmed from conversation history." : "Not confirmed yet. No message has been resent.";
    } catch {
      if (active.value?.key === agent.key) deliveryNotice.value = "Unable to check delivery. Your message remains saved.";
    } finally { checkingDelivery.value = false; }
  }
  const deliveryTimer = setInterval(() => void checkDelivery(), 15_000);
  watch([selectedKey, busy], () => { deliveryNotice.value = ""; void checkDelivery(); });
  function acknowledgeMessage() {
    if (selectedKey.value && uncertain.value) drafts.resolve(selectedKey.value, uncertain.value.messageId);
  }
  function onStorage(event: StorageEvent) {
    if (!event.storageArea || event.storageArea !== localStorageOrNull()) return;
    if (event.key === "litepaseo-composer-signout") drafts.clear();
    else drafts.onStorage(event.key, event.newValue); // O(1); ignores unrelated keys such as theme
  }
  window.addEventListener("storage", onStorage);

  // ---- Delivery mode ------------------------------------------------------------------------------
  const behavior = ref<MessageDeliveryMode>("steer");
  const running = computed(() => active.value?.status === "running");
  const deliveryModes = computed<MessageDeliveryMode[]>(() => active.value?.deliveryModes ?? ["queue", "interrupt"]);
  const deliveryMode = computed(() => deliveryModes.value.includes(behavior.value) ? behavior.value : "queue");
  watch([() => active.value?.key, () => deliveryModes.value.includes("steer"), () => prefs.defaultDeliveryMode], ([, canSteer, pref]) => {
    if (pref === "interrupt") behavior.value = "interrupt";
    else if (pref === "queue") behavior.value = "queue";
    else behavior.value = canSteer ? "steer" : "queue";
  }, { immediate: true });

  // ---- Next-input suggestions ---------------------------------------------------------------------
  // Rows ask through these; each conversation's newest ready one is its Tab completion, kept
  // while the conversation is cached out of view.
  const suggestions = reactive(new Map<string, { seqStart: number; text: string }>());
  function offerSuggestion(key: string, seqStart: number, text: string) {
    const current = suggestions.get(key);
    if (!current || seqStart >= current.seqStart) suggestions.set(key, { seqStart, text });
  }
  provide(SUGGESTIONS, {
    predict: (token) => {
      const a = active.value;
      if (!a) return Promise.resolve({ status: "expired", text: "" });
      return api(path(a) + "/suggestion", "POST", { token }, 65_000);
    },
    use: (text) => {
      prompt.value = text;
      void nextTick(() => {
        autosize();
        element.value?.focus();
      });
    },
    send: (text) => void sendText(text),
    offer: (seqStart, text) => {
      if (active.value) offerSuggestion(active.value.key, seqStart, text);
    },
  });
  const composerSuggestion = computed(() => {
    const offered = active.value && suggestions.get(active.value.key);
    return offered && !prompt.value ? offered.text : "";
  });

  // ---- Sending ------------------------------------------------------------------------------------
  async function send() {
    await sendText(prompt.value, true);
  }
  async function sendText(text: string, fromComposer = false) {
    const a = active.value;
    if (!a || (!text.trim() && (!fromComposer || !selectedAttachments.value.length)) || uncertain.value || busy.value || (fromComposer && !attachmentsReady.value)) return;
    // Queue mode: while a turn runs the message waits above the composer instead of entering
    // the conversation; it goes when the turn ends, or at once if the reader chooses to interrupt.
    if (deliveryMode.value === "queue" && (!turnIdle(a) || queued.value.length > 0)) {
      const selected = fromComposer ? [...selectedAttachments.value] : [];
      await action(async () => {
        const attachmentIds = selected.map(e => e.id!);
        const attempt = JSON.stringify([a.key, text, attachmentIds]);
        const id = queueAttempts.get(attempt) ?? newId();
        queueAttempts.set(attempt, id);
        try { await api(path(a) + "/queue", "POST", { id, text, attachmentIds }); }
        catch (e) { await refreshQueue(); throw e; }
        queueAttempts.delete(attempt);
        for (const entry of selected) attachments.remove(a.key, entry, true);
        if (fromComposer && drafts.state(a.key).text === text) drafts.setText(a.key, "");
        suggestions.delete(a.key);
        await refreshQueue();
        void nextTick(autosize);
      });
      return;
    }
    const selected = fromComposer ? [...selectedAttachments.value] : [];
    if (fromComposer) drafts.setText(a.key, "");
    await deliver(a, text, selected, turnIdle(a) || deliveryMode.value === "queue" ? "send" : deliveryMode.value, { restore: fromComposer });
  }
  /** Sends immediately; uncertain outcomes remain in the delivery check. */
  async function deliver(a: AgentSummary, text: string, selected: LocalAttachment[], mode: "send" | "steer" | "interrupt",
    { restore }: { restore: boolean }) {
    const state = drafts.state(a.key);
    const generation = drafts.generation;
    const sent = { text, messageId: newId(),
      attachmentIds: selected.map(e => e.id!), attachmentNames: selected.map(e => e.file.name) };
    drafts.begin(a.key, sent);
    // Show the user's message at 0 ms with its own image blob URLs so revoking staged
    // attachment previews on send never breaks the optimistic bubble before the real row lands.
    const optimisticImages = selected.filter(e => !!e.preview).map(e => URL.createObjectURL(e.file));
    const optimisticFiles = selected.filter(e => !e.preview).map(e => e.file.name);
    optimistic.add({
      messageId: sent.messageId,
      agentKey: a.key,
      text,
      images: optimisticImages,
      attachmentNames: optimisticFiles,
      baselineSeqEnd: selectedKey.value === a.key ? (baselineSeqEnd?.() ?? -1) : -1,
    });
    if (selectedKey.value === a.key) showLatest();
    let delivered = false;
    await action(async () => {
      try {
        await api(path(a) + "/messages", "POST", { ...sent, behavior: mode });
        delivered = true;
        if (generation !== drafts.generation) {
          optimistic.remove(a.key, sent.messageId);
          return;
        }
        optimistic.markSent(a.key, sent.messageId);
        drafts.resolve(a.key, sent.messageId);
        for (const entry of selected) attachments.remove(a.key, entry, true);
        suggestions.delete(a.key);
        void nextTick(autosize);
        if (selectedKey.value === a.key) showLatest();
      } catch (e) {
        if (generation !== drafts.generation) {
          optimistic.remove(a.key, sent.messageId);
          return;
        }
        // On flaky mobile networks the real timeline row can arrive over SSE even when the
        // HTTP response drops or times out: treat that positive proof as delivered.
        if (optimistic.wasConfirmed(sent.messageId)) {
          delivered = true;
          drafts.resolve(a.key, sent.messageId);
          for (const entry of selected) attachments.remove(a.key, entry, true);
          suggestions.delete(a.key);
          void nextTick(autosize);
          return;
        }
        optimistic.remove(a.key, sent.messageId);
        const notSent = (e as { delivery?: string }).delivery === "not-sent";
        if (notSent) {
          drafts.resolve(a.key, sent.messageId);
          if ((e as { status?: number }).status !== 409)
            for (const entry of selected) entry.error = "Not sent. Retry the upload or remove this attachment.";
        }
        if (restore && !state.text) {
          drafts.restoreFailed(a.key, sent);
        }
        throw e;
      }
    });
    return delivered;
  }
  async function stop() {
    const a = active.value;
    if (a) await action(async () => void (await api(path(a) + "/stop", "POST")));
  }
  async function respond(p: Permission, response: Record<string, unknown>) {
    const a = active.value;
    if (!a) return;
    await action(async () => {
      await api(path(a) + "/permissions/" + encodeURIComponent(p.id), "POST", response);
    });
  }

  /**
   * "user": the person chose to sign out — drafts and staged files are erased here and in other
   * tabs, as expected on a shared computer. "ended": the session expired or was revoked elsewhere —
   * nothing the user wrote is erased; drafts and unconfirmed messages wait for sign-in.
   */
  function signedOut(reason: "user" | "ended") {
    if (reason === "user") {
      drafts.clear();
      queued.value = [];
      queueRead++;
      attachments.clear();
      optimistic.clearAll();
      suggestions.clear();
      queueAttempts.clear();
      safeSetItem("litepaseo-composer-signout", newId());
    } else {
      // Staged uploads belonged to the old session; keep the files and let them upload again.
      attachments.forgetRemote("Sign in again, then retry the upload.");
    }
  }

  onUnmounted(() => {
    clearTimeout(noticeTimer);
    clearInterval(deliveryTimer);
    attachments.clear();
    optimistic.clearAll();
    window.removeEventListener("storage", onStorage);
    queueSummaryStream?.close();
    queueStream?.close();
  });

  return {
    element, autosize,
    attachments, selectedAttachments, attachmentsReady,
    optimistic,
    prompt, composerHasContent, uncertain, savedDrafts, restoreDraft, warning: drafts.warning,
    checkingDelivery, deliveryNotice, checkDelivery, acknowledgeMessage,
    queued, queueSummary, editingQueued, queuedText, controlQueue, removeQueued, editQueued, interruptWith,
    dictationReady, loadDictation, notice, showNotice,
    behavior, running, deliveryModes, deliveryMode,
    offerSuggestion, composerSuggestion,
    send, stop, respond,
    signedOut,
  };
}

export type Composer = ReturnType<typeof useComposer>;
