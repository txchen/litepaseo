import { shallowRef } from "vue";
import { OrderedIndex } from "../shared/ordered-index.ts";
import { WeightedIndex } from "../shared/weighted-index.ts";
import type { AgentSummary, DirectoryMessage } from "../shared/wire.ts";

/** Sidebar geometry: fixed pitches keep scroll offsets computable without measuring. */
export const GROUP_PITCH = 36;
export const AGENT_PITCH = 52;

/** Most recently used first: by when the latest turn ended, so running turns do not reshuffle. */
export function compareAgents(a: AgentSummary, b: AgentSummary) {
  return b.activityAt - a.activityAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export interface ProjectGroup {
  key: string;
  name: string;
  agents: OrderedIndex<AgentSummary>;
  /** activityAt of the group's most recent session; the group's sort key. */
  recent: number;
  attention: number;
  running: number;
}

export type SidebarRow =
  | { kind: "group"; key: string; top: number; group: ProjectGroup; collapsed: boolean }
  | { kind: "agent"; key: string; top: number; agent: AgentSummary };

export const groupKey = (agent: AgentSummary) => agent.project.toLowerCase();
// One shared collator: localeCompare with options builds a collator per call.
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
/** Most recently used project first; name and key keep the order total and stable. */
export const compareGroups = (a: ProjectGroup, b: ProjectGroup) =>
  b.recent - a.recent || collator.compare(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * One presentation of a set of agents: a flat recency order and project groups. Adding or
 * removing an agent costs O(log n + log groups); reading a window costs O(window · log n).
 */
class View {
  readonly flat = new OrderedIndex<AgentSummary>(compareAgents);
  readonly groups = new Map<string, ProjectGroup>();
  readonly index = new WeightedIndex<ProjectGroup>(compareGroups);
  private readonly isCollapsed: (key: string) => boolean;

  constructor(isCollapsed: (key: string) => boolean) {
    this.isCollapsed = isCollapsed;
  }

  get size() {
    return this.flat.size;
  }

  /** Sessions in this view that need the user. */
  waiting = 0;

  weight(group: ProjectGroup) {
    return GROUP_PITCH + (this.isCollapsed(group.key) ? 0 : group.agents.size * AGENT_PITCH);
  }

  add(agent: AgentSummary) {
    this.flat.insert(agent);
    const key = groupKey(agent);
    let group = this.groups.get(key);
    if (group) this.index.remove(group); // its sort key may change below
    else {
      group = { key, name: agent.project, agents: new OrderedIndex(compareAgents), recent: 0, attention: 0, running: 0 };
      this.groups.set(key, group);
    }
    group.agents.insert(agent);
    this.count(group, agent, 1);
    this.reinsert(group);
  }

  remove(agent: AgentSummary) {
    if (!this.flat.remove(agent)) return;
    const group = this.groups.get(groupKey(agent));
    if (!group) return;
    this.index.remove(group);
    group.agents.remove(agent);
    this.count(group, agent, -1);
    if (group.agents.size) this.reinsert(group);
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
    this.waiting = 0;
  }

  rows(top: number, height: number): SidebarRow[] {
    const out: SidebarRow[] = [];
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
        const last = Math.min(group.agents.size, Math.ceil((end - body) / AGENT_PITCH));
        if (last > first)
          group.agents.range(first, last - first).forEach((agent, i) =>
            out.push({ kind: "agent", key: agent.key, top: body + (first + i) * AGENT_PITCH, agent }),
          );
      }
      start += this.weight(group);
    }
    return out;
  }

  private reinsert(group: ProjectGroup) {
    group.recent = group.agents.at(0)!.activityAt;
    this.index.insert(group, this.weight(group));
  }

  private count(group: ProjectGroup, agent: AgentSummary, delta: number) {
    if (agent.attention) {
      group.attention += delta;
      this.waiting += delta;
    }
    if (agent.status === "running") group.running += delta;
  }
}

/**
 * Browser replica of the BFF directory. Every change is applied incrementally to the full
 * view, to its host's view and, while searching, to the matching view, so switching hosts is
 * O(1) and nothing rescans the directory per update.
 */
export class DirectoryStore {
  generation = "";
  seq = -1;
  private readonly byKey = new Map<string, AgentSummary>();
  private readonly collapsed: Set<string>;
  private readonly all: View;
  private readonly byHost = new Map<string, View>();
  private host: string | null = null;
  private filtered: View | null = null;
  private predicate: ((agent: AgentSummary) => boolean) | null = null;
  private readonly persist: (collapsed: string[]) => void;
  /** Bumped once per applied message or view change; the only reactive dependency views take. */
  readonly version = shallowRef(0);

  constructor(options: { collapsed?: Iterable<string>; persist?: (collapsed: string[]) => void } = {}) {
    this.collapsed = new Set(options.collapsed);
    this.persist = options.persist ?? (() => {});
    this.all = new View(this.collapsedFn);
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
    if (!view) this.byHost.set(hostId, (view = new View(this.collapsedFn)));
    return view;
  }

  /** Agents in the current view (host and search applied). */
  get size() {
    return this.view.size;
  }

  get total() {
    return this.byKey.size;
  }

  /** Sessions waiting for the user across all hosts (app badge). */
  get waiting() {
    return this.all.waiting;
  }

  get projectCount() {
    return this.view.groups.size;
  }

  get hostFilter() {
    return this.host;
  }

  /** Sessions on one host, regardless of search. */
  hostSize(hostId: string) {
    return this.byHost.get(hostId)?.size ?? 0;
  }

  get(key: string | null | undefined) {
    return key ? this.byKey.get(key) : undefined;
  }

  /** Flat recency order. */
  range(start: number, count: number) {
    return this.view.flat.range(start, count);
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
  setFilter(predicate: ((agent: AgentSummary) => boolean) | null) {
    this.predicate = predicate;
    if (!predicate) this.filtered = null;
    else this.rebuildFiltered();
    this.version.value++;
  }

  apply(message: DirectoryMessage): void {
    if (message.type === "snapshot") {
      this.byKey.clear();
      this.all.clear();
      for (const view of this.byHost.values()) view.clear();
      this.filtered?.clear();
      for (const agent of message.agents) this.put(agent);
    } else if (message.type === "changes") {
      if (message.generation !== this.generation) return;
      for (const change of message.changes) {
        const previous = this.byKey.get(change.key);
        if (previous) {
          this.all.remove(previous);
          this.byHost.get(previous.hostId)?.remove(previous);
          this.filtered?.remove(previous);
        }
        if (change.value) this.put(change.value);
        else this.byKey.delete(change.key);
      }
    } else return;
    this.generation = message.generation;
    this.seq = message.seq;
    this.version.value++;
  }

  private matches(agent: AgentSummary) {
    return (this.host === null || agent.hostId === this.host) && this.predicate!(agent);
  }

  private rebuildFiltered() {
    // Search results are always expanded so matches are never hidden in a collapsed group.
    const filtered = new View(() => false);
    const base = this.base;
    for (const agent of base.flat.range(0, base.size)) if (this.predicate!(agent)) filtered.add(agent);
    this.filtered = filtered;
  }

  private put(agent: AgentSummary) {
    this.byKey.set(agent.key, agent);
    this.all.add(agent);
    this.hostView(agent.hostId).add(agent);
    if (this.filtered && this.matches(agent)) this.filtered.add(agent);
  }
}
