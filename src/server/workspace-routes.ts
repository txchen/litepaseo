import { z } from "zod";
import { eventStream } from "./sse.ts";
import { imageMime, MAX_IMAGE_BYTES } from "./media.ts";
import { errorMessage, hostPath as path, type App, type Ctx, type RouteContext } from "./route-context.ts";

/** Text files larger than this open truncated: the viewer is for reading, not for dumps. */
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const SEARCH_CACHE_MS = 15_000;
const SEARCH_MAX_FILES = 1500;
const SEARCH_MAX_DIRS = 120;
const SEARCH_BUDGET_MS = 1500;
const SEARCH_SKIP = new Set([".git", "node_modules", "dist", "build", ".next", ".nuxt", "target", "__pycache__", ".venv", "venv", ".cache", "coverage"]);
/** Terminal output is coalesced into one event per frame-ish interval. */
const TERMINAL_FLUSH_MS = 16;
/** A terminal dimension from a query string: whole, within bounds, else the default. */
const clampSize = (value: string | undefined, fallback: number, min: number, max: number) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * The workspace side panel (files, terminals) and schedules. Every call goes to the host's
 * daemon, which confines file access to the workspace and owns the terminals; nothing here
 * keeps state beyond an open terminal stream.
 */
export function registerWorkspaceRoutes(app: App, { hosts, store, streamValidity, encodingOf }: RouteContext) {
  const fileIndexCache = new Map<string, { at: number; files: string[] }>();
  async function workspaceFiles(hostId: string, cwd: string): Promise<string[]> {
    const key = `${hostId}\n${cwd}`;
    const cached = fileIndexCache.get(key);
    const now = Date.now();
    if (cached && now - cached.at < SEARCH_CACHE_MS) return cached.files;
    const { driver } = hosts.get(hostId);
    const files: string[] = [];
    const queue: string[] = ["."];
    const deadline = now + SEARCH_BUDGET_MS;
    let dirs = 0;
    while (queue.length && files.length < SEARCH_MAX_FILES && dirs < SEARCH_MAX_DIRS && Date.now() < deadline) {
      const dir = queue.shift()!;
      dirs++;
      let result;
      try {
        result = await driver.listDirectory(cwd, dir);
      } catch {
        continue;
      }
      for (const e of result.entries ?? []) {
        if (e.kind === "directory") {
          if (!SEARCH_SKIP.has(e.name)) queue.push(e.path);
        } else {
          files.push(e.path);
          if (files.length >= SEARCH_MAX_FILES) break;
        }
      }
    }
    if (fileIndexCache.size > 32) {
      const oldest = fileIndexCache.keys().next().value;
      if (oldest) fileIndexCache.delete(oldest);
    }
    fileIndexCache.set(key, { at: Date.now(), files });
    return files;
  }

  app.get("/api/hosts/:host/changes", async (c) => {
    const cwd = path.parse(c.req.query("cwd"));
    const mode = z.enum(["uncommitted", "base", "all"]).catch("uncommitted").parse(c.req.query("mode"));
    const baseRef = z.string().trim().min(1).max(200).optional().parse(c.req.query("baseRef") || undefined);
    const result = await hosts.get(c.req.param("host")).driver.getCheckoutDiff(cwd, { mode, ...(baseRef ? { baseRef } : {}) });
    if (result.error) return c.json({ error: result.error.message }, 409);
    return c.json(result);
  });
  app.get("/api/hosts/:host/git/commits", async (c) => {
    const cwd = path.parse(c.req.query("cwd"));
    const { driver } = hosts.get(c.req.param("host"));
    if (typeof driver.listCheckoutCommits !== "function") return c.json({ baseRef: null, commits: [] });
    try {
      return c.json(await driver.listCheckoutCommits(cwd));
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not load commits") }, 502);
    }
  });
  app.get("/api/hosts/:host/git/commit-diff", async (c) => {
    const cwd = path.parse(c.req.query("cwd"));
    const sha = z.string().trim().min(4).max(80).regex(/^[0-9a-fA-F]+$/).parse(c.req.query("sha"));
    const filePath = path.parse(c.req.query("path"));
    const { driver } = hosts.get(c.req.param("host"));
    if (typeof driver.getCommitFileDiff !== "function") return c.json({ error: "Commit diff unsupported on this host" }, 409);
    try {
      return c.json(await driver.getCommitFileDiff(cwd, sha, filePath));
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not load commit diff") }, 502);
    }
  });
  app.post("/api/hosts/:host/git/commit", async (c) => {
    const input = z.object({ cwd: path, message: z.string().max(4000).optional(), addAll: z.boolean().optional() }).parse(await c.req.json());
    const { driver } = hosts.get(c.req.param("host"));
    try {
      const res = await driver.checkoutCommit(input.cwd, { ...(input.message?.trim() ? { message: input.message.trim() } : {}), addAll: input.addAll !== false });
      if ((res as { error?: { message?: string } | null }).error) return c.json({ error: (res as { error: { message?: string } }).error.message || "Commit failed" }, 409);
      return c.json(res);
    } catch (error) {
      return c.json({ error: errorMessage(error, "Commit failed") }, 502);
    }
  });
  app.post("/api/hosts/:host/git/push", async (c) => {
    const { cwd } = z.object({ cwd: path }).parse(await c.req.json());
    const { driver } = hosts.get(c.req.param("host"));
    try {
      const res = await driver.checkoutPush(cwd);
      if ((res as { error?: { message?: string } | null }).error) return c.json({ error: (res as { error: { message?: string } }).error.message || "Push failed" }, 409);
      return c.json(res);
    } catch (error) {
      return c.json({ error: errorMessage(error, "Push failed") }, 502);
    }
  });
  app.get("/api/hosts/:host/git/pr-status", async (c) => {
    const cwd = path.parse(c.req.query("cwd"));
    const { driver } = hosts.get(c.req.param("host"));
    if (typeof driver.checkoutPrStatus !== "function") return c.json({ available: false });
    try {
      return c.json(await driver.checkoutPrStatus(cwd));
    } catch (error) {
      return c.json({ error: errorMessage(error, "PR status unavailable") }, 502);
    }
  });
  app.post("/api/hosts/:host/git/pr", async (c) => {
    const input = z.object({ cwd: path, title: z.string().max(300).optional(), body: z.string().max(20_000).optional(), baseRef: z.string().max(200).optional() }).parse(await c.req.json());
    const { driver } = hosts.get(c.req.param("host"));
    try {
      const res = await driver.checkoutPrCreate(input.cwd, {
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        ...(input.body?.trim() ? { body: input.body.trim() } : {}),
        ...(input.baseRef?.trim() ? { baseRef: input.baseRef.trim() } : {}),
      });
      if ((res as { error?: { message?: string } | null }).error) return c.json({ error: (res as { error: { message?: string } }).error.message || "Could not create PR" }, 409);
      return c.json(res);
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not create PR") }, 502);
    }
  });
  app.post("/api/hosts/:host/workspaces/:workspace/base-branch", async (c) => {
    const { baseRef } = z.object({ baseRef: z.string().trim().min(1).max(200) }).parse(await c.req.json());
    const { driver } = hosts.get(c.req.param("host"));
    if (typeof driver.setWorkspaceBaseBranch !== "function") return c.json({ error: "Base branch setting unsupported" }, 409);
    try {
      return c.json(await driver.setWorkspaceBaseBranch({ workspaceId: c.req.param("workspace"), baseRef }));
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not set base branch") }, 502);
    }
  });
  // ---- Workspace scripts & services ----------------------------------------------------------
  app.get("/api/hosts/:host/workspaces/:workspace/scripts", async (c) => {
    const { driver } = hosts.get(c.req.param("host"));
    if (typeof driver.listWorkspaceScripts !== "function") return c.json({ scripts: [] });
    try {
      const res = await driver.listWorkspaceScripts(c.req.param("workspace"));
      if (res.error) return c.json({ error: res.error }, 502);
      return c.json({ scripts: res.scripts ?? [] });
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not list scripts") }, 502);
    }
  });
  app.post("/api/hosts/:host/workspaces/:workspace/scripts/:name/start", async (c) => {
    const { driver } = hosts.get(c.req.param("host"));
    const wsId = c.req.param("workspace"), name = c.req.param("name");
    try {
      const res = typeof driver.startWorkspaceScriptWithStatus === "function"
        ? await driver.startWorkspaceScriptWithStatus(wsId, name)
        : await driver.startWorkspaceScript(wsId, name);
      if (res.error) return c.json({ error: res.error }, 409);
      return c.json(res);
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not start script") }, 502);
    }
  });
  app.post("/api/hosts/:host/workspaces/:workspace/scripts/:name/stop", async (c) => {
    const { driver } = hosts.get(c.req.param("host"));
    if (typeof driver.stopWorkspaceScript !== "function") return c.json({ error: "Stopping scripts is unsupported on this host" }, 409);
    try {
      const res = await driver.stopWorkspaceScript(c.req.param("workspace"), c.req.param("name"));
      if (res.error) return c.json({ error: res.error }, 409);
      return c.json(res);
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not stop script") }, 502);
    }
  });
  app.get("/api/hosts/:host/fs/search", async (c) => {
    const hostId = c.req.param("host");
    const cwd = path.parse(c.req.query("cwd"));
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const limit = clampSize(c.req.query("limit"), 40, 1, 100);
    try {
      const all = await workspaceFiles(hostId, cwd);
      if (!q) return c.json({ files: all.slice(0, limit), total: all.length });
      const tokens = q.split(/\s+/).filter(Boolean);
      const scored: { path: string; score: number }[] = [];
      for (const file of all) {
        const lower = file.toLowerCase();
        if (!tokens.every((t) => lower.includes(t))) continue;
        const base = lower.slice(lower.lastIndexOf("/") + 1);
        let score = 0;
        if (base === q) score = 100;
        else if (base.startsWith(q)) score = 80;
        else if (base.includes(q)) score = 60;
        else if (lower.startsWith(q)) score = 40;
        else score = 20;
        scored.push({ path: file, score: score - file.length * 0.01 });
      }
      scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      return c.json({ files: scored.slice(0, limit).map((s) => s.path), total: scored.length });
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not search files") }, 404);
    }
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
      return c.json({ error: errorMessage(error, "Directory unavailable") }, 404);
    }
  });
  const isTooLarge = (error: unknown) => /too large|maxBytes|exceeds/i.test(error instanceof Error ? error.message : String(error ?? ""));
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
      if (isTooLarge(error)) return c.json({ error: "File is too large to preview" }, 413);
      return c.json({ error: errorMessage(error, "File unavailable") }, 404);
    }
  });
  app.get("/api/hosts/:host/fs/download", async (c) => {
    const cwd = path.parse(c.req.query("cwd"));
    const file = path.parse(c.req.query("path"));
    const { driver } = hosts.get(c.req.param("host"));
    try {
      const result = await driver.readFile(cwd, file, undefined, MAX_DOWNLOAD_BYTES + 1);
      if (result.size > MAX_DOWNLOAD_BYTES) return c.json({ error: "File exceeds 32 MB download limit" }, 413);
      const rawName = (result.path.split("/").pop() || "download").replace(/[\r\n"\\]/g, "_");
      const asciiName = rawName.replace(/[^\x20-\x7e]/g, "_") || "download";
      const encoded = encodeURIComponent(rawName);
      return c.body(result.bytes as Uint8Array<ArrayBuffer>, 200, {
        "Content-Type": result.mime || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
    } catch (error) {
      if (isTooLarge(error)) return c.json({ error: "File exceeds 32 MB download limit" }, 413);
      return c.json({ error: errorMessage(error, "File unavailable") }, 404);
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
      .object({ cwd: path, rows: z.number().int().min(4).max(500), cols: z.number().int().min(10).max(1000), name: z.string().max(80).optional(), profileId: z.string().optional() })
      .parse(await c.req.json());
    const driver = hosts.get(c.req.param("host")).driver;
    const profile = input.profileId ? (await driver.getDaemonConfig()).config.terminalProfiles?.find(p => p.id === input.profileId) : undefined;
    if (input.profileId && !profile) return c.json({ error: "Terminal profile no longer exists. Reload profiles." }, 409);
    const result = await driver.createTerminal(input.cwd, input.name ?? profile?.name, undefined, { ...(profile ? { command: profile.command, args: profile.args } : {}), size: { rows: input.rows, cols: input.cols } });
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
    const rows = clampSize(c.req.query("rows"), 24, 4, 500),
      cols = clampSize(c.req.query("cols"), 80, 10, 1000);
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
        { restore: { mode: "full-snapshot", scrollbackLines: 5000, size: { rows, cols } } },
      );
      let exited = false;
      const finishExit = () => {
        if (exited) return;
        exited = true;
        clearTimeout(timer);
        flush();
        send({ t: "exit" });
      };
      const stop = subscription.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type === "terminal_stream_exit") finishExit();
        },
        error: finishExit,
      });
      subscription.ready.catch(finishExit);
      return () => {
        clearTimeout(timer);
        stop();
        void subscription.release().catch(() => {});
      };
    }, streamValidity(c), encodingOf(c));
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
          return { hostId: h.id, schedules: [], error: errorMessage(error, "Schedules unavailable") };
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
  const action = (name: "pause" | "resume" | "run" | "delete" | "logs") => async (c: Ctx) => {
    const { driver } = hosts.get(c.req.param("host")!);
    const options = { id: c.req.param("id")! };
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
