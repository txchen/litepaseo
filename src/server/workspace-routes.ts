import type { Hono } from "hono";
import { z } from "zod";
import type { Hosts } from "./hosts.ts";
import type { Store } from "./store.ts";
import { eventStream } from "./sse.ts";
import { imageMime, MAX_IMAGE_BYTES } from "./media.ts";

/** Text files larger than this open truncated: the viewer is for reading, not for dumps. */
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;
/** Terminal output is coalesced into one event per frame-ish interval. */
const TERMINAL_FLUSH_MS = 16;

const path = z.string().min(1).max(4096).refine((p) => !p.includes("\0"));

/**
 * The workspace side panel (files, terminals) and schedules. Every call goes to the host's
 * daemon, which confines file access to the workspace and owns the terminals; nothing here
 * keeps state beyond an open terminal stream.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerWorkspaceRoutes(app: Hono<any>, hosts: Hosts, store: Store, valid: (c: any) => () => boolean) {
  app.get("/api/hosts/:host/changes", async c => {
    const cwd = path.parse(c.req.query("cwd"));
    const result = await hosts.get(c.req.param("host")).driver.getCheckoutDiff(cwd, { mode: "uncommitted" });
    if (result.error) return c.json({ error: result.error.message }, 409);
    return c.json(result);
  });
  // ---- Files -------------------------------------------------------------------------------
  app.get("/api/hosts/:host/fs/list", async (c) => {
    const cwd = path.parse(c.req.query("cwd"));
    const dir = c.req.query("path") || ".";
    const { driver } = hosts.get(c.req.param("host"));
    try {
      const result = await driver.listDirectory(cwd, dir);
      const entries = (result.entries ?? [])
        .map((e) => ({ name: e.name, path: e.path, kind: e.kind, size: e.size }))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === "directory" ? -1 : 1));
      return c.json({ path: result.path, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES });
    } catch (error) {
      return c.json({ error: (error as Error).message || "Directory unavailable" }, 404);
    }
  });
  app.get("/api/hosts/:host/fs/read", async (c) => {
    const cwd = path.parse(c.req.query("cwd"));
    const file = path.parse(c.req.query("path"));
    const { driver } = hosts.get(c.req.param("host"));
    try {
      const result = await driver.readFile(cwd, file, undefined, MAX_TEXT_BYTES + 1);
      const text = result.kind === "text" ? new TextDecoder().decode(result.bytes.subarray(0, MAX_TEXT_BYTES)) : undefined;
      return c.json({
        path: result.path,
        kind: result.kind,
        mime: result.mime,
        size: result.size,
        modifiedAt: result.modifiedAt,
        ...(text !== undefined ? { text, truncated: result.size > MAX_TEXT_BYTES } : {}),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message || "File unavailable" }, 404);
    }
  });
  app.get("/api/hosts/:host/fs/raw", async (c) => {
    const cwd = path.parse(c.req.query("cwd"));
    const file = path.parse(c.req.query("path"));
    const mime = imageMime(file);
    if (!mime) return c.json({ error: "Only images can be opened raw" }, 415);
    const { driver } = hosts.get(c.req.param("host"));
    try {
      const result = await driver.readFile(cwd, file, undefined, MAX_IMAGE_BYTES);
      return c.body(result.bytes as Uint8Array<ArrayBuffer>, 200, { "Content-Type": mime, "Cache-Control": "private, max-age=60" });
    } catch {
      return c.json({ error: "Image unavailable" }, 404);
    }
  });

  // ---- Terminals ---------------------------------------------------------------------------
  app.get("/api/hosts/:host/terminals", async (c) => {
    const cwd = path.parse(c.req.query("cwd"));
    const result = await hosts.get(c.req.param("host")).driver.listTerminals(cwd);
    return c.json((result.terminals ?? []).map((t) => ({ id: t.id, name: t.name, title: t.title ?? null, cwd: t.cwd })));
  });
  app.post("/api/hosts/:host/terminals", async (c) => {
    const input = z
      .object({ cwd: path, rows: z.number().int().min(4).max(500), cols: z.number().int().min(10).max(1000), name: z.string().max(80).optional() })
      .parse(await c.req.json());
    const result = await hosts.get(c.req.param("host")).driver.createTerminal(input.cwd, input.name, undefined, { size: { rows: input.rows, cols: input.cols } });
    if (!result.terminal) return c.json({ error: result.error ?? "Could not open a terminal" }, 502);
    return c.json({ id: result.terminal.id, name: result.terminal.name, title: result.terminal.title ?? null, cwd: result.terminal.cwd }, 201);
  });
  app.delete("/api/hosts/:host/terminals/:id", async (c) => {
    await hosts.get(c.req.param("host")).driver.killTerminal(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/hosts/:host/terminals/:id/input", async (c) => {
    const input = z
      .union([
        z.object({ data: z.string().min(1).max(64 * 1024) }),
        z.object({ rows: z.number().int().min(4).max(500), cols: z.number().int().min(10).max(1000) }),
      ])
      .parse(await c.req.json());
    const { driver } = hosts.get(c.req.param("host"));
    driver.sendTerminalInput(c.req.param("id"), "data" in input ? { type: "input", data: input.data } : { type: "resize", rows: input.rows, cols: input.cols });
    return c.json({ ok: true });
  });
  /** Live output as SSE: a full replay first (scrollback), then coalesced output chunks. */
  app.get("/api/hosts/:host/terminals/:id/stream", (c) => {
    const { driver } = hosts.get(c.req.param("host"));
    const id = c.req.param("id");
    const rows = Number(c.req.query("rows")) || 24,
      cols = Number(c.req.query("cols")) || 80;
    return eventStream(c.req.raw.signal, (send) => {
      let pending: Uint8Array[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        timer = undefined;
        if (!pending.length) return;
        send({ t: "o", d: Buffer.concat(pending).toString("base64") });
        pending = [];
      };
      const push = (bytes: Uint8Array) => {
        pending.push(bytes);
        timer ??= setTimeout(flush, TERMINAL_FLUSH_MS);
      };
      const subscription = driver.observeTerminal(
        id,
        (event) => {
          if (event.type === "output") push(event.data);
          else if (event.replay.type === "begin") {
            pending = [];
            send({ t: "reset" });
          } else if (event.replay.type === "data") push(event.replay.data);
        },
        { restore: { mode: "full-snapshot", scrollbackLines: 2000, size: { rows, cols } } },
      );
      const stop = subscription.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type === "terminal_stream_exit") send({ t: "exit" });
        },
        error: () => send({ t: "exit" }),
      });
      subscription.ready.catch(() => send({ t: "exit" }));
      return () => {
        clearTimeout(timer);
        stop();
        void subscription.release().catch(() => {});
      };
    }, valid(c));
  });

  // ---- Schedules ---------------------------------------------------------------------------
  /** Every connected host's schedules; a host that fails reports its error instead. */
  app.get("/api/schedules", async (c) => {
    const results = await Promise.all(
      store.hosts().map(async (h) => {
        try {
          if (hosts.state(h.id) !== "connected") return { hostId: h.id, schedules: [], error: "Host is offline" };
          const list = await hosts.get(h.id).driver.scheduleList();
          return { hostId: h.id, schedules: list.schedules ?? [], error: list.error ?? null };
        } catch (error) {
          return { hostId: h.id, schedules: [], error: (error as Error).message || "Schedules unavailable" };
        }
      }),
    );
    return c.json(results);
  });
  app.post("/api/hosts/:host/schedules", async (c) => {
    const input = z
      .object({
        name: z.string().trim().max(120).optional(),
        prompt: z.string().trim().min(1).max(20000),
        cron: z.string().trim().min(9).max(120),
        timezone: z.string().max(80).optional(),
        cwd: path,
        provider: z.string().min(1).max(200),
        model: z.string().min(1).max(300).optional(),
        thinkingOptionId: z.string().min(1).max(200).optional(),
        archiveOnFinish: z.boolean().default(true),
        runOnCreate: z.boolean().default(false),
      })
      .parse(await c.req.json());
    const result = await hosts.get(c.req.param("host")).driver.scheduleCreate({
      prompt: input.prompt,
      name: input.name || null,
      cadence: { type: "cron", expression: input.cron, ...(input.timezone ? { timezone: input.timezone } : {}) },
      target: {
        type: "new-agent",
        config: {
          provider: input.provider,
          cwd: input.cwd,
          ...(input.model ? { model: input.model } : {}),
          ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
          archiveOnFinish: input.archiveOnFinish,
          isolation: "local",
          title: input.name || null,
        },
      },
      runOnCreate: input.runOnCreate,
    });
    if (result.error) return c.json({ error: result.error }, 400);
    return c.json(result.schedule, 201);
  });
  app.patch("/api/hosts/:host/schedules/:id", async (c) => {
    const input = z
      .object({
        name: z.string().trim().max(120).nullable().optional(),
        prompt: z.string().trim().min(1).max(20000).optional(),
        cron: z.string().trim().min(9).max(120).optional(),
        timezone: z.string().max(80).optional(),
        cwd: path.optional(),
        provider: z.string().min(1).max(200).optional(),
        model: z.string().min(1).max(300).nullable().optional(),
        archiveOnFinish: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const agentConfig = {
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.archiveOnFinish !== undefined ? { archiveOnFinish: input.archiveOnFinish } : {}),
    };
    const result: any = await hosts.get(c.req.param("host")).driver.scheduleUpdate({
      id: c.req.param("id"),
      ...(input.name !== undefined ? { name: input.name || null } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.cron ? { cadence: { type: "cron" as const, expression: input.cron, ...(input.timezone ? { timezone: input.timezone } : {}) } } : {}),
      ...(Object.keys(agentConfig).length ? { newAgentConfig: agentConfig } : {}),
    });
    if (result?.error) return c.json({ error: result.error }, 400);
    return c.json(result?.schedule ?? { ok: true });
  });
  const action = (name: "pause" | "resume" | "run" | "delete" | "logs") => async (c: any) => {
    const { driver } = hosts.get(c.req.param("host"));
    const options = { id: c.req.param("id") };
    const result: any =
      name === "pause" ? await driver.schedulePause(options)
      : name === "resume" ? await driver.scheduleResume(options)
      : name === "run" ? await driver.scheduleRunOnce(options)
      : name === "delete" ? await driver.scheduleDelete(options)
      : await driver.scheduleLogs(options);
    if (result?.error) return c.json({ error: result.error }, 400);
    return c.json(name === "logs" ? { runs: (result.runs ?? []).slice(-50).reverse() } : { ok: true });
  };
  app.post("/api/hosts/:host/schedules/:id/pause", action("pause"));
  app.post("/api/hosts/:host/schedules/:id/resume", action("resume"));
  app.post("/api/hosts/:host/schedules/:id/run", action("run"));
  app.delete("/api/hosts/:host/schedules/:id", action("delete"));
  app.get("/api/hosts/:host/schedules/:id/logs", action("logs"));
}
