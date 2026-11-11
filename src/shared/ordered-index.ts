/**
 * Order-statistic treap. insert/remove/at/rank are O(log n) expected, so keeping a large
 * sorted list current costs O(log n) per change instead of a re-sort or array splice.
 * The comparator must be a total order (break ties with a unique key).
 */
interface Node<T> {
  item: T;
  priority: number;
  size: number;
  left: Node<T> | null;
  right: Node<T> | null;
}

const size = <T>(node: Node<T> | null) => (node ? node.size : 0);
const update = <T>(node: Node<T>) => {
  node.size = 1 + size(node.left) + size(node.right);
  return node;
};

export class OrderedIndex<T> {
  private root: Node<T> | null = null;
  private readonly compare: (a: T, b: T) => number;
  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  get size() {
    return size(this.root);
  }

  clear() {
    this.root = null;
  }

  insert(item: T) {
    const [less, rest] = this.split(this.root, item, false);
    const node: Node<T> = { item, priority: Math.random(), size: 1, left: null, right: null };
    this.root = this.merge(this.merge(less, node), rest);
  }

  /** Removes the item that compares equal to `item`; returns whether one existed. */
  remove(item: T) {
    const [less, rest] = this.split(this.root, item, false);
    const [equal, greater] = this.split(rest, item, true);
    this.root = this.merge(less, greater);
    return equal !== null;
  }

  at(index: number): T | undefined {
    let node = this.root;
    while (node) {
      const leftSize = size(node.left);
      if (index < leftSize) node = node.left;
      else if (index === leftSize) return node.item;
      else {
        index -= leftSize + 1;
        node = node.right;
      }
    }
    return undefined;
  }

  /** Position of an item known to be present, or -1. */
  rank(item: T) {
    let node = this.root,
      before = 0;
    while (node) {
      const c = this.compare(item, node.item);
      if (c < 0) node = node.left;
      else if (c > 0) {
        before += size(node.left) + 1;
        node = node.right;
      } else return before + size(node.left);
    }
    return -1;
  }

  /** Items in [start, start + count): O(log n + count). */
  range(start: number, count: number): T[] {
    const out: T[] = [];
    const end = Math.min(this.size, start + count);
    start = Math.max(0, start);
    if (start >= end) return out;
    // Descend to `start`, keeping the ancestors still to be visited in order.
    const stack: Node<T>[] = [];
    let node = this.root,
      index = start;
    while (node) {
      const leftSize = size(node.left);
      if (index < leftSize) {
        stack.push(node);
        node = node.left;
      } else if (index === leftSize) {
        stack.push(node);
        break;
      } else {
        index -= leftSize + 1;
        node = node.right;
      }
    }
    while (out.length < end - start && stack.length) {
      const current = stack.pop()!;
      out.push(current.item);
      let next = current.right;
      while (next) {
        stack.push(next);
        next = next.left;
      }
    }
    return out;
  }

  /** Splits into (< item, >= item), or (<= item, > item) when `inclusive`. */
  private split(node: Node<T> | null, item: T, inclusive: boolean): [Node<T> | null, Node<T> | null] {
    if (!node) return [null, null];
    const c = this.compare(node.item, item);
    if (c < 0 || (inclusive && c === 0)) {
      const [left, right] = this.split(node.right, item, inclusive);
      node.right = left;
      return [update(node), right];
    }
    const [left, right] = this.split(node.left, item, inclusive);
    node.left = right;
    return [left, update(node)];
  }

  private merge(left: Node<T> | null, right: Node<T> | null): Node<T> | null {
    if (!left) return right;
    if (!right) return left;
    if (left.priority > right.priority) {
      left.right = this.merge(left.right, right);
      return update(left);
    }
    right.left = this.merge(left, right.left);
    return update(right);
  }
}
