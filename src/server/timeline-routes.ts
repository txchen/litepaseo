import { z } from "zod";
import { TimelineTimeoutError } from "./hosts.ts";
import { rewindModes } from "./host-directory.ts";
import { logEvent } from "./log-event.ts";
import { messageImage, withMessageImages } from "./message-images.ts";
import { MAX_IMAGE_BYTES, imageMime, imageReadTarget, isLocalConnection, isMaterializedImagePath, readMaterializedImage } from "./media.ts";
import { eventStream } from "./sse.ts";
import { errorMessage, hostPath, type App, type RouteContext } from "./route-context.ts";
import type {
  AgentBackgroundWorkItem,
  BackgroundWorkMessage,
  PromptIndex,
  SubagentsMessage,
  TimelineItem,
  TimelineMessage,
  TimelinePage,
  TimelineRow,
  TimelineSnapshot,
} from "../shared/wire.ts";

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return null;
  }
}
const pageCursor = z.object({ epoch: z.string().min(1), seq: z.number().int().nonnegative() });

/**
 * A conversation: its snapshot, live stream and history pages, provider subagents, the images
 * it shows, search, the prompt outline and rewind.
 */
export function registerTimelineRoutes(app: App, { store, hosts, streamValidity, encodingOf }: RouteContext) {
  /** Rows as browsers get them: images the agent sent are served from here. */
  const enrichRow = (hostId: string, agentId: string) => (row: TimelineRow) =>
    ({ ...row, item: withMessageImages(store, hostId, agentId, row.item) });
  /**
   * The conversation as it is now, to open it: a plain response with an end, which no proxy
   * holds back the way some held back a long-lived stream's first rows. The stream then resumes
   * from the snapshot's seq and carries only what changed.
   */
  app.get("/api/hosts/:host/agents/:agent/timeline/latest", async (c) => {
    const hostId = c.req.param("host"), agentId = c.req.param("agent");
    try {
      const reset = await hosts.timelineSnapshot(hostId, agentId);
      return c.json({ ...reset, rows: reset.rows.map(enrichRow(hostId, agentId)) } satisfies TimelineSnapshot);
    } catch (error) {
      if (error instanceof TimelineTimeoutError) return c.json({ error: error.message }, 504);
      throw error;
    }
  });
  app.get("/api/hosts/:host/agents/:agent/timeline/stream", (c) => {
    const hostId = c.req.param("host"), agentId = c.req.param("agent");
    hosts.get(hostId);
    // A browser that holds the conversation says how far: it gets only what changed since.
    const since = z.object({
      epoch: z.string().min(1).max(200),
      seq: z.coerce.number().int().nonnegative(),
      from: z.coerce.number().int().nonnegative(),
    }).safeParse(c.req.query());
    const enrich = enrichRow(hostId, agentId);
    return eventStream(c.req.raw.signal, (send) => {
      const stop = hosts.watchTimeline(hostId, agentId, (ops) =>
        send({ type: "ops", ops: ops.map((op) =>
          op.type === "reset" ? { ...op, rows: op.rows.map(enrich) } : op.type === "upsert" ? { ...op, row: enrich(op.row) } : op,
        ) } satisfies TimelineMessage), undefined, since.success ? since.data : undefined);
      // The agent's provider subagents ride the same stream: no extra connection per chat.
      // The first list always goes out, so a reconnecting browser drops subagents that are gone.
      let sent = "";
      let stopSubagents = () => {};
      try {
        stopSubagents = hosts.watchSubagents(hostId, agentId, (subagents) => {
          const text = JSON.stringify(subagents);
          if (text === sent) return;
          sent = text;
          send({ type: "subagents", subagents } satisfies SubagentsMessage);
        });
      } catch {
        // A host without provider subagent support: the conversation still streams.
      }
      let sentBg = "";
      let stopBg = () => {};
      try {
        stopBg = hosts.watchBackgroundWork(hostId, agentId, (items) => {
          const text = JSON.stringify(items);
          if (text === sentBg) return;
          sentBg = text;
          send({ type: "background-work", items } satisfies BackgroundWorkMessage);
        });
      } catch {
        // Older host without background work support.
      }
      return () => {
        stop();
        stopSubagents();
        stopBg();
      };
    }, streamValidity(c), encodingOf(c));
  });
  /** Bounded history pages; the browser bookmarks boundaries for forward navigation. */
  app.get("/api/hosts/:host/agents/:agent/timeline", async (c) => {
    const hostId = c.req.param("host"), agentId = c.req.param("agent");
    const cursor = pageCursor.parse(parseJson(c.req.query("cursor")));
    const page = await hosts.get(hostId).driver.fetchAgentTimeline(agentId, {
      direction: "before",
      cursor,
      limit: 100,
      projection: "projected",
      wholeTurns: false,
    });
    return c.json({
      epoch: page.epoch,
      hasOlder: page.hasOlder,
      startCursor: page.startCursor,
      rows: page.entries.map((e) => ({
        seqStart: e.seqStart,
        seqEnd: e.seqEnd,
        timestamp: e.timestamp,
        provider: e.provider,
        ...(e.turnId ? { turnId: e.turnId } : {}),
        ...(e.turnMetrics?.length ? { turnMetrics: e.turnMetrics } : {}),
        item: withMessageImages(store, hostId, agentId, e.item as TimelineItem),
      })),
    } satisfies TimelinePage);
  });

  // ---- Background work & heartbeats ------------------------------------------------------------
  app.post("/api/hosts/:host/agents/:agent/background-work/stop", async (c) => {
    const hostId = c.req.param("host"), agentId = c.req.param("agent");
    const item = z
      .object({
        id: z.string().min(1).max(300),
        kind: z.string().min(1).max(100),
        description: z.string().nullable().default(null),
        command: z.string().optional(),
        startedAt: z.string().min(1).max(100),
        canStop: z.boolean().optional(),
        stopToken: z.string().optional(),
      })
      .parse(await c.req.json()) satisfies AgentBackgroundWorkItem;
    try {
      await hosts.stopBackgroundWork(hostId, agentId, item);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not stop background work.") }, 502);
    }
  });

  // ---- Provider subagents: read-only conversations, live like an agent's -----------------------
  app.get("/api/hosts/:host/agents/:agent/subagents/:subagent/timeline/stream", (c) => {
    hosts.get(c.req.param("host"));
    return eventStream(c.req.raw.signal, (send) =>
      hosts.watchTimeline(c.req.param("host"), c.req.param("agent"), (ops) => send({ type: "ops", ops } satisfies TimelineMessage), c.req.param("subagent")),
    streamValidity(c), encodingOf(c));
  });
  app.get("/api/hosts/:host/agents/:agent/subagents/:subagent/timeline", async (c) => {
    const cursor = pageCursor.parse(parseJson(c.req.query("cursor")));
    const page = await hosts
      .get(c.req.param("host"))
      .subagents.timelineDriver(c.req.param("agent"), c.req.param("subagent"))
      .fetchAgentTimeline(c.req.param("agent"), { direction: "before", cursor, limit: 100 });
    return c.json({
      epoch: page.epoch,
      hasOlder: page.hasOlder,
      startCursor: page.startCursor,
      rows: page.entries.map((e) => ({ seqStart: e.seqStart, seqEnd: e.seqEnd, timestamp: e.timestamp, provider: e.provider, item: e.item })),
    } satisfies TimelinePage);
  });

  // ---- Images in the conversation ---------------------------------------------------------------
  app.get("/api/hosts/:host/agents/:agent/message-images/:message/:index", (c) => {
    const index = c.req.param("index");
    if (!/^[0-3]$/.test(index)) return c.notFound();
    const image = messageImage(store, c.req.param("host"), c.req.param("agent"), c.req.param("message"), Number(index));
    if (!image) return c.notFound();
    return c.body(new Uint8Array(Buffer.from(image.data, "base64")), 200, {
      "Content-Type": image.mimeType, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
    });
  });
  /**
   * An image an agent referenced in a message (`![](file:///…)`, an absolute or workspace path).
   * Workspace files go through the daemon's file API; images the daemon materialized from
   * provider output live outside the workspace and are read from disk when the daemon is local.
   */
  app.get("/api/hosts/:host/agents/:agent/image", async (c) => {
    const hostId = c.req.param("host");
    const path = hostPath.parse(c.req.query("path"));
    const mime = imageMime(path);
    if (!mime) return c.json({ error: "Not an image" }, 415);
    const { driver } = hosts.get(hostId);
    const cwd = hosts.agents.get(`${hostId}:${c.req.param("agent")}`)?.cwd;
    let bytes: Uint8Array | null = null;
    if (isMaterializedImagePath(path)) {
      const host = store.hosts().find((h) => h.id === hostId);
      if (host && isLocalConnection(host.connection)) bytes = await readMaterializedImage(path);
    }
    // Agents show images from anywhere on their machine (another repo, a temp folder), not
    // only their cwd. The daemon confines a read to the root it is given, so an absolute path
    // is read from its own folder. Only image files, size-capped, as before.
    const target = bytes ? null : imageReadTarget(path, cwd);
    if (target) {
      try {
        const file = await driver.readFile(target.root, target.path, undefined, MAX_IMAGE_BYTES);
        if (file.size <= MAX_IMAGE_BYTES) bytes = file.bytes;
      } catch {
        bytes = null;
      }
    }
    if (!bytes) return c.json({ error: "Image unavailable from this host" }, 404);
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": mime,
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": "inline",
    });
  });

  // ---- Search, outline and rewind ------------------------------------------------------------
  app.get("/api/hosts/:host/agents/:agent/search", async (c) => {
    const query = z.string().trim().min(1).max(500).parse(c.req.query("q"));
    const cursor = z.coerce.number().int().nonnegative().optional().parse(c.req.query("cursor"));
    const result = await hosts.get(c.req.param("host")).driver.searchAgentTimeline({ agentId: c.req.param("agent"), query, cursor });
    if (result.error) return c.json({ error: result.error }, 502);
    return c.json(result);
  });
  /** The conversation's user prompts (seq + short preview), for the outline rail. */
  app.get("/api/hosts/:host/agents/:agent/timeline/prompts", async (c) => {
    const client = hosts.get(c.req.param("host"));
    try {
      const page = await client.driver.listAgentTimelinePrompts(c.req.param("agent"), { timeout: 15_000 });
      return c.json({
        epoch: page.epoch,
        prompts: page.prompts.map((p) => ({ seq: p.seq, preview: p.preview.replace(/\s+/g, " ").trim().slice(0, 240) })),
      } satisfies PromptIndex);
    } catch (error) {
      // Older daemons have no prompt index; the rail simply does not appear.
      return c.json({ error: errorMessage(error, "Prompt index unavailable") }, 501);
    }
  });
  /**
   * Rewinds to just before a user message: the conversation, the tracked files, or both, as
   * the provider supports. Cannot be undone; the timeline is replaced (new epoch) on success.
   */
  app.post("/api/hosts/:host/agents/:agent/rewind", async (c) => {
    const { messageId, mode } = z
      .object({ messageId: z.string().min(1).max(500), mode: z.enum(["conversation", "files", "both"]) })
      .parse(await c.req.json());
    const client = hosts.get(c.req.param("host"));
    const facts = client.directory.facts(c.req.param("agent"));
    if (!facts) return c.json({ error: "Unknown agent" }, 404);
    if (!rewindModes(facts.capabilities).includes(mode))
      return c.json({ error: "This agent cannot rewind that way." }, 400);
    try {
      await client.driver.rewindAgent(c.req.param("agent"), messageId, mode);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error, "Rewind failed") }, 502);
    }
  });

  /**
   * A browser's account of a slow conversation open (see timeline_slow for the server's):
   * together they show whether the time went to the server, the network or the browser.
   */
  app.post("/api/diagnostics/timeline-slow", async (c) => {
    const ms = z.number().int().nonnegative().max(3_600_000).nullable();
    const long = z.number().int().nonnegative().max(90 * 86_400_000).nullable();
    const input = z.object({
      hostId: z.string().min(1).max(200), agentId: z.string().min(1).max(200),
      totalMs: ms, connectedMs: ms, rowsMs: ms, renderMs: ms,
      // Pages before 0.8.1 do not report first bytes.
      firstByteMs: ms.optional(),
      // From 0.9.1: the kind of browser (never its user agent), the connection, and how the
      // stream's body arrived, to tell a held-back response from one that trickled in.
      via: z.enum(["latest", "stream"]).optional(),
      engine: z.enum(["webkit", "blink", "gecko", "other"]).optional(),
      os: z.enum(["ios", "android", "macos", "windows", "linux", "other"]).optional(),
      standalone: z.boolean().optional(),
      protocol: z.string().max(20).nullable().optional(),
      encoding: z.string().max(10).nullable().optional(),
      chunks: z.number().int().nonnegative().max(1_000_000).optional(),
      characters: z.number().int().nonnegative().max(1_000_000_000).optional(),
      lastChunkMs: ms.optional(),
      maxGapMs: z.number().int().nonnegative().max(3_600_000).optional(),
      maxGapEndMs: ms.optional(),
      arrivals: z.array(z.tuple([z.number().int().nonnegative().max(3_600_000), z.number().int().nonnegative().max(1_000_000_000)])).max(10).optional(),
      attempts: z.number().int().nonnegative().max(1000), hidden: z.boolean(),
      // A page, and its time in the background, can last days.
      pageAgeMs: long.optional(), backgroundMs: long.optional(), visibleForMs: ms.optional(),
      version: z.string().max(40).optional(),
    }).strict().parse(await c.req.json());
    logEvent("timeline_slow_client", input);
    return c.json({ ok: true });
  });
}
