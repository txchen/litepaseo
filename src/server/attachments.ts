import { randomUUID } from "node:crypto";
import type { Hosts } from "./hosts.ts";
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024, TTL = 20 * 60_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
interface Entry { id: string; owner: string; host: string; agent: string; name: string; mime: string; bytes: Buffer; expires: number; remote?: any }
export class Attachments {
  private entries = new Map<string, Entry>();
  private timer = setInterval(() => this.prune(), 60_000);
  constructor() { this.timer.unref(); }
  close() { clearInterval(this.timer); this.entries.clear(); }
  private prune() { for (const [id, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(id); }
  clearOwner(owner: string) { for (const [id, entry] of this.entries) if (entry.owner === owner) this.entries.delete(id); }
  put(owner: string, host: string, agent: string, name: string, mime: string, bytes: Buffer) {
    this.prune();
    if (!name || name.length > 200 || /[\x00-\x1f/\\]/.test(name)) throw new Error("Use a file name without path separators.");
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error("Files must be between 1 byte and 8 MiB.");
    const total = [...this.entries.values()].reduce((n, e) => n + e.bytes.length, 0);
    const own = [...this.entries.values()].filter(e => e.owner === owner).reduce((n, e) => n + e.bytes.length, 0);
    if (total + bytes.length > MAX_TOTAL || own + bytes.length > 24 * 1024 * 1024) throw new Error("Attachment staging is full. Remove files or wait for them to expire.");
    if (IMAGE_TYPES.has(mime)) {
      const valid = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : mime === "image/gif" ? /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
        : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
      if (!valid) throw new Error("Image content does not match its file type.");
    }
    const entry: Entry = { id: randomUUID(), owner, host, agent, name, mime, bytes, expires: Date.now() + TTL };
    this.entries.set(entry.id, entry);
    return { id: entry.id, name, mimeType: mime, size: bytes.length, expires: entry.expires };
  }
  get(id: string, owner: string, host: string, agent: string) {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner || entry.host !== host || entry.agent !== agent) throw new Error("Attachment expired or belongs to another session. Select it again.");
    return entry;
  }
  remove(id: string, owner: string, host: string, agent: string) { this.get(id, owner, host, agent); this.entries.delete(id); }
  async capabilities(hosts: Hosts, host: string, agent: string) {
    const ref = hosts.get(host).api.agents.ref(agent);
    await ref.refresh();
    const current = ref.current();
    // The installed SDK has no per-model image capability. Restrict to known native adapters.
    const provider = current?.provider ?? "";
    return { images: ["codex", "claude", "pi"].includes(provider) && ref.capabilities?.supportsImages !== false,
      files: ref.capabilities?.supportsToolInvocations === true, maxBytes: MAX_FILE_BYTES,
      note: "Images require a vision-capable model. Other files are uploaded to the daemon for the agent to read with its tools." };
  }
  async prepare(hosts: Hosts, owner: string, host: string, agent: string, ids: string[]) {
    const entries = ids.map(id => this.get(id, owner, host, agent));
    if (!entries.length) return { images: [], attachments: [] };
    const caps = await this.capabilities(hosts, host, agent).catch(() => { throw new Error("Could not verify attachment support. Reconnect the host and retry."); });
    const images: { data: string; mimeType: string }[] = [], attachments: any[] = [];
    for (const entry of entries) {
      if (IMAGE_TYPES.has(entry.mime)) {
        if (!caps.images) throw new Error("This provider does not support image attachments.");
        images.push({ data: entry.bytes.toString("base64"), mimeType: entry.mime });
      } else {
        if (!caps.files) throw new Error("This agent cannot read uploaded files.");
        if (!entry.remote) {
          const uploaded = await hosts.get(host).driver.uploadFile({ fileName: entry.name, mimeType: entry.mime, bytes: entry.bytes }).catch(() => { throw new Error("Daemon file upload failed. Retry the upload before sending."); });
          if (uploaded.error || !uploaded.file) throw new Error("Daemon file upload failed. Retry the upload before sending.");
          entry.remote = uploaded.file;
        }
        attachments.push(entry.remote);
      }
    }
    return { images, attachments };
  }
  consumed(ids: string[]) { for (const id of ids) this.entries.delete(id); }
}
