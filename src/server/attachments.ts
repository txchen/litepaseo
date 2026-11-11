import { randomUUID } from "node:crypto";
import type { Hosts } from "./hosts.ts";
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024, TTL = 20 * 60_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
interface Entry { id: string; owner: string; host: string; agent: string; name: string; mime: string; bytes: Buffer; expires: number; remote?: any }
/** Staged files per signed-in session and server-wide; the UI offers 4 per conversation. */
export const MAX_FILES_PER_OWNER = 16;
const MAX_FILES = 256;
export class Attachments {
  /** Insertion order is expiry order (fixed TTL), so pruning stops at the first live entry. */
  private entries = new Map<string, Entry>();
  private totalBytes = 0;
  private readonly owners = new Map<string, { bytes: number; files: number }>();
  private timer = setInterval(() => this.prune(), 60_000);
  constructor() { this.timer.unref(); }
  close() { clearInterval(this.timer); this.entries.clear(); this.owners.clear(); this.totalBytes = 0; }
  private delete(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.totalBytes -= entry.bytes.length;
    const own = this.owners.get(entry.owner)!;
    own.bytes -= entry.bytes.length;
    if (!--own.files) this.owners.delete(entry.owner);
  }
  /** O(expired entries). */
  private prune(now = Date.now()) {
    for (const [id, entry] of this.entries) {
      if (entry.expires > now) break;
      this.delete(id);
    }
  }
  clearOwner(owner: string) {
    if (!this.owners.has(owner)) return;
    for (const [id, entry] of this.entries) if (entry.owner === owner) this.delete(id);
  }
  put(owner: string, host: string, agent: string, name: string, mime: string, bytes: Buffer) {
    this.prune();
    if (!name || name.length > 200 || /[\x00-\x1f/\\]/.test(name)) throw new Error("Use a file name without path separators.");
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error("Files must be between 1 byte and 8 MiB.");
    const own = this.owners.get(owner) ?? { bytes: 0, files: 0 };
    if (this.totalBytes + bytes.length > MAX_TOTAL || own.bytes + bytes.length > 24 * 1024 * 1024
      || own.files >= MAX_FILES_PER_OWNER || this.entries.size >= MAX_FILES)
      throw new Error("Attachment staging is full. Remove files or wait for them to expire.");
    if (IMAGE_TYPES.has(mime)) {
      const valid = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : mime === "image/gif" ? /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
        : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
      if (!valid) throw new Error("Image content does not match its file type.");
    }
    const entry: Entry = { id: randomUUID(), owner, host, agent, name, mime, bytes, expires: Date.now() + TTL };
    this.entries.set(entry.id, entry);
    this.totalBytes += bytes.length;
    this.owners.set(owner, { bytes: own.bytes + bytes.length, files: own.files + 1 });
    return { id: entry.id, name, mimeType: mime, size: bytes.length, expires: entry.expires };
  }
  get(id: string, owner: string, host: string, agent: string) {
    this.prune();
    const entry = this.entries.get(id);
    if (entry && entry.expires <= Date.now()) this.delete(id);
    if (!entry || entry.expires <= Date.now() || entry.owner !== owner || entry.host !== host || entry.agent !== agent) throw new Error("Attachment expired or belongs to another session. Select it again.");
    return entry;
  }
  remove(id: string, owner: string, host: string, agent: string) { this.get(id, owner, host, agent); this.delete(id); }
  async capabilities(hosts: Hosts, host: string, agent: string) {
    const client = hosts.get(host);
    // The live directory already carries provider and capabilities: no daemon round trip.
    // Only an agent outside the active directory (e.g. just archived) is fetched.
    let facts: { provider?: string; capabilities?: { supportsImages?: boolean; supportsToolInvocations?: boolean } | null } | undefined =
      client.directory.facts(agent);
    if (!facts) {
      const ref = client.api.agents.ref(agent);
      await ref.refresh();
      facts = { provider: ref.current()?.provider, capabilities: ref.capabilities };
    }
    // The installed SDK has no per-model image capability. Restrict to known native adapters.
    const provider = facts.provider ?? "";
    return { images: ["codex", "claude", "pi"].includes(provider) && facts.capabilities?.supportsImages !== false,
      files: facts.capabilities?.supportsToolInvocations === true, maxBytes: MAX_FILE_BYTES,
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
  consumed(ids: string[]) { for (const id of ids) this.delete(id); }
}
