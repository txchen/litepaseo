import { z } from "zod";
import { AgentPermissionResponseSchema } from "@getpaseo/protocol/messages";
import { UnknownHostError } from "./hosts.ts";
import { type App, type RouteContext } from "./route-context.ts";
import type {
  AgentConfigChange,
  AgentConfigOptions,
  AgentFeatureOption,
  CreateSessionRequest,
  ProjectOption,
  ProviderOption,
} from "../shared/wire.ts";

/** Starting sessions, the composer's model/mode/feature switches, and controlling an agent. */
export function registerAgentRoutes(app: App, { hosts }: RouteContext) {
  // ---- New sessions ---------------------------------------------------------------------------
  /** Providers the host can start right now, read from the daemon's provider snapshot. */
  app.get("/api/hosts/:host/providers", async (c) => {
    const snapshot = await hosts.get(c.req.param("host")).api.providers.snapshot();
    const providers: ProviderOption[] = snapshot.entries
      .filter((entry) => entry.enabled !== false && entry.status !== "unavailable")
      .map((entry) => ({
        id: entry.provider,
        label: entry.label ?? entry.provider,
        status: entry.status,
        ...(entry.error ? { error: entry.error } : {}),
        defaultModeId: entry.defaultModeId ?? null,
        modes: (entry.modes ?? []).map((m) => ({
          id: m.id,
          label: m.label,
          ...(m.description ? { description: m.description } : {}),
        })),
        models: (entry.models ?? [])
          .filter((m) => m.isSelectable !== false)
          .map((m) => ({
            id: m.id,
            label: m.label,
            ...(m.description ? { description: m.description } : {}),
            isDefault: m.isDefault === true,
            thinking: (m.thinkingOptions ?? []).map((t) => ({ id: t.id, label: t.label })),
            defaultThinkingId: m.defaultThinkingOptionId ?? null,
          })),
      }));
    return c.json(providers);
  });
  /** Projects the daemon knows, as starting points for a new session. */
  app.get("/api/hosts/:host/projects", async (c) => {
    const result = await hosts.get(c.req.param("host")).api.projects.list();
    const projects: ProjectOption[] = result.projects.map((p) => ({
      key: p.projectKey ?? p.projectId,
      name: p.projectCustomName || p.projectDisplayName,
      rootPath: p.projectRootPath,
      kind: p.projectKind,
    }));
    return c.json(projects);
  });
  /**
   * Starts a session. The browser's idempotency key travels to the daemon, so retrying after an
   * unknown outcome cannot create a second session.
   */
  app.post("/api/hosts/:host/agents", async (c) => {
    const input = z
      .object({
        idempotencyKey: z.string().uuid(),
        cwd: z.string().trim().min(1).max(4096),
        provider: z.string().trim().min(1).max(200).regex(/^[^/]+$/),
        model: z.string().trim().min(1).max(300).optional(),
        modeId: z.string().trim().min(1).max(200).optional(),
        thinkingOptionId: z.string().trim().min(1).max(200).optional(),
        featureValues: z.record(z.string(), z.unknown()).optional(),
        prompt: z.string().max(100000).optional(),
        worktreeBranch: z.string().trim().min(1).max(200).optional(),
      })
      .parse(await c.req.json()) satisfies CreateSessionRequest;
    const hostId = c.req.param("host");
    const { api } = hosts.get(hostId);
    try {
      let model = input.model;
      if (!model) {
        const snapshot = await api.providers.snapshot();
        const provider = snapshot.entries.find((p) => p.provider === input.provider && p.enabled !== false && p.status !== "unavailable");
        const models = provider?.models?.filter((m) => m.isSelectable !== false) ?? [];
        model = models.find((m) => m.isDefault)?.id ?? models[0]?.id;
        if (!model) return c.json({ error: "No selectable model is available for this provider. Refresh providers and select a model." }, 400);
      }
      const agent = await api.agents.create({
        idempotencyKey: input.idempotencyKey,
        cwd: input.cwd,
        config: {
          provider: `${input.provider}/${model}`,
          ...(input.featureValues ? { featureValues: input.featureValues } : {}),
          ...(input.modeId ? { modeId: input.modeId } : {}),
          ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
        },
        ...(input.prompt?.trim() ? { prompt: input.prompt } : {}),
        ...(input.worktreeBranch ? { worktree: { mode: "branch-off" as const, newBranch: input.worktreeBranch } } : {}),
      });
      return c.json({ id: agent.id, key: `${hostId}:${agent.id}` }, 201);
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error && error.message
            ? `Could not start the session: ${error.message}`
            : "Creation outcome unknown. Check the session list before retrying.",
        },
        502,
      );
    }
  });

  // ---- Composer: model, thinking, mode and provider features ---------------------------------
  /** What the open agent can switch to. Modes/features come from the live directory (no round trip). */
  app.get("/api/hosts/:host/agents/:agent/config", async (c) => {
    const client = hosts.get(c.req.param("host"));
    const facts = client.directory.facts(c.req.param("agent"));
    if (!facts) return c.json({ error: "Unknown agent" }, 404);
    const snapshot = await client.api.providers.snapshot();
    const entry = snapshot.entries.find((p) => p.provider === facts.provider);
    const options: AgentConfigOptions = {
      models: (entry?.models ?? [])
        .filter((m) => m.isSelectable !== false)
        .map((m) => ({
          id: m.id,
          label: m.label,
          thinking: (m.thinkingOptions ?? []).map((t) => ({ id: t.id, label: t.label })),
          defaultThinkingId: m.defaultThinkingOptionId ?? null,
        })),
      modes: facts.availableModes.map((m) => ({ id: m.id, label: m.label, ...(m.description ? { description: m.description } : {}) })),
      features: facts.features.map((f): AgentFeatureOption =>
        f.type === "toggle"
          ? { type: "toggle", id: f.id, label: f.label, ...(f.tooltip ? { tooltip: f.tooltip } : {}), value: f.value }
          : {
              type: "select",
              id: f.id,
              label: f.label,
              ...(f.tooltip ? { tooltip: f.tooltip } : {}),
              value: f.value,
              options: f.options.map((o) => ({ id: o.id, label: o.label })),
            },
      ),
    };
    return c.json(options);
  });
  app.post("/api/hosts/:host/agents/:agent/config", async (c) => {
    const change = z
      .object({
        model: z.string().min(1).max(300).optional(),
        thinkingOptionId: z.string().min(1).max(200).optional(),
        modeId: z.string().min(1).max(200).optional(),
        feature: z.object({ id: z.string().min(1).max(200), value: z.union([z.string().max(200), z.boolean()]) }).optional(),
      })
      .refine((v) => Object.values(v).filter((x) => x !== undefined).length === 1)
      .parse(await c.req.json()) satisfies AgentConfigChange;
    const { driver } = hosts.get(c.req.param("host"));
    const agent = c.req.param("agent");
    let notice: unknown = null;
    if (change.model) await driver.setAgentModel(agent, change.model);
    else if (change.thinkingOptionId) notice = await driver.setAgentThinkingOption(agent, change.thinkingOptionId);
    else if (change.modeId) notice = await driver.setAgentMode(agent, change.modeId);
    else if (change.feature) await driver.setAgentFeature(agent, change.feature.id, change.feature.value);
    return c.json({ ok: true, notice });
  });

  // ---- Controlling a running agent -----------------------------------------------------------
  app.post("/api/hosts/:host/agents/:agent/stop", async (c) => {
    await hosts.get(c.req.param("host")).driver.cancelAgent(c.req.param("agent"));
    return c.json({ status: "acknowledged" });
  });
  app.post("/api/hosts/:host/agents/:agent/permissions/:permission", async (c) => {
    const response = AgentPermissionResponseSchema.parse(await c.req.json());
    const agent = hosts.get(c.req.param("host")).api.agents.ref(c.req.param("agent"));
    await agent.refresh();
    if (!agent.pendingPermissions?.some((p) => p.id === c.req.param("permission")))
      return c.json({ error: "Permission no longer pending. Refresh the conversation." }, 409);
    await agent.respondToPermission({ requestId: c.req.param("permission"), response });
    return c.json({ status: "acknowledged" });
  });
  /** Marks a settled turn as seen (Paseo's attention flag), moving it out of "review". */
  app.post("/api/hosts/:host/agents/:agent/read", async (c) => {
    await hosts.get(c.req.param("host")).driver.clearAgentAttention(c.req.param("agent"));
    return c.json({ ok: true });
  });
  app.post("/api/hosts/:host/agents/:agent/archive", async (c) => {
    await hosts.get(c.req.param("host")).api.agents.ref(c.req.param("agent")).archive();
    return c.json({ ok: true });
  });

  // ---- Plugins whose daemon side LitePaseo drives ------------------------------------------------
  /**
   * next-input: the daemon appends a placeholder row after a completed turn; prediction runs only
   * when a client that shows the row asks. Only this one plugin method is reachable from here.
   */
  app.post("/api/hosts/:host/agents/:agent/suggestion", async (c) => {
    const { token } = z.object({ token: z.string().min(1).max(200) }).parse(await c.req.json());
    try {
      const output = (await hosts
        .get(c.req.param("host"))
        .driver.invokePluginRpc("next-input", "suggestions.predict", { agentId: c.req.param("agent"), token })) as {
        status?: string;
        text?: string;
      };
      return c.json({ status: String(output?.status ?? "error"), text: String(output?.text ?? "") });
    } catch (error) {
      if (error instanceof UnknownHostError) throw error;
      return c.json({ status: "unavailable", text: "" });
    }
  });
}
