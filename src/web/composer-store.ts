import { reactive, ref } from "vue";

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
export interface PendingMessage { messageId: string; text: string }
interface SavedDraft { key: string; text: string; updated: number }
const PREFIX = "litepaseo-composer-v1:";

/** Each page owns a draft slot; concurrent tabs never overwrite one another's text. */
export class ComposerStore {
  readonly warning = ref("");
  readonly revision = ref(0);
  generation = 0;
  private readonly drafts = reactive(new Map<string, { text: string; source?: string; sourceValue?: string }>());
  private readonly pending = reactive(new Map<string, PendingMessage[]>());
  private readonly owner = crypto.randomUUID();
  private storage: StoragePort | null;

  constructor(storage: () => StoragePort) {
    try { this.storage = storage(); }
    catch { this.storage = null; this.unavailable(); }
  }
  private unavailable() { this.warning.value = "Draft storage is unavailable. Keep this tab open to retain your text."; }
  private attempt<T>(fn: (s: StoragePort) => T, fallback: T): T {
    if (!this.storage) return fallback;
    try { return fn(this.storage); } catch { this.unavailable(); return fallback; }
  }
  private entries(): [string, string][] {
    return this.attempt(s => {
      const entries: [string, string][] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k?.startsWith(PREFIX)) entries.push([k, s.getItem(k)!]);
      }
      return entries;
    }, []);
  }
  private decode(raw: string): any { try { return JSON.parse(raw); } catch { return null; } }
  private slot(key: string) { return `${PREFIX}draft:${this.owner}:${encodeURIComponent(key)}`; }
  saved(key: string): (SavedDraft & { slot: string })[] {
    this.revision.value;
    return this.entries().flatMap(([slot, raw]) => {
      const value = this.decode(raw);
      return slot.startsWith(PREFIX + "draft:") && value?.key === key && typeof value.text === "string" && value.text && Number.isFinite(value.updated)
        ? [{ ...value, slot }] : [];
    }).sort((a, b) => b.updated - a.updated);
  }
  state(key: string) {
    let state = this.drafts.get(key);
    if (!state) {
      const saved = this.saved(key)[0];
      this.drafts.set(key, { text: saved?.text ?? "", source: saved?.slot,
        sourceValue: saved ? this.attempt(s => s.getItem(saved.slot) ?? undefined, undefined) : undefined });
      state = this.drafts.get(key)!;
    }
    return state;
  }
  setText(key: string, text: string) {
    const state = this.state(key);
    state.text = text;
    this.attempt(s => {
      // Persist first: a full disk must not destroy the recoverable source draft.
      s.setItem(this.slot(key), JSON.stringify({ key, text, updated: Date.now() }));
      if (state.source && s.getItem(state.source) === state.sourceValue) s.removeItem(state.source);
      state.source = state.sourceValue = undefined;
      if (!text) s.removeItem(this.slot(key));
      return true;
    }, false);
    this.revision.value++;
  }
  restore(key: string, slot: string) {
    const saved = this.saved(key).find(d => d.slot === slot);
    if (!saved) return;
    // Keep the current draft as another recovery choice before replacing it.
    const current = this.state(key).text;
    if (current && current !== saved.text) this.attempt(s => {
      s.setItem(`${PREFIX}draft:${crypto.randomUUID()}:${encodeURIComponent(key)}`, JSON.stringify({ key, text: current, updated: Date.now() }));
      return true;
    }, false);
    this.setText(key, saved.text);
  }
  unresolved(key: string) {
    this.revision.value;
    const found = new Map((this.pending.get(key) ?? []).map(p => [p.messageId, p]));
    for (const [slot, raw] of this.entries()) {
      const value = this.decode(raw);
      if (slot.startsWith(PREFIX + "message:") && value?.key === key && typeof value.text === "string" && typeof value.messageId === "string")
        found.set(value.messageId, value);
    }
    return [...found.values()];
  }
  begin(key: string, message: PendingMessage) {
    const saved = this.attempt(s => { s.setItem(PREFIX + "message:" + message.messageId, JSON.stringify({ key, ...message })); return true; }, false);
    if (!saved) this.pending.set(key, [...this.unresolved(key), message]);
    this.revision.value++;
  }
  resolve(key: string, messageId: string) {
    this.pending.set(key, (this.pending.get(key) ?? []).filter(p => p.messageId !== messageId));
    this.attempt(s => { s.removeItem(PREFIX + "message:" + messageId); return true; }, false);
    this.revision.value++;
  }
  refresh() { this.revision.value++; }
  clear() {
    this.generation++;
    for (const [slot] of this.entries()) this.attempt(s => { s.removeItem(slot); return true; }, false);
    this.drafts.clear();
    this.pending.clear();
    this.revision.value++;
  }
}
