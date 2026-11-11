import { randomUUID } from "node:crypto";

export interface Change<T> {
  key: string;
  value: T | null;
}

interface Node<T> {
  key: string;
  value: T | null;
  seq: number;
  prev: Node<T> | null;
  next: Node<T> | null;
}

/**
 * Keyed values ordered by their last change. Every write moves the entry to the tail, so
 * `changesSince(seq)` walks back only over entries changed after `seq`: O(changes), never
 * O(collection). Deletions stay as tombstones until the bounded tombstone budget evicts them;
 * readers older than the evicted horizon (`floor`) must take a snapshot instead.
 */
export class VersionedCollection<T> {
  readonly generation = randomUUID();
  private readonly nodes = new Map<string, Node<T>>();
  private head: Node<T> | null = null;
  private tail: Node<T> | null = null;
  private current = 0;
  private floor = 0;
  private live = 0;
  private tombstones: { node: Node<T>; seq: number }[] = [];
  private tombstoneHead = 0;

  private readonly maxTombstones: number;
  constructor(maxTombstones = 4096) {
    this.maxTombstones = maxTombstones;
  }

  get seq() {
    return this.current;
  }

  get size() {
    return this.live;
  }

  get(key: string): T | undefined {
    const node = this.nodes.get(key);
    return node && node.value !== null ? node.value : undefined;
  }

  set(key: string, value: T) {
    let node = this.nodes.get(key);
    if (node) {
      if (node.value === null) this.live++;
      this.unlink(node);
    } else {
      node = { key, value, seq: 0, prev: null, next: null };
      this.nodes.set(key, node);
      this.live++;
    }
    node.value = value;
    node.seq = ++this.current;
    this.append(node);
  }

  delete(key: string) {
    const node = this.nodes.get(key);
    if (!node || node.value === null) return false;
    this.live--;
    node.value = null;
    node.seq = ++this.current;
    this.unlink(node);
    this.append(node);
    this.tombstones.push({ node, seq: node.seq });
    this.evictTombstones();
    return true;
  }

  /** Latest value of each entry changed after `after`, oldest first; null when a snapshot is required. */
  changesSince(after: number): Change<T>[] | null {
    if (after < this.floor || after > this.current) return null;
    const out: Change<T>[] = [];
    for (let node = this.tail; node && node.seq > after; node = node.prev)
      out.push({ key: node.key, value: node.value });
    return out.reverse();
  }

  /** Full contents. O(n); only for first loads and readers past the tombstone horizon. */
  snapshot(): T[] {
    const out: T[] = [];
    for (let node = this.head; node; node = node.next) if (node.value !== null) out.push(node.value);
    return out;
  }

  private evictTombstones() {
    while (this.tombstones.length - this.tombstoneHead > this.maxTombstones) {
      const { node, seq } = this.tombstones[this.tombstoneHead++];
      // A record is stale when the key was rewritten after this deletion.
      if (node.value !== null || node.seq !== seq || this.nodes.get(node.key) !== node) continue;
      this.unlink(node);
      this.nodes.delete(node.key);
      this.floor = Math.max(this.floor, seq);
    }
    if (this.tombstoneHead > 1024 && this.tombstoneHead * 2 > this.tombstones.length) {
      this.tombstones = this.tombstones.slice(this.tombstoneHead);
      this.tombstoneHead = 0;
    }
  }

  private unlink(node: Node<T>) {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = node.next = null;
  }

  private append(node: Node<T>) {
    node.prev = this.tail;
    node.next = null;
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;
  }
}
