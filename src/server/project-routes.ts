import { z } from "zod";
import { UnknownHostError } from "./hosts.ts";
import { IconCache } from "./media.ts";
import { importProjectIcon, MAX_ICON_BYTES } from "./project-icon-import.ts";
import { customIcons, errorMessage, hostPath, type App, type Ctx, type RouteContext } from "./route-context.ts";
import type { ArchivedWorkspaceSummary, ProjectConfigState } from "../shared/wire.ts";

const configErrors: Record<string, [string, 404 | 409 | 422 | 502]> = {
  project_not_found: ["The selected host has no record of this project.", 404],
  invalid_project_config: ["paseo.json couldn’t be parsed. Fix the file on disk, then reload.", 422],
  stale_project_config: ["Config changed on disk. Reload to fetch the latest paseo.json before saving.", 409],
  write_failed: ["Couldn’t save paseo.json. Try again, or reload the latest version from disk.", 502],
};
const configState = (
  payload: { ok: true; repoRoot: string; config: unknown; revision: ProjectConfigState["revision"]; hasUncommittedWorktreeSetupChanges?: boolean },
): ProjectConfigState => ({
  rootPath: payload.repoRoot,
  config: (payload.config as Record<string, unknown> | null) ?? null,
  revision: payload.revision,
  ...(payload.hasUncommittedWorktreeSetupChanges ? { uncommittedSetup: true } : {}),
});

/** Paseo's project and workspace (thread) menus: icons, rename, remove, paseo.json, thread actions. */
export function registerProjectRoutes(app: App, { hosts, fetch }: RouteContext) {
  const projectIcons = new IconCache();
  /**
   * A project's icon, cached briefly per host. With `project`, the daemon's effective icon (a
   * custom one if set; `v` is its revision, so a change is a new cache entry); otherwise the
   * favicon/logo found in `cwd`.
   */
  app.get("/api/hosts/:host/project-icon", async (c) => {
    const hostId = c.req.param("host");
    const cwd = hostPath.parse(c.req.query("cwd"));
    const project = z.string().max(200).optional().parse(c.req.query("project") || undefined);
    const version = z.string().max(200).optional().parse(c.req.query("v") || undefined) ?? "";
    const key = project ? `${hostId}\np:${project}\n${version}` : `${hostId}\n${cwd}`;
    let icon = projectIcons.get(key);
    if (icon === undefined) {
      try {
        const { driver } = hosts.get(hostId);
        const result = project && customIcons(hosts, hostId) ? await driver.getProjectIcon(project) : await driver.requestProjectIcon(cwd);
        icon = result.icon && /^image\/(png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon)$/.test(result.icon.mimeType)
          ? { data: Buffer.from(result.icon.data, "base64"), mimeType: result.icon.mimeType }
          : null;
      } catch (error) {
        if (error instanceof UnknownHostError) throw error;
        return c.json({ error: "Icon unavailable" }, 502);
      }
      projectIcons.set(key, icon);
    }
    if (!icon) return c.body(null, 204, { "Cache-Control": "private, max-age=600" });
    return c.body(icon.data as Uint8Array<ArrayBuffer>, 200, { "Content-Type": icon.mimeType, "Cache-Control": "private, max-age=600" });
  });

  // ---- Project actions: Paseo's project menu (settings, remove) -------------------------------------
  /** Removes the project from the daemon; its threads are archived (history stays on the host). */
  app.delete("/api/hosts/:host/projects/:project", async (c) => {
    const result = await hosts.get(c.req.param("host")).driver.removeProject(c.req.param("project"));
    return c.json({ ok: true, removedWorkspaceIds: result.removedWorkspaceIds });
  });
  /**
   * Paseo's project edit: name and icon, decided together and saved once. Icon bytes are acquired
   * first (the step most likely to fail), then rename, then icon; a retry repeats the same calls.
   * A failure names the field it belongs to.
   */
  app.post("/api/hosts/:host/projects/:project/edit", async (c) => {
    const input = z
      .object({
        rename: z.object({ customName: z.string().trim().max(200).nullable() }).nullable(),
        icon: z
          .discriminatedUnion("type", [
            z.object({ type: z.literal("automatic") }),
            z.object({ type: z.literal("upload"), data: z.string().min(1).max(Math.ceil((MAX_ICON_BYTES * 4) / 3) + 4) }),
            z.object({ type: z.literal("url"), url: z.string().trim().min(1).max(4096) }),
          ])
          .nullable(),
      })
      .parse(await c.req.json());
    const hostId = c.req.param("host");
    const projectId = c.req.param("project");
    const { driver } = hosts.get(hostId);
    if (input.icon && !customIcons(hosts, hostId))
      return c.json({ error: "Update Paseo on this host to set project icons.", scope: "icon" }, 409);
    const failed = (scope: "name" | "icon", error: unknown) =>
      c.json({ error: errorMessage(error, "Request failed"), scope }, 422);
    let source: { type: "automatic" } | { type: "upload"; data: string } | null = null;
    if (input.icon) {
      try {
        source = input.icon.type === "url" ? { type: "upload", data: await importProjectIcon(input.icon.url, fetch) } : input.icon;
      } catch (error) {
        return failed("icon", error);
      }
    }
    if (input.rename) {
      try {
        await driver.renameProject(projectId, input.rename.customName || null);
      } catch (error) {
        return failed("name", error);
      }
    }
    if (source) {
      try {
        await driver.setProjectIcon(projectId, source);
      } catch (error) {
        return failed("icon", error);
      }
    }
    return c.json({ ok: true });
  });
  /** The project's paseo.json (worktree setup/teardown, scripts, generation prompts). */
  app.get("/api/hosts/:host/project-config", async (c) => {
    const root = hostPath.parse(c.req.query("root"));
    const payload = await hosts.get(c.req.param("host")).driver.readProjectConfig(root);
    if (!payload.ok) {
      const [error, status] = configErrors[payload.error.code] ?? ["Could not read paseo.json.", 502];
      return c.json({ error, code: payload.error.code }, status);
    }
    return c.json(configState(payload));
  });
  app.put("/api/hosts/:host/project-config", async (c) => {
    const input = z
      .object({
        root: hostPath,
        config: z.record(z.string(), z.unknown()),
        revision: z.object({ mtimeMs: z.number(), size: z.number() }).nullable(),
      })
      .parse(await c.req.json());
    if (JSON.stringify(input.config).length > 256_000) return c.json({ error: "paseo.json is too large." }, 413);
    const payload = await hosts.get(c.req.param("host")).driver.writeProjectConfig({
      repoRoot: input.root,
      config: input.config as never,
      expectedRevision: input.revision,
    });
    if (!payload.ok) {
      const [error, status] =
        payload.error.code === "invalid_project_config"
          ? ["The host rejected this config: it does not match the paseo.json format.", 422 as const]
          : (configErrors[payload.error.code] ?? ["Could not write paseo.json.", 502 as const]);
      return c.json({ error, code: payload.error.code }, status);
    }
    return c.json(configState(payload));
  });

  // ---- Workspace (thread) actions: the same daemon operations Paseo's sidebar uses ------------------
  const workspace = (c: Ctx) => ({ driver: hosts.get(c.req.param("host")!).driver, id: c.req.param("workspace")! });
  /** Rename; null resets to the name derived from the branch or directory. */
  app.post("/api/hosts/:host/workspaces/:workspace/title", async (c) => {
    const { title } = z.object({ title: z.string().trim().max(200).nullable() }).parse(await c.req.json());
    const { driver, id } = workspace(c);
    await driver.setWorkspaceTitle(id, title ? title : null);
    return c.json({ ok: true });
  });
  app.post("/api/hosts/:host/workspaces/:workspace/pin", async (c) => {
    const { pinned } = z.object({ pinned: z.boolean() }).parse(await c.req.json());
    const { driver, id } = workspace(c);
    await driver.setWorkspacePinned(id, pinned);
    return c.json({ ok: true });
  });
  app.post("/api/hosts/:host/workspaces/:workspace/unread", async (c) => {
    const { driver, id } = workspace(c);
    await driver.markWorkspaceUnread(id);
    return c.json({ ok: true });
  });
  app.post("/api/hosts/:host/workspaces/:workspace/read", async (c) => {
    const { driver, id } = workspace(c);
    await driver.clearWorkspaceAttention(id);
    return c.json({ ok: true });
  });
  app.post("/api/hosts/:host/workspaces/:workspace/archive", async (c) => {
    const { driver, id } = workspace(c);
    const res = await driver.archiveWorkspace(id);
    if (res?.error) return c.json({ error: res.error }, 409);
    return c.json({ ok: true, archivedAt: res?.archivedAt ?? null });
  });
  app.post("/api/hosts/:host/workspaces/:workspace/undo-archive", async (c) => {
    const { driver, id } = workspace(c);
    if (typeof driver.undoWorkspaceArchive !== "function")
      return c.json({ error: "This host does not support undoing workspace archive." }, 409);
    try {
      await driver.undoWorkspaceArchive(id);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not undo archive.") }, 409);
    }
  });
  app.post("/api/hosts/:host/workspaces/:workspace/restore", async (c) => {
    const { driver, id } = workspace(c);
    if (typeof driver.restoreWorkspace !== "function")
      return c.json({ error: "This host does not support restoring archived workspaces." }, 409);
    try {
      await driver.restoreWorkspace(id);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not restore workspace.") }, 409);
    }
  });

  // ---- Archived workspaces --------------------------------------------------------------------
  app.get("/api/hosts/:host/archived-workspaces", async (c) => {
    const hostId = c.req.param("host");
    const q = z.string().max(200).optional().parse(c.req.query("q") || undefined);
    const { driver } = hosts.get(hostId);
    if (typeof driver.fetchAgentHistory !== "function") return c.json([] satisfies ArchivedWorkspaceSummary[]);
    try {
      const res = await driver.fetchAgentHistory({
        filter: { includeArchived: true },
        ...(q?.trim() ? { search: q.trim() } : {}),
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: 100 },
      });
      const seen = new Set<string>();
      const out: ArchivedWorkspaceSummary[] = [];
      for (const entry of res.entries ?? []) {
        const agent = entry.agent;
        if (!agent?.archivedAt) continue;
        const dedupeKey = agent.workspaceId || agent.id;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const project = entry.project?.projectName || agent.cwd.replace(/\/+$/, "").split("/").pop() || agent.cwd;
        out.push({
          hostId,
          id: agent.id,
          workspaceId: agent.workspaceId ?? null,
          name: agent.title || project,
          project,
          cwd: agent.cwd,
          branch: null,
          archivedAt: agent.archivedAt,
          provider: agent.provider,
          status: agent.status,
        });
      }
      return c.json(out);
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not load archived workspaces.") }, 502);
    }
  });

  // ---- Add project & GitHub clone -------------------------------------------------------------
  app.get("/api/hosts/:host/project-suggestions", async (c) => {
    const { driver } = hosts.get(c.req.param("host"));
    if (typeof driver.listProjectSuggestions !== "function") return c.json({ suggestions: [] });
    try {
      const res = await driver.listProjectSuggestions();
      return c.json({ suggestions: res.suggestions ?? [] });
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not load project suggestions.") }, 502);
    }
  });
  app.post("/api/hosts/:host/projects", async (c) => {
    const { cwd } = z.object({ cwd: hostPath }).parse(await c.req.json());
    const { driver } = hosts.get(c.req.param("host"));
    if (typeof driver.addProject !== "function")
      return c.json({ error: "This host does not support adding projects." }, 409);
    try {
      const res = await driver.addProject(cwd);
      if (res.error) return c.json({ error: res.error }, 400);
      return c.json({ ok: true, project: res.project ?? null });
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not add project.") }, 502);
    }
  });
  app.get("/api/hosts/:host/github/search", async (c) => {
    const query = z.string().trim().min(1).max(200).parse(c.req.query("q") ?? "");
    const { driver } = hosts.get(c.req.param("host"));
    if (typeof driver.searchGithubRepositories !== "function")
      return c.json({ error: "This host does not support GitHub search." }, 409);
    try {
      const res = await driver.searchGithubRepositories({ query, limit: 20 });
      if (res.error) return c.json({ error: res.error }, 502);
      return c.json({ repositories: res.repositories ?? [] });
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not search GitHub repositories.") }, 502);
    }
  });
  app.post("/api/hosts/:host/projects/clone", async (c) => {
    const input = z
      .object({
        repo: z.string().trim().min(1).max(300),
        targetDirectory: hostPath,
        cloneProtocol: z.enum(["https", "ssh"]).optional(),
      })
      .parse(await c.req.json());
    const { driver } = hosts.get(c.req.param("host"));
    if (typeof driver.cloneGithubProject !== "function")
      return c.json({ error: "This host does not support cloning repositories." }, 409);
    try {
      const res = await driver.cloneGithubProject(input);
      if (res.error) return c.json({ error: res.error }, 400);
      return c.json({ ok: true, path: res.checkoutPath ?? input.targetDirectory, project: res.project ?? null });
    } catch (error) {
      return c.json({ error: errorMessage(error, "Could not clone repository.") }, 502);
    }
  });
}
