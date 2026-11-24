import { reactive } from "vue";
import type { TimelineRow } from "../shared/wire.ts";

export interface OptimisticMessage {
  messageId: string;
  agentKey: string;
  text: string;
  /** Object URLs owned by this optimistic bubble (revoked when removed). */
  images: string[];
  /** Non-image attachment names shown while waiting for the daemon row. */
  attachmentNames: string[];
  /** "sending" while POST /messages is in flight; "sent" after HTTP 200 until the real row lands. */
  status: "sending" | "sent";
  createdAt: number;
  /** Highest known timeline seqEnd when the send began, or -1 if empty/not ready. */
  baselineSeqEnd: number;
}

export interface AddOptimisticInput {
  messageId: string;
  agentKey: string;
  text: string;
  images?: string[];
  attachmentNames?: string[];
  baselineSeqEnd?: number;
}

const FALLBACK_EXPIRE_MS = 30_000;
const MAX_CONFIRMED_MEMORY = 200;

function rowMessageIds(item: Record<string, unknown>): { client?: string; server?: string } {
  const client = typeof item.clientMessageId === "string" && item.clientMessageId ? item.clientMessageId : undefined;
  const server = typeof item.messageId === "string" && item.messageId ? item.messageId : undefined;
  return { client, server };
}

/**
 * Identifies which optimistic messages are already represented by real daemon timeline rows.
 *
 * Pass 1 matches strictly by `clientMessageId` / `messageId`.
 * Pass 2 falls back to content matching only for rows strictly newer than `baselineSeqEnd`
 * (avoiding false matches against earlier identical prompts like "continue") and consumes
 * each real row at most once in FIFO order so duplicate rapid sends stay 1-to-1.
 */
export function findMatchedOptimisticIds(
  pending: readonly OptimisticMessage[],
  rows: readonly TimelineRow[],
): Set<string> {
  const matched = new Set<string>();
  if (!pending.length || !rows.length) return matched;

  const userRows = rows.filter((r) => r.item.type === "user_message");
  if (!userRows.length) return matched;

  const usedSeqStarts = new Set<number>();

  // Pass 1: exact ID match (clientMessageId or messageId).
  const byId = new Map<string, TimelineRow>();
  for (const row of userRows) {
    const ids = rowMessageIds(row.item as Record<string, unknown>);
    if (ids.client) byId.set(ids.client, row);
    if (ids.server && !byId.has(ids.server)) byId.set(ids.server, row);
  }
  for (const msg of pending) {
    const hit = byId.get(msg.messageId);
    if (hit && !usedSeqStarts.has(hit.seqStart)) {
      matched.add(msg.messageId);
      usedSeqStarts.add(hit.seqStart);
    }
  }

  // Pass 2: fallback content match for providers that do not echo clientMessageId.
  for (const msg of pending) {
    if (matched.has(msg.messageId)) continue;
    const wantedText = msg.text.trim();
    for (const row of userRows) {
      if (usedSeqStarts.has(row.seqStart)) continue;
      if (row.seqStart <= msg.baselineSeqEnd) continue;
      const item = row.item as Record<string, unknown>;
      const ids = rowMessageIds(item);
      // If the daemon explicitly echoed a different clientMessageId, it belongs to another send.
      if (ids.client && ids.client !== msg.messageId) continue;
      const rowText = typeof item.text === "string" ? item.text.trim() : "";
      if (wantedText) {
        if (rowText !== wantedText) continue;
      } else {
        if (rowText) continue;
        const rowImages = Array.isArray(item.imageUrls) ? item.imageUrls.length : 0;
        if (msg.images.length > 0 && rowImages === 0) continue;
        if (msg.images.length === 0 && msg.attachmentNames.length === 0) continue;
      }
      matched.add(msg.messageId);
      usedSeqStarts.add(row.seqStart);
      break;
    }
  }

  return matched;
}

/**
 * Holds in-flight and just-acknowledged user messages per conversation so they appear at 0 ms
 * on send, reconcile without duplicates against daemon rows, and revoke owned blob URLs cleanly.
 */
export class OptimisticStore {
  private readonly entries = reactive(new Map<string, OptimisticMessage[]>());
  private readonly confirmedIds: string[] = [];
  private readonly confirmedSet = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly revoke: (url: string) => void;
  private readonly expireMs: number;

  constructor({
    revoke = (url) => URL.revokeObjectURL(url),
    expireMs = FALLBACK_EXPIRE_MS,
  }: { revoke?: (url: string) => void; expireMs?: number } = {}) {
    this.revoke = revoke;
    this.expireMs = expireMs;
  }

  list(agentKey: string): readonly OptimisticMessage[] {
    return this.entries.get(agentKey) ?? [];
  }

  add(input: AddOptimisticInput): OptimisticMessage {
    const msg: OptimisticMessage = reactive({
      messageId: input.messageId,
      agentKey: input.agentKey,
      text: input.text,
      images: [...(input.images ?? [])],
      attachmentNames: [...(input.attachmentNames ?? [])],
      status: "sending",
      createdAt: Date.now(),
      baselineSeqEnd: input.baselineSeqEnd ?? -1,
    });
    const list = this.entries.get(input.agentKey) ?? [];
    this.entries.set(input.agentKey, [...list, msg]);
    return msg;
  }

  markSent(agentKey: string, messageId: string): boolean {
    const list = this.entries.get(agentKey);
    const msg = list?.find((m) => m.messageId === messageId);
    if (!msg) return false;
    msg.status = "sent";
    clearTimeout(this.timers.get(messageId));
    const timer = setTimeout(() => {
      this.timers.delete(messageId);
      this.remove(agentKey, messageId);
    }, this.expireMs);
    timer.unref?.();
    this.timers.set(messageId, timer);
    return true;
  }

  remove(agentKey: string, messageId: string): void {
    const timer = this.timers.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(messageId);
    }
    const list = this.entries.get(agentKey);
    if (!list?.length) return;
    const removed = list.find((m) => m.messageId === messageId);
    if (!removed) return;
    for (const url of removed.images) this.safeRevoke(url);
    const next = list.filter((m) => m.messageId !== messageId);
    if (next.length) this.entries.set(agentKey, next);
    else this.entries.delete(agentKey);
  }

  reconcile(agentKey: string, rows: readonly TimelineRow[]): string[] {
    const list = this.entries.get(agentKey);
    if (!list?.length) return [];
    const matched = findMatchedOptimisticIds(list, rows);
    if (!matched.size) return [];
    const removedIds: string[] = [];
    for (const id of matched) {
      this.rememberConfirmed(id);
      this.remove(agentKey, id);
      removedIds.push(id);
    }
    return removedIds;
  }

  wasConfirmed(messageId: string): boolean {
    return this.confirmedSet.has(messageId);
  }

  clearAgent(agentKey: string, onlySent = false): void {
    const list = this.entries.get(agentKey);
    if (!list?.length) return;
    for (const msg of [...list]) {
      if (onlySent && msg.status !== "sent") continue;
      this.remove(agentKey, msg.messageId);
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const list of this.entries.values()) {
      for (const msg of list) {
        for (const url of msg.images) this.safeRevoke(url);
      }
    }
    this.entries.clear();
    this.confirmedIds.length = 0;
    this.confirmedSet.clear();
  }

  private rememberConfirmed(messageId: string) {
    if (this.confirmedSet.has(messageId)) return;
    this.confirmedSet.add(messageId);
    this.confirmedIds.push(messageId);
    if (this.confirmedIds.length > MAX_CONFIRMED_MEMORY) {
      const oldest = this.confirmedIds.shift();
      if (oldest) this.confirmedSet.delete(oldest);
    }
  }

  private safeRevoke(url: string) {
    try {
      this.revoke(url);
    } catch {
      /* ignore */
    }
  }
}
