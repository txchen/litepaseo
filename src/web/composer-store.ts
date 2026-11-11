import { reactive, ref } from "vue";

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
export interface PendingMessage { messageId: string; text: string; attachmentIds?: string[]; attachmentNames?: string[] }
interface SavedDraft { key: string; text: string; updated: number; restoredFrom?: string }
type StoredMessage = PendingMessage & { key: string };
const PREFIX = "litepaseo-composer-v1:";
const DRAFT = PREFIX + "draft:";
const MESSAGE = PREFIX + "message:";
/** Drafts left by closed tabs are offered for restore, but not forever. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Recovery choices kept per conversation; older ones are dropped. */
export const DRAFTS_PER_CONVERSATION = 8;

/**
 * Each page owns a draft slot; concurrent tabs never overwrite one another's text.
 * Storage is scanned once at startup. After that an in-memory index per conversation is kept
 * current by this tab's own writes and by other tabs' storage events, so typing and rendering
 * cost O(drafts of this conversation), independent of everything else in localStorage.
 */
export class ComposerStore {
  readonly warning = ref("");
  readonly revision = ref(0);
  generation = 0;
  private readonly drafts = reactive(new Map<string, { text: string; source?: string; sourceValue?: string; restoredFrom?: string }>());
  private readonly pending = reactive(new Map<string, PendingMessage[]>());
  private readonly owner = crypto.randomUUID();
  private storage: StoragePort | null;
  /** conversation key -> slot -> saved draft (with the raw value, for compare-and-delete). */
  private readonly savedIndex = new Map<string, Map<string, SavedDraft & { raw: string }>>();
  private readonly messageIndex = new Map<string, Map<string, StoredMessage>>();
  /** slot -> conversation key, so removals and replacements find their entry. */
  private readonly slotKey = new Map<string, string>();

  constructor(storage: () => StoragePort, now = Date.now()) {
    try { this.storage = storage(); }
    catch { this.storage = null; this.unavailable(); }
    this.rescan(now);
  }
  private unavailable() { this.warning.value = "Draft storage is unavailable. Keep this tab open to retain your text."; }
  private attempt<T>(fn: (s: StoragePort) => T, fallback: T): T {
    if (!this.storage) return fallback;
    try { return fn(this.storage); } catch { this.unavailable(); return fallback; }
  }
  private decode(raw: string): any { try { return JSON.parse(raw); } catch { return null; } }
  private slot(key: string) { return `${DRAFT}${this.owner}:${encodeURIComponent(key)}`; }

  /** Full scan: startup, and the rare "storage was cleared" event. Also expires old drafts. */
  private rescan(now = Date.now()) {
    this.savedIndex.clear();
    this.messageIndex.clear();
    this.slotKey.clear();
    const slots = this.attempt(s => {
      const found: [string, string][] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k?.startsWith(PREFIX)) found.push([k, s.getItem(k)!]);
      }
      return found;
    }, []);
    const expired: string[] = [];
    for (const [slot, raw] of slots) {
      const draft = slot.startsWith(DRAFT) ? this.decode(raw) : null;
      if (draft && Number.isFinite(draft.updated) && now - draft.updated > DRAFT_MAX_AGE_MS) expired.push(slot);
      else this.apply(slot, raw);
    }
    for (const [key] of this.savedIndex) expired.push(...this.excess(key));
    for (const slot of expired) this.remove(slot);
    this.revision.value++;
  }
  /** Slots beyond the per-conversation cap, oldest first. */
  private excess(key: string) {
    const entries = this.savedIndex.get(key);
    if (!entries || entries.size <= DRAFTS_PER_CONVERSATION) return [];
    return [...entries].sort((a, b) => b[1].updated - a[1].updated).slice(DRAFTS_PER_CONVERSATION)
      .map(([slot]) => slot).filter(slot => slot !== this.slot(key));
  }
  /** Updates the index for one slot; raw === null means the slot was removed. */
  private apply(slot: string, raw: string | null) {
    const previous = this.slotKey.get(slot);
    if (previous !== undefined) {
      this.slotKey.delete(slot);
      const drafts = this.savedIndex.get(previous);
      drafts?.delete(slot);
      if (drafts && !drafts.size) this.savedIndex.delete(previous);
      const messages = this.messageIndex.get(previous);
      messages?.delete(slot);
      if (messages && !messages.size) this.messageIndex.delete(previous);
    }
    if (raw === null) return;
    const value = this.decode(raw);
    if (typeof value?.key !== "string" || typeof value.text !== "string") return;
    if (slot.startsWith(DRAFT)) {
      if (!value.text || !Number.isFinite(value.updated)) return;
      let drafts = this.savedIndex.get(value.key);
      if (!drafts) this.savedIndex.set(value.key, drafts = new Map());
      drafts.set(slot, { key: value.key, text: value.text, updated: value.updated, restoredFrom: value.restoredFrom, raw });
    } else if (slot.startsWith(MESSAGE)) {
      if (typeof value.messageId !== "string") return;
      let messages = this.messageIndex.get(value.key);
      if (!messages) this.messageIndex.set(value.key, messages = new Map());
      messages.set(slot, value);
    } else return;
    this.slotKey.set(slot, value.key);
  }
  private write(slot: string, raw: string) {
    this.storage!.setItem(slot, raw); // throws on quota: the index is only updated on success
    this.apply(slot, raw);
  }
  private remove(slot: string) {
    this.attempt(s => { s.removeItem(slot); return true; }, false);
    this.apply(slot, null);
  }

  /** Another tab changed localStorage (the browser's storage event). */
  onStorage(slot: string | null, newValue: string | null) {
    if (slot === null) return this.rescan(); // storage.clear()
    if (!slot.startsWith(PREFIX)) return;
    this.apply(slot, newValue);
    this.revision.value++;
  }

  saved(key: string): (SavedDraft & { slot: string })[] {
    this.revision.value;
    const drafts = this.savedIndex.get(key);
    if (!drafts) return [];
    return [...drafts].map(([slot, { raw: _raw, ...draft }]) => ({ ...draft, slot })).sort((a, b) => b.updated - a.updated);
  }
  state(key: string) {
    let state = this.drafts.get(key);
    if (!state) {
      const saved = this.saved(key)[0];
      this.drafts.set(key, { text: saved?.text ?? "", restoredFrom: saved?.restoredFrom, source: saved?.slot,
        sourceValue: saved ? this.savedIndex.get(key)?.get(saved.slot)?.raw : undefined });
      state = this.drafts.get(key)!;
    }
    return state;
  }
  setText(key: string, text: string, restoredFrom?: string) {
    const state = this.state(key);
    state.text = text;
    state.restoredFrom = restoredFrom;
    this.attempt(s => {
      // Persist first: a full disk must not destroy the recoverable source draft.
      if (text) this.write(this.slot(key), JSON.stringify({ key, text, restoredFrom, updated: Date.now() }));
      if (state.source && s.getItem(state.source) === state.sourceValue) this.remove(state.source);
      state.source = state.sourceValue = undefined;
      if (!text) this.remove(this.slot(key));
      return true;
    }, false);
    this.revision.value++;
  }
  restore(key: string, slot: string) {
    const saved = this.saved(key).find(d => d.slot === slot);
    if (!saved) return;
    // Keep the current draft as another recovery choice before replacing it.
    const current = this.state(key).text;
    if (current && current !== saved.text) this.attempt(() => {
      this.write(`${DRAFT}${crypto.randomUUID()}:${encodeURIComponent(key)}`, JSON.stringify({ key, text: current, updated: Date.now() }));
      for (const old of this.excess(key)) this.remove(old);
      return true;
    }, false);
    this.setText(key, saved.text);
  }
  unresolved(key: string) {
    this.revision.value;
    const found = new Map((this.pending.get(key) ?? []).map(p => [p.messageId, p]));
    for (const value of this.messageIndex.get(key)?.values() ?? []) found.set(value.messageId, value);
    return [...found.values()];
  }
  begin(key: string, message: PendingMessage) {
    const saved = this.attempt(() => { this.write(MESSAGE + message.messageId, JSON.stringify({ key, ...message })); return true; }, false);
    if (!saved) this.pending.set(key, [...this.unresolved(key), message]);
    this.revision.value++;
  }
  resolve(key: string, messageId: string) {
    this.pending.set(key, (this.pending.get(key) ?? []).filter(p => p.messageId !== messageId));
    this.remove(MESSAGE + messageId);
    this.revision.value++;
  }
  restoreFailed(key: string, message: PendingMessage) {
    if (!this.state(key).text) this.setText(key, message.text, message.messageId);
  }
  confirm(key: string, messageId: string) {
    const state = this.state(key);
    if (state.restoredFrom === messageId) this.setText(key, "");
    this.resolve(key, messageId);
  }
  /** Re-reads storage from scratch; only for callers that cannot deliver storage events. */
  refresh() { this.rescan(); }
  clear() {
    this.generation++;
    for (const slot of [...this.slotKey.keys()]) this.remove(slot);
    // Also unparseable leftovers under our prefix, which the index does not track.
    this.attempt(s => {
      const stray: string[] = [];
      for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(PREFIX)) stray.push(k); }
      for (const k of stray) s.removeItem(k);
      return true;
    }, false);
    this.drafts.clear();
    this.pending.clear();
    this.revision.value++;
  }
}
