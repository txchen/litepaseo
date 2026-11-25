import { z } from "zod";
import { parseHostTarget } from "@getpaseo/client/node";
import { deleteHostMessageImages } from "./message-images.ts";
import { eventStream } from "./sse.ts";
import { isLocalConnection } from "./media.ts";
import { VERSION } from "./version.ts";
import type { Store } from "./store.ts";
import { customIcons, type App, type RouteContext } from "./route-context.ts";
import type { DirectoryMessage, HostState } from "../shared/wire.ts";

const AGENT_FLUSH_MS = 100;
const HOST_FLUSH_MS = 100;

export const instanceName = (store: Store) => store.setting("instance-name") ?? "";
const projectPins = (store: Store): Record<string, number> => JSON.parse(store.setting("project-pins") ?? "{}");

/**
 * Directory streams. Each remembers the last collection seq it delivered, so a flush sends
 * only entries changed since then: O(changes) per flush, independent of directory size.
 */
type DirectoryStream = {
  last: number;
  lastWorkspaces: number;
  lastEmptyProjects: number;
  lastQueueJson: string;
  send: (message: DirectoryMessage) => void;
};

/**
 * The live directory every page holds (hosts, agents, workspaces, project pins, the instance
 * name) and the routes that change its hosts, pins and name.
 */
export function registerDirectoryRoutes(app: App, { store, hosts, sendQueue, streamValidity, encodingOf }: RouteContext) {
  const streams = new Set<DirectoryStream>();
  let agentFlush: ReturnType<typeof setTimeout> | undefined;
  let hostFlush: ReturnType<typeof setTimeout> | undefined;
  let queueFlush: ReturnType<typeof setTimeout> | undefined;
  let queueVersion = 0;
  /** Set on shutdown: closing the hosts still reports changes, but the store is about to close. */
  let disposed = false;

  const hostStates = (): HostState[] =>
    store.hosts().map((h) => ({
      id: h.id,
      label: h.label,
      state: hosts.state(h.id),
      diagnostic: hosts.diagnostic(h.id),
      ...(customIcons(hosts, h.id) ? { customIcons: true } : {}),
      ...(isLocalConnection(h.connection) ? { local: true } : {}),
    }));
  const hostsMessage = (): DirectoryMessage => ({ type: "hosts", hosts: hostStates(), instanceName: instanceName(store), version: VERSION });
  const broadcast = (message: DirectoryMessage) => {
    for (const stream of streams) stream.send(message);
  };
  const deliverEmptyProjects = (stream: DirectoryStream) => {
    const { emptyProjects } = hosts;
    const changes = emptyProjects.changesSince(stream.lastEmptyProjects);
    if (changes === null)
      stream.send({ type: "empty-projects-snapshot", generation: emptyProjects.generation, seq: emptyProjects.seq, projects: emptyProjects.snapshot() });
    else if (changes.length)
      stream.send({ type: "empty-projects-changes", generation: emptyProjects.generation, seq: emptyProjects.seq, changes });
    stream.lastEmptyProjects = emptyProjects.seq;
  };
  const deliverWorkspaces = (stream: DirectoryStream) => {
    const { workspaces } = hosts;
    const changes = workspaces.changesSince(stream.lastWorkspaces);
    if (changes === null)
      stream.send({ type: "workspaces-snapshot", generation: workspaces.generation, seq: workspaces.seq, workspaces: workspaces.snapshot() });
    else if (changes.length)
      stream.send({ type: "workspaces-changes", generation: workspaces.generation, seq: workspaces.seq, changes });
    stream.lastWorkspaces = workspaces.seq;
  };
  const deliverAgents = (stream: DirectoryStream) => {
    deliverWorkspaces(stream);
    deliverEmptyProjects(stream);
    const { agents } = hosts;
    const changes = agents.changesSince(stream.last);
    if (changes === null)
      stream.send({ type: "snapshot", generation: agents.generation, seq: agents.seq, agents: agents.snapshot() });
    else if (changes.length)
      stream.send({ type: "changes", generation: agents.generation, seq: agents.seq, changes });
    stream.last = agents.seq;
  };
  const deliverQueue = (forceBroadcast = false) => {
    const summary = sendQueue.summary();
    const json = JSON.stringify(summary);
    let bumped = false;
    for (const stream of streams) {
      if (!forceBroadcast && stream.lastQueueJson === json) continue;
      if (!forceBroadcast && !bumped) {
        queueVersion++;
        bumped = true;
      }
      stream.lastQueueJson = json;
      stream.send({ type: "queue-summary", version: queueVersion, summary });
    }
  };
  const scheduleQueueFlush = () => {
    queueVersion++;
    if (disposed || !streams.size || queueFlush) return;
    queueFlush = setTimeout(() => {
      queueFlush = undefined;
      deliverQueue(true);
    }, AGENT_FLUSH_MS);
  };
  const stopQueue = sendQueue.onChange(scheduleQueueFlush);
  const stopAgents = hosts.onAgentsChanged(() => {
    if (disposed || !streams.size) return;
    if (!agentFlush) {
      agentFlush = setTimeout(() => {
        agentFlush = undefined;
        for (const stream of streams) deliverAgents(stream);
        deliverQueue(false);
      }, AGENT_FLUSH_MS);
    }
  });
  const stopHosts = hosts.onHostsChanged(() => {
    if (disposed || hostFlush || !streams.size) return;
    hostFlush = setTimeout(() => {
      hostFlush = undefined;
      broadcast(hostsMessage());
    }, HOST_FLUSH_MS);
  });

  app.get("/api/hosts", (c) => c.json(hostStates()));
  app.get("/api/stream", (c) => {
    const since = Number(c.req.query("since"));
    const resumable = c.req.query("generation") === hosts.agents.generation && Number.isInteger(since);
    const wsince = Number(c.req.query("wsince"));
    const wresumable = c.req.query("wgeneration") === hosts.workspaces.generation && Number.isInteger(wsince);
    const psince = Number(c.req.query("psince"));
    const presumable = c.req.query("pgeneration") === hosts.emptyProjects.generation && Number.isInteger(psince);
    return eventStream(c.req.raw.signal, (send) => {
      const initialQueue = sendQueue.summary();
      const initialQueueJson = JSON.stringify(initialQueue);
      const stream: DirectoryStream = {
        last: resumable ? since : -1,
        lastWorkspaces: wresumable ? wsince : -1,
        lastEmptyProjects: presumable ? psince : -1,
        lastQueueJson: initialQueueJson,
        send,
      };
      const wantsQueue = c.req.query("queues") === "1";
      send(hostsMessage());
      send({ type: "project-pins", pins: projectPins(store) });
      deliverAgents(stream);
      if (wantsQueue || Object.keys(initialQueue).length) {
        send({ type: "queue-summary", version: queueVersion, summary: initialQueue });
      }
      streams.add(stream);
      return () => streams.delete(stream);
    }, streamValidity(c), encodingOf(c));
  });

  app.get("/api/project-pins", (c) => c.json(projectPins(store)));
  app.post("/api/project-pins", async (c) => {
    const input = z.object({ hostId: z.string().min(1).max(200), projectIds: z.array(z.string().min(1).max(500)).min(1).max(100), pinned: z.boolean() }).parse(await c.req.json());
    hosts.get(input.hostId);
    const pins = projectPins(store);
    const rank = Math.max(0, ...Object.values(pins)) + 1;
    for (const id of input.projectIds) {
      const key = JSON.stringify([input.hostId, id]);
      if (input.pinned) pins[key] ??= rank; else delete pins[key];
    }
    if (Object.keys(pins).length > 2000) return c.json({ error: "Too many pinned projects" }, 400);
    store.setSetting("project-pins", JSON.stringify(pins));
    broadcast({ type: "project-pins", pins });
    return c.json(pins);
  });

  app.get("/api/instance", (c) => c.json({ name: instanceName(store) }));
  app.put("/api/instance", async (c) => {
    const input = z.object({ name: z.string().trim().max(64).refine((name) => !/[\u0000-\u001f\u007f]/.test(name), "Use a single-line name") }).strict().safeParse(await c.req.json());
    if (!input.success) return c.json({ error: "Use an instance name of up to 64 characters on a single line." }, 400);
    store.setSetting("instance-name", input.data.name || null);
    broadcast(hostsMessage());
    return c.json({ name: instanceName(store) });
  });

  app.post("/api/hosts", async (c) => {
    const input = z
      .object({ label: z.string().trim().min(1).max(80), connection: z.string().trim().min(1).max(16000) })
      .parse(await c.req.json());
    parseHostTarget(input.connection);
    const host = store.addHost(input.label, input.connection);
    try {
      hosts.add(host);
    } catch (e) {
      store.removeHost(host.id);
      throw e;
    }
    return c.json({ id: host.id, label: host.label }, 201);
  });
  app.delete("/api/hosts/:host", async (c) => {
    const id = c.req.param("host");
    await hosts.remove(id);
    // What belongs to the host goes with it: a host added again gets a new ID.
    const unpinned = store.transaction(() => {
      store.removeHost(id);
      deleteHostMessageImages(store, id);
      const pins = projectPins(store);
      const kept = Object.fromEntries(Object.entries(pins).filter(([key]) => JSON.parse(key)[0] !== id));
      const changed = Object.keys(kept).length !== Object.keys(pins).length;
      if (changed) store.setSetting("project-pins", JSON.stringify(kept));
      return changed;
    });
    sendQueue.removeHost(id);
    if (unpinned) broadcast({ type: "project-pins", pins: projectPins(store) });
    return c.json({ ok: true });
  });

  return {
    /** Open directory streams; lets tests prove that disconnects release them. */
    openStreams: () => streams.size,
    dispose: () => {
      disposed = true;
      clearTimeout(agentFlush);
      clearTimeout(hostFlush);
      clearTimeout(queueFlush);
      agentFlush = hostFlush = queueFlush = undefined;
      stopQueue();
      stopAgents();
      stopHosts();
    },
  };
}
