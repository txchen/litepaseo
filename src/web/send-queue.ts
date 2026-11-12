import { reactive } from "vue";
import type { LocalAttachment } from "./attachment-store.ts";

/** A message written while the agent works, held here until its turn ends. */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: LocalAttachment[];
  /** Delivery was refused; the queue pauses at this message until it is sent, edited or removed. */
  error?: string;
}

/**
 * Messages waiting for the running turn to finish, per agent. They stay in this tab (attachment
 * files are in memory) and are not sent anywhere until dispatch, so they can still be edited,
 * removed, or sent at once as an interrupt.
 */
export class SendQueue {
  readonly entries = reactive(new Map<string, QueuedMessage[]>());
  get(key: string): QueuedMessage[] { return this.entries.get(key) ?? []; }
  keys() { return [...this.entries.keys()]; }
  get size() { let n = 0; for (const list of this.entries.values()) n += list.length; return n; }
  add(key: string, message: QueuedMessage) { this.entries.set(key, [...this.get(key), message]); }
  /** Puts a message back at the head (a refused delivery), keeping its place in line. */
  unshift(key: string, message: QueuedMessage) { this.entries.set(key, [message, ...this.get(key).filter(m => m.id !== message.id)]); }
  take(key: string, id: string): QueuedMessage | null {
    const list = this.get(key);
    const message = list.find(m => m.id === id) ?? null;
    if (!message) return null;
    const rest = list.filter(m => m.id !== id);
    if (rest.length) this.entries.set(key, rest);
    else this.entries.delete(key);
    return message;
  }
  /** The next message to dispatch, or null when empty or paused at a refused one. */
  next(key: string): QueuedMessage | null {
    const head = this.get(key)[0];
    return head && !head.error ? head : null;
  }
  clear() { this.entries.clear(); }
}
