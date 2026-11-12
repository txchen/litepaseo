import { shallowRef } from "vue";
import { OrderedIndex } from "../shared/ordered-index.ts";
import { WeightedIndex } from "../shared/weighted-index.ts";
import { LANES, laneOf, type AgentState, type Change, type Lane } from "../shared/wire.ts";

/** Sidebar geometry: fixed pitches keep scroll offsets computable without measuring. */
export const GROUP_PITCH = 36;
// Touch screens get taller rows (finger targets); pointer devices get Paseo's compact rows.
export const AGENT_PITCH = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? 44 : 36;

/** What the directory views need from an item: agents and workspaces both fit. */
export interface DirectoryItem {
  key: string;
  hostId: string;
  project: string;
  activityAt: number;
  attention: boolean;
  state?: AgentState;
  status?: string;
  /** Workspaces only: pinned items lead their project. */
  pinnedAt?: number;
}

const byKey = (a: DirectoryItem, b: DirectoryItem) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
/** Most recently used first: by when the latest turn ended, so running turns do not reshuffle. */
export function compareAgents(a: DirectoryItem, b: DirectoryItem) {
  return b.activityAt - a.activityAt || byKey(a, b);
}
/** Pinned first (in the order they were pinned), then most recently used. */
export function comparePinnedFirst(a: DirectoryItem, b: DirectoryItem) {
  const pa = a.pinnedAt ?? 0,
    pb = b.pinnedAt ?? 0;
  if (pa || pb) {
    if (!pa) return 1;
    if (!pb) return -1;
    return pa - pb || byKey(a, b);
  }
  return compareAgents(a, b);
}

export interface ProjectGroup<T extends DirectoryItem = DirectoryItem> {
  key: string;
  name: string;
  items: OrderedIndex<T>;
  /** Recency order regardless of pinning, for the group's own position. */
  byRecency: OrderedIndex<T> | null;
  /** activityAt of the group's most recent member; the group's sort key. */
  recent: number;
  /** Members per state, so a collapsed project can show what it hides. */
  attention: number;
  failed: number;
  running: number;
  unread: number;
  /** Members per host: the project row names the machine(s) it lives on. O(1) per change. */
  hosts: Map<string, number>;
}

/** The most urgent state a project holds (Paseo's order for collapsed projects). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function groupState(group: ProjectGroup<any>): "needs_input" | "failed" | "running" | "unread" | "done" {
  if (group.attention) return "needs_input";
  if (group.failed) return "failed";
  if (group.running) return "running";
  if (group.unread) return "unread";
  return "done";
}

export type SidebarRow<T extends DirectoryItem = DirectoryItem> =
  | { kind: "group"; key: string; top: number; group: ProjectGroup<T>; collapsed: boolean }
  | { kind: "item"; key: string; top: number; item: T };

/**
 * One project row per host: the same project name on two machines is two projects (separate
 * checkouts, separate daemons), so they are never merged.
 */
export const groupKey = (item: DirectoryItem) => `${item.hostId}\n${item.project.toLowerCase()}`;
// One shared collator: localeCompare with options builds a collator per call.
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
/** Most recently used project first; name and key keep the order total and stable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const compareGroups = (a: ProjectGroup<any>, b: ProjectGroup<any>) =>
  b.recent - a.recent || collator.compare(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const stateOf = (item: DirectoryItem): AgentState =>
  item.state ?? (item.status === "running" ? "running" : "done");

/**
 * One presentation of a set of items: a flat order, project groups and task-board lanes.
 * Adding or removing an item costs O(log n + log groups); reading a window costs
 * O(window · log n).
 */
class View<T extends DirectoryItem> {
  readonly flat: OrderedIndex<T>;
  readonly groups = new Map<string, ProjectGroup<T>>();
  readonly index = new WeightedIndex<ProjectGroup<T>>(compareGroups);
  readonly lanes: Map<Lane, OrderedIndex<T>>;
  /** Items in this view that need the user. */
  waiting = 0;
  private readonly compare: (a: T, b: T) => number;
  private readonly isCollapsed: (key: string) => boolean;

  constructor(compare: (a: T, b: T) => number, isCollapsed: (key: string) => boolean) {
    this.compare = compare;
    this.isCollapsed = isCollapsed;
    this.flat = new OrderedIndex<T>(compare);
    this.lanes = new Map(LANES.map((l) => [l, new OrderedIndex<T>(compareAgents)]));
  }

  get size() {
    return this.flat.size;
  }

  weight(group: ProjectGroup<T>) {
    return GROUP_PITCH + (this.isCollapsed(group.key) ? 0 : group.items.size * AGENT_PITCH);
  }

  add(item: T) {
    this.flat.insert(item);
    this.lanes.get(laneOf(stateOf(item)))!.insert(item);
    const key = groupKey(item);
    let group = this.groups.get(key);
    if (group) this.index.remove(group); // its sort key may change below
    else {
      group = {
        key,
        name: item.project,
        items: new OrderedIndex<T>(this.compare),
        byRecency: this.compare === compareAgents ? null : new OrderedIndex<T>(compareAgents),
        recent: 0,
        attention: 0,
        failed: 0,
        running: 0,
        unread: 0,
        hosts: new Map(),
      };
      this.groups.set(key, group);
    }
    group.items.insert(item);
    group.byRecency?.insert(item);
    this.count(group, item, 1);
    this.reinsert(group);
  }

  remove(item: T) {
    if (!this.flat.remove(item)) return;
    this.lanes.get(laneOf(stateOf(item)))!.remove(item);
    const group = this.groups.get(groupKey(item));
    if (!group) return;
    this.index.remove(group);
    group.items.remove(item);
    group.byRecency?.remove(item);
    this.count(group, item, -1);
    if (group.items.size) this.reinsert(group);
    else this.groups.delete(group.key);
  }

  refresh(key: string) {
    const group = this.groups.get(key);
    if (group) this.index.reweigh(group, this.weight(group));
  }

  clear() {
    this.flat.clear();
    this.groups.clear();
    this.index.clear();
    for (const lane of this.lanes.values()) lane.clear();
    this.waiting = 0;
  }

  rows(top: number, height: number): SidebarRow<T>[] {
    const out: SidebarRow<T>[] = [];
    const end = top + height;
    const located = this.index.locate(Math.max(0, top));
    if (!located) return out;
    let rank = located.rank,
      start = located.start;
    while (start < end) {
      const group = this.index.at(rank++);
      if (!group) break;
      const collapsed = this.isCollapsed(group.key);
      if (start + GROUP_PITCH > top)
        out.push({ kind: "group", key: "g:" + group.key, top: start, group, collapsed });
      if (!collapsed) {
        const body = start + GROUP_PITCH;
        const first = Math.max(0, Math.floor((top - body) / AGENT_PITCH));
        const last = Math.min(group.items.size, Math.ceil((end - body) / AGENT_PITCH));
        if (last > first)
          group.items.range(first, last - first).forEach((item, i) =>
            out.push({ kind: "item", key: item.key, top: body + (first + i) * AGENT_PITCH, item }),
          );
      }
      start += this.weight(group);
    }
    return out;
  }

  private reinsert(group: ProjectGroup<T>) {
    group.recent = (group.byRecency ?? group.items).at(0)!.activityAt;
    this.index.insert(group, this.weight(group));
  }

  private count(group: ProjectGroup<T>, item: T, delta: number) {
    const onHost = (group.hosts.get(item.hostId) ?? 0) + delta;
    if (onHost > 0) group.hosts.set(item.hostId, onHost);
    else group.hosts.delete(item.hostId);
    if (item.attention) {
      group.attention += delta;
      this.waiting += delta;
    }
    const state = stateOf(item);
    if (state === "failed") group.failed += delta;
    else if (state === "running") group.running += delta;
    else if (state === "unread") group.unread += delta;
  }
}

export type CollectionMessage<T> =
  | { type: "snapshot"; generation: string; seq: number; items: T[] }
  | { type: "changes"; generation: string; seq: number; changes: Change<T>[] };

/**
 * Browser replica of one BFF collection (agents or workspaces). Every change is applied
 * incrementally to the full view, to its host's view and, while searching, to the matching
 * view, so switching hosts is O(1) and nothing rescans the directory per update.
 */
export class DirectoryStore<T extends DirectoryItem = DirectoryItem> {
  generation = "";
  seq = -1;
  private readonly byKey = new Map<string, T>();
  private readonly collapsed: Set<string>;
  private readonly compare: (a: T, b: T) => number;
  private readonly all: View<T>;
  private readonly byHost = new Map<string, View<T>>();
  private host: string | null = null;
  private filtered: View<T> | null = null;
  private predicate: ((item: T) => boolean) | null = null;
  private readonly persist: (collapsed: string[]) => void;
  /** Secondary index (e.g. agents by workspace), each bucket in recency order. */
  private readonly indexOf: ((item: T) => string | null) | null;
  private readonly buckets = new Map<string, OrderedIndex<T>>();
  /** Bumped once per applied message or view change; the only reactive dependency views take. */
  readonly version = shallowRef(0);

  constructor(
    options: {
      collapsed?: Iterable<string>;
      persist?: (collapsed: string[]) => void;
      compare?: (a: T, b: T) => number;
      indexBy?: (item: T) => string | null;
    } = {},
  ) {
    this.collapsed = new Set(options.collapsed);
    this.persist = options.persist ?? (() => {});
    this.compare = options.compare ?? compareAgents;
    this.indexOf = options.indexBy ?? null;
    this.all = new View<T>(this.compare, this.collapsedFn);
  }

  private readonly collapsedFn = (key: string) => this.collapsed.has(key);

  /** The host-scoped view the search runs over. */
  private get base() {
    return this.host === null ? this.all : this.hostView(this.host);
  }

  private get view() {
    return this.filtered ?? this.base;
  }

  private hostView(hostId: string) {
    let view = this.byHost.get(hostId);
    if (!view) this.byHost.set(hostId, (view = new View<T>(this.compare, this.collapsedFn)));
    return view;
  }

  /** Items in the current view (host and search applied). */
  get size() {
    return this.view.size;
  }

  get total() {
    return this.byKey.size;
  }

  /** Items waiting for the user across all hosts (app badge). */
  get waiting() {
    return this.all.waiting;
  }

  get projectCount() {
    return this.view.groups.size;
  }

  get hostFilter() {
    return this.host;
  }

  /** Items on one host, regardless of search. */
  hostSize(hostId: string) {
    return this.byHost.get(hostId)?.size ?? 0;
  }

  get(key: string | null | undefined) {
    return key ? this.byKey.get(key) : undefined;
  }

  /** Members of one secondary-index bucket, most recent first (O(log n + count)). */
  indexed(bucket: string | null | undefined, count = 1): T[] {
    return bucket ? (this.buckets.get(bucket)?.range(0, count) ?? []) : [];
  }

  indexedSize(bucket: string | null | undefined) {
    return bucket ? (this.buckets.get(bucket)?.size ?? 0) : 0;
  }

  /** Flat order. */
  range(start: number, count: number) {
    return this.view.flat.range(start, count);
  }

  /** Lane size across all hosts and regardless of search (tab icon state). */
  allLaneSize(lane: Lane) {
    return this.all.lanes.get(lane)!.size;
  }

  laneSize(lane: Lane) {
    return this.view.lanes.get(lane)!.size;
  }

  laneRange(lane: Lane, start: number, count: number) {
    return this.view.lanes.get(lane)!.range(start, count);
  }

  /** Height of the grouped list in pixels. */
  get groupedHeight() {
    return this.view.index.total;
  }

  groupedRows(top: number, height: number) {
    return this.view.rows(top, height);
  }

  isCollapsed(key: string) {
    return !this.filtered && this.collapsed.has(key);
  }

  toggleGroup(key: string) {
    if (this.filtered) return;
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    this.all.refresh(key);
    for (const view of this.byHost.values()) view.refresh(key);
    this.persist([...this.collapsed]);
    this.version.value++;
  }

  /** Scopes the list to one host (null for all). O(1) unless a search is active. */
  setHost(hostId: string | null) {
    if (hostId === this.host) return;
    this.host = hostId;
    if (this.predicate) this.rebuildFiltered();
    this.version.value++;
  }

  /** Builds the search view once (O(n log n)); later changes update it in O(log n). */
  setFilter(predicate: ((item: T) => boolean) | null) {
    this.predicate = predicate;
    if (!predicate) this.filtered = null;
    else this.rebuildFiltered();
    this.version.value++;
  }

  applyCollection(message: CollectionMessage<T>): void {
    if (message.type === "snapshot") {
      this.byKey.clear();
      this.all.clear();
      for (const view of this.byHost.values()) view.clear();
      this.filtered?.clear();
      this.buckets.clear();
      for (const item of message.items) this.put(item);
    } else {
      if (message.generation !== this.generation) return;
      for (const change of message.changes) {
        const previous = this.byKey.get(change.key);
        if (previous) {
          this.all.remove(previous);
          this.byHost.get(previous.hostId)?.remove(previous);
          this.filtered?.remove(previous);
          this.unbucket(previous);
        }
        if (change.value) this.put(change.value);
        else this.byKey.delete(change.key);
      }
    }
    this.generation = message.generation;
    this.seq = message.seq;
    this.version.value++;
  }

  /** The agent directory's wire messages (kept for the agent store and its tests). */
  apply(message: { type: string; generation?: string; seq?: number; agents?: T[]; changes?: Change<T>[] }) {
    if (message.type === "snapshot")
      this.applyCollection({ type: "snapshot", generation: message.generation!, seq: message.seq!, items: message.agents! });
    else if (message.type === "changes")
      this.applyCollection({ type: "changes", generation: message.generation!, seq: message.seq!, changes: message.changes! });
  }

  private matches(item: T) {
    return (this.host === null || item.hostId === this.host) && this.predicate!(item);
  }

  private rebuildFiltered() {
    // Search results are always expanded so matches are never hidden in a collapsed group.
    const filtered = new View<T>(this.compare, () => false);
    const base = this.base;
    for (const item of base.flat.range(0, base.size)) if (this.predicate!(item)) filtered.add(item);
    this.filtered = filtered;
  }

  private bucketOf(item: T) {
    return this.indexOf ? this.indexOf(item) : null;
  }

  private unbucket(item: T) {
    const bucket = this.bucketOf(item);
    if (!bucket) return;
    const index = this.buckets.get(bucket);
    if (!index) return;
    index.remove(item);
    if (!index.size) this.buckets.delete(bucket);
  }

  private put(item: T) {
    this.byKey.set(item.key, item);
    this.all.add(item);
    this.hostView(item.hostId).add(item);
    if (this.filtered && this.matches(item)) this.filtered.add(item);
    const bucket = this.bucketOf(item);
    if (bucket) {
      let index = this.buckets.get(bucket);
      if (!index) this.buckets.set(bucket, (index = new OrderedIndex<T>(compareAgents)));
      index.insert(item);
    }
  }
}
