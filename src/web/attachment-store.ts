import { reactive } from "vue";
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
      const entry: LocalAttachment = reactive({ localId: crypto.randomUUID(), file, preview: image ? URL.createObjectURL(file) : undefined, error: "", uploading: false, cancelled: false, base });
      this.entries.set(key, [...this.get(key), entry]);
      void this.upload(entry);
    }
  }
  async upload(entry: LocalAttachment) {
    if (entry.uploading || entry.cancelled) return;
    entry.error = ""; entry.uploading = true;
    entry.controller = new AbortController();
    try {
      if (entry.id) await this.discardRemote(entry);
      const response = await fetch(entry.base + "/attachments", { method: "POST", body: entry.file,
        headers: { "x-litepaseo": "1", "x-file-name": encodeURIComponent(entry.file.name), "content-type": entry.file.type || "application/octet-stream" },
        signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(60_000)]),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Upload failed");
      entry.id = data.id;
      if (entry.cancelled) await this.discardRemote(entry);
    } catch (error) { if (!entry.cancelled) entry.error = (error as Error).message; }
    finally { entry.uploading = false; }
  }
  private async discardRemote(entry: LocalAttachment) {
    const id = entry.id; entry.id = undefined;
    if (id) await fetch(entry.base + "/attachments/" + encodeURIComponent(id), { method: "DELETE", headers: { "x-litepaseo": "1" }, signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
  remove(key: string, entry: LocalAttachment, consumed = false) {
    entry.cancelled = true; entry.controller?.abort();
    if (entry.preview) URL.revokeObjectURL(entry.preview);
    this.entries.set(key, this.get(key).filter(e => e.localId !== entry.localId));
    if (!consumed) void this.discardRemote(entry);
  }
  consume(key: string, ids: string[]) {
    for (const entry of this.get(key)) if (entry.id && ids.includes(entry.id)) this.remove(key, entry, true);
  }
  clear() { for (const [key, entries] of this.entries) for (const entry of entries) this.remove(key, entry); this.entries.clear(); }
}
