/**
 * Ordered treap whose nodes carry a weight (e.g. a group's rendered height). Besides rank/at it
 * answers "which item covers offset x" and "where does item k start" in O(log n), so a
 * virtualized list of variable-height groups never walks the groups above the viewport.
 * Weights change by remove + insert (O(log n)).
 */
interface Node<T> {
  item: T;
  weight: number;
  priority: number;
  size: number;
  sum: number;
  left: Node<T> | null;
  right: Node<T> | null;
}

const size = <T>(n: Node<T> | null) => (n ? n.size : 0);
const sum = <T>(n: Node<T> | null) => (n ? n.sum : 0);
const update = <T>(n: Node<T>) => {
  n.size = 1 + size(n.left) + size(n.right);
  n.sum = n.weight + sum(n.left) + sum(n.right);
  return n;
};

export class WeightedIndex<T> {
  private root: Node<T> | null = null;
  private readonly compare: (a: T, b: T) => number;
  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  get size() {
    return size(this.root);
  }

  get total() {
    return sum(this.root);
  }

  clear() {
    this.root = null;
  }

  insert(item: T, weight: number) {
    const [less, rest] = this.split(this.root, item, false);
    const node: Node<T> = { item, weight, priority: Math.random(), size: 1, sum: weight, left: null, right: null };
    this.root = this.merge(this.merge(less, node), rest);
  }

  remove(item: T) {
    const [less, rest] = this.split(this.root, item, false);
    const [equal, greater] = this.split(rest, item, true);
    this.root = this.merge(less, greater);
    return equal !== null;
  }

  /** Re-weights an item already present. */
  reweigh(item: T, weight: number) {
    if (this.remove(item)) this.insert(item, weight);
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

  /** The item whose span contains `offset`, its rank and where that span starts. */
  locate(offset: number): { item: T; rank: number; start: number } | null {
    let node = this.root,
      rank = 0,
      start = 0;
    if (!node) return null;
    offset = Math.max(0, Math.min(offset, this.total - 1e-9));
    while (node) {
      const leftSum = sum(node.left);
      if (offset < leftSum) node = node.left;
      else if (offset < leftSum + node.weight || !node.right) {
        return { item: node.item, rank: rank + size(node.left), start: start + leftSum };
      } else {
        offset -= leftSum + node.weight;
        start += leftSum + node.weight;
        rank += size(node.left) + 1;
        node = node.right;
      }
    }
    return null;
  }

  /** Offset at which a present item's span starts, or -1. */
  offsetOf(item: T) {
    let node = this.root,
      before = 0;
    while (node) {
      const c = this.compare(item, node.item);
      if (c < 0) node = node.left;
      else if (c > 0) {
        before += sum(node.left) + node.weight;
        node = node.right;
      } else return before + sum(node.left);
    }
    return -1;
  }

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
