import { reactive } from "vue";
import { newId } from "./id.ts";
export interface LocalAttachment { localId: string; file: File; preview?: string; id?: string; error: string; uploading: boolean; cancelled: boolean; controller?: AbortController; base: string }
export class AttachmentStore {
  readonly entries = reactive(new Map<string, LocalAttachment[]>());
  get(key: string) { return this.entries.get(key) ?? []; }
  async add(key: string, base: string, files: File[], caps: { images: boolean; files: boolean; maxBytes: number }) {
    for (const file of files) {
      if (this.get(key).length >= 4) throw new Error("Attach up to four files per message.");
      if ([...this.entries.values()].flat().reduce((n, entry) => n + entry.file.size, 0) + file.size > 24 * 1024 * 1024) throw new Error("Attachments total more than 24 MiB. Remove files before adding more.");
      if (!file.size || file.size > caps.maxBytes) throw new Error("Files must be between 1 byte and 8 MiB.");
      const image = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type);
      if (image ? !caps.images : !caps.files) throw new Error(image ? "This provider does not support images." : "This agent cannot read uploaded files.");
      const entry: LocalAttachment = reactive({ localId: newId(), file, preview: image ? URL.createObjectURL(file) : undefined, error: "", uploading: false, cancelled: false, base });
      this.entries.set(key, [...this.get(key), entry]);
      void this.upload(entry);
    }
  }
  async upload(entry: LocalAttachment) {
    if (entry.uploading || entry.cancelled) return;
    entry.error = ""; entry.uploading = true;
    // This attempt owns the entry only while its controller is the entry's: a retry after
    // forgetRemote starts a new attempt, which the aborted one must not overwrite.
    const controller = new AbortController();
    entry.controller = controller;
    const current = () => entry.controller === controller;
    try {
      if (entry.id) await this.discardRemote(entry);
      const response = await fetch(entry.base + "/attachments", { method: "POST", body: entry.file,
        headers: { "x-litepaseo": "1", "x-file-name": encodeURIComponent(entry.file.name), "content-type": entry.file.type || "application/octet-stream" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      });
      // A proxy in front of the server may answer with an HTML error page (413, 502).
      const data = await response.json().catch(() => ({})) as { id?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? `Upload failed (${response.status})`);
      if (!data.id) throw new Error("Upload failed");
      if (!current() || controller.signal.aborted) {
        // Superseded or forgotten meanwhile: this upload is nobody's, so drop it on the server.
        void this.discardRemote({ ...entry, id: data.id });
        return;
      }
      entry.id = data.id;
      if (entry.cancelled) await this.discardRemote(entry);
    } catch (error) {
      // An abort from forgetRemote already explains what to do; keep that message.
      if (current() && !entry.cancelled && !controller.signal.aborted) entry.error = (error as Error).message;
    }
    finally { if (current()) entry.uploading = false; }
  }
  private async discardRemote(entry: Pick<LocalAttachment, "id" | "base">) {
    const id = entry.id; entry.id = undefined;
    if (id) await fetch(entry.base + "/attachments/" + encodeURIComponent(id), { method: "DELETE", headers: { "x-litepaseo": "1" }, signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
  remove(key: string, entry: LocalAttachment, consumed = false) {
    entry.cancelled = true; entry.controller?.abort();
    if (entry.preview) URL.revokeObjectURL(entry.preview);
    this.entries.set(key, this.get(key).filter(e => e.localId !== entry.localId));
    if (!consumed) void this.discardRemote(entry);
  }
  /** Hands the staged files to a queued message; uploads stay on the server. */
  detach(key: string): LocalAttachment[] {
    const entries = this.get(key);
    this.entries.delete(key);
    return entries;
  }
  /** Files back from a queued message; beyond four per message they are discarded. */
  reattach(key: string, entries: LocalAttachment[]) {
    const combined = [...this.get(key), ...entries];
    for (const extra of combined.slice(4)) this.remove(key, extra);
    this.entries.set(key, combined.slice(0, 4));
  }
  consume(key: string, ids: string[]) {
    for (const entry of this.get(key)) if (entry.id && ids.includes(entry.id)) this.remove(key, entry, true);
  }
  /** The staging session is gone: keep the chosen files, mark them for a fresh upload. */
  forgetRemote(message: string) {
    for (const entries of this.entries.values())
      for (const entry of entries) {
        entry.controller?.abort();
        entry.id = undefined;
        entry.uploading = false;
        entry.error = message;
      }
  }
  clear() { for (const [key, entries] of this.entries) for (const entry of entries) this.remove(key, entry); this.entries.clear(); }
}
