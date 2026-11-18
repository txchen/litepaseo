import type { ProviderSubagent, TimelineCursor, TimelineItem } from "../shared/wire.ts";
import type { TimelineDriver } from "./timeline-view.ts";

const UPDATE = "agent.provider_subagents.update";

type Descriptor = Omit<ProviderSubagent, "parentSubagentId" | "subtitle"> & {
  parentAgentId: string;
  parentSubagentId?: string | null;
  subtitle?: string | null;
};
type UpdatePayload =
  | { kind: "upsert"; subagent: Descriptor }
  | {
      kind: "timeline";
      parentAgentId: string;
      subagentId: string;
      provider: string;
      item: TimelineItem;
      timestamp: string;
      seq: number;
      epoch: string;
    }
  | { kind: "remove"; parentAgentId: string; subagentId: string };

interface SubagentTimelinePayload {
  provider: string | null;
  epoch: string;
  reset: boolean;
  window: { minSeq: number; maxSeq: number; nextSeq: number };
  startCursor?: TimelineCursor | null;
  endCursor?: TimelineCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
  rows: { item: TimelineItem; timestamp: string; seq: number; seqStart?: number; seqEnd?: number }[];
}

/** The DaemonClient surface provider subagents need; narrow so tests can supply a double. */
export interface SubagentDriver {
  observeEvents(events: string[]): {
    ready: Promise<unknown>;
    subscribe(observer: { snapshot(payload: unknown): void; update(message: unknown): void; error?(error: unknown): void }): () => void;
    release(): Promise<void>;
  };
  on(type: string, handler: (message: { payload: unknown }) => void): () => void;
  listProviderSubagents(parentAgentId: string, options?: { timeout?: number }): Promise<{ subagents: Descriptor[] }>;
  fetchProviderSubagentTimeline(
    parentAgentId: string,
    subagentId: string,
    options: { direction?: "tail" | "before" | "after"; cursor?: TimelineCursor; limit?: number; timeout?: number },
  ): Promise<SubagentTimelinePayload>;
}

type ListListener = (subagents: ProviderSubagent[]) => void;
type TimelineHandler = (message: { type: string; payload?: unknown }) => void;

interface Parent {
  subagents: Map<string, Descriptor>;
  listeners: Set<ListListener>;
  /** Changes seen while the list request is in flight; applied over its answer. */
  during: Map<string, Descriptor | null> | null;
  token: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Released this long after the last watcher leaves, so switching conversations keeps it. */
const GRACE_MS = 30_000;
/** Status changes are batched like timeline renders. */
const FLUSH_MS = 500;
const LIST_TIMEOUT_MS = 15_000;

const publish = (d: Descriptor): ProviderSubagent => ({
  id: d.id,
  parentSubagentId: d.parentSubagentId ?? null,
  provider: d.provider,
  title: d.title,
  description: d.description,
  subtitle: d.subtitle ?? null,
  status: d.status,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  toolCallId: d.toolCallId,
});

/**
 * The subagents providers run inside agents of one host (Claude Task, Codex, pi-subagents…),
 * as Paseo's daemon tracks them. One event subscription per host serves every watched parent
 * and every open subagent conversation; it is held only while someone watches.
 */
export class HostSubagents {
  private readonly parents = new Map<string, Parent>();
  private readonly timelines = new Map<string, Set<TimelineHandler>>();
  private events: ReturnType<SubagentDriver["observeEvents"]> | null = null;
  private stopEvents: (() => void) | null = null;
  private snapshots = 0;
  private users = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly driver: SubagentDriver;

  constructor(driver: SubagentDriver) {
    this.driver = driver;
  }

  /** Calls `listener` with the parent's subagents once known and on every change. */
  watch(parentAgentId: string, listener: ListListener) {
    this.acquire();
    let parent = this.parents.get(parentAgentId);
    if (!parent) {
      parent = { subagents: new Map(), listeners: new Set(), during: null, token: 0 };
      this.parents.set(parentAgentId, parent);
      parent.listeners.add(listener);
      void this.load(parentAgentId, parent);
    } else {
      parent.listeners.add(listener);
      if (!parent.during) listener(this.list(parent));
    }
    const current = parent;
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      current.listeners.delete(listener);
      if (!current.listeners.size && this.parents.get(parentAgentId) === current) {
        clearTimeout(current.timer);
        current.token++;
        this.parents.delete(parentAgentId);
      }
      this.releaseUse();
    };
  }

  /** A TimelineView driver for one subagent conversation. */
  timelineDriver(parentAgentId: string, subagentId: string): TimelineDriver {
    const key = `${parentAgentId}\0${subagentId}`;
    return {
      subscribeAgentTimeline: (_agentId, handler) => {
        this.acquire();
        let handlers = this.timelines.get(key);
        if (!handlers) this.timelines.set(key, (handlers = new Set()));
        handlers.add(handler);
        let released = false;
        const release = async () => {
          if (released) return;
          released = true;
          handlers.delete(handler);
          if (!handlers.size && this.timelines.get(key) === handlers) this.timelines.delete(key);
          this.releaseUse();
        };
        const ready = this.events!.ready.then(() => undefined);
        return Object.assign(() => void release(), { ready, release });
      },
      fetchAgentTimeline: async (_agentId, options) => {
        const page = await this.driver.fetchProviderSubagentTimeline(parentAgentId, subagentId, {
          direction: options.direction as "tail" | "before" | "after",
          ...(options.cursor ? { cursor: options.cursor as TimelineCursor } : {}),
          ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
          timeout: LIST_TIMEOUT_MS,
        });
        return {
          epoch: page.epoch,
          reset: page.reset,
          window: page.window,
          startCursor: page.startCursor ?? null,
          endCursor: page.endCursor ?? null,
          hasOlder: page.hasOlder,
          hasNewer: page.hasNewer,
          entries: page.rows.map((row) => ({
            provider: page.provider ?? "",
            item: row.item,
            timestamp: row.timestamp,
            seqStart: row.seqStart ?? row.seq,
            seqEnd: row.seqEnd ?? row.seq,
          })),
        };
      },
    };
  }

  async dispose() {
    clearTimeout(this.idle);
    for (const parent of this.parents.values()) clearTimeout(parent.timer);
    this.parents.clear();
    this.timelines.clear();
    await this.close();
  }

  // ---- internals ----------------------------------------------------------------------------

  private acquire() {
    if (!this.events) this.subscribe();
    this.users++;
    clearTimeout(this.idle);
    this.idle = undefined;
  }

  private subscribe() {
    this.snapshots = 0;
    this.stopEvents = this.driver.on(UPDATE, (message) => this.receive(message.payload as UpdatePayload));
    const events = (this.events = this.driver.observeEvents([UPDATE]));
    events.subscribe({
      // A fresh subscription after a reconnect: updates may have been missed meanwhile.
      snapshot: () => {
        if (this.events === events && this.snapshots++ > 0) this.restored();
      },
      update() {},
      error() {},
    });
  }

  private releaseUse() {
    if (--this.users > 0) return;
    this.users = 0;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (!this.users) void this.close();
    }, GRACE_MS);
    this.idle.unref?.();
  }

  private async close() {
    this.stopEvents?.();
    this.stopEvents = null;
    const events = this.events;
    this.events = null;
    await events?.release().catch(() => {});
  }

  private restored() {
    for (const [id, parent] of this.parents) void this.load(id, parent);
    for (const handlers of this.timelines.values())
      for (const handler of handlers) handler({ type: "agent.timeline.subscription_restored" });
  }

  private async load(parentAgentId: string, parent: Parent) {
    const token = ++parent.token;
    parent.during = new Map();
    let listed: Descriptor[] = [];
    try {
      listed = (await this.driver.listProviderSubagents(parentAgentId, { timeout: LIST_TIMEOUT_MS })).subagents;
    } catch {
      // Older daemons have no provider subagents; the agent simply shows none.
      if (token !== parent.token) return;
      listed = [...parent.subagents.values()];
    }
    if (token !== parent.token || this.parents.get(parentAgentId) !== parent) return;
    const next = new Map(listed.map((d) => [d.id, d]));
    for (const [id, change] of parent.during) {
      if (change === null) next.delete(id);
      else if ((next.get(id)?.updatedAt ?? "") <= change.updatedAt) next.set(id, change);
    }
    parent.subagents = next;
    parent.during = null;
    this.flush(parent);
  }

  private receive(payload: UpdatePayload) {
    if (payload.kind === "timeline") {
      const handlers = this.timelines.get(`${payload.parentAgentId}\0${payload.subagentId}`);
      if (!handlers) return;
      const message = {
        type: "agent_stream",
        payload: {
          agentId: payload.subagentId,
          event: { type: "timeline", provider: payload.provider, item: payload.item },
          timestamp: payload.timestamp,
          seq: payload.seq,
          epoch: payload.epoch,
        },
      };
      for (const handler of handlers) handler(message);
      return;
    }
    const parentId = payload.kind === "upsert" ? payload.subagent.parentAgentId : payload.parentAgentId;
    const parent = this.parents.get(parentId);
    if (!parent) return;
    if (payload.kind === "upsert") {
      parent.subagents.set(payload.subagent.id, payload.subagent);
      parent.during?.set(payload.subagent.id, payload.subagent);
    } else {
      parent.subagents.delete(payload.subagentId);
      parent.during?.set(payload.subagentId, null);
    }
    if (parent.during || parent.timer) return;
    parent.timer = setTimeout(() => this.flush(parent), FLUSH_MS);
    parent.timer.unref?.();
  }

  private flush(parent: Parent) {
    clearTimeout(parent.timer);
    parent.timer = undefined;
    const list = this.list(parent);
    for (const listener of parent.listeners) listener(list);
  }

  private list(parent: Parent) {
    return [...parent.subagents.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(publish);
  }
}
