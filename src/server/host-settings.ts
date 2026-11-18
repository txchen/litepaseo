import { runLifecycle, type LifecycleJob } from "./host-lifecycle.ts";
import type { Hono, Env } from "hono";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  MutableDaemonConfigPatchSchema,
  AgentSkillSelectionSchema,
} from "@getpaseo/protocol/messages";
import type { Hosts } from "./hosts.ts";
import type { HostProviderInfo } from "../shared/wire.ts";

// A deliberately bounded projection: never return daemon credentials or environment overrides.
export const SETTINGS_KEYS = [
  "mcp",
  "browserTools",
  "appendSystemPrompt",
  "idleRuntimeCleanup",
  "resumeOnStartup",
  "resumePrompt",
  "autoArchiveAfterMerge",
  "enableTerminalAgentHooks",
  "agentProfiles",
  "terminalProfiles",
  "metadataGeneration",
  "providers",
  "usage",
  "relay",
  "pluginsEnabled",
] as const;
const providerKeys = ["enabled", "paseoTools", "additionalModels", "extends", "label", "command"];
const gates: Record<string, string> = {
  relay: "relayConfig",
  pluginsEnabled: "plugins",
  agentProfiles: "agentProfiles",
  idleRuntimeCleanup: "idleRuntimeCleanupSetting",
  resumeOnStartup: "resumeOnStartupSetting",
  resumePrompt: "resumeOnStartupSetting",
};
export function projectSettings(config: Record<string, any>) {
  const result: Record<string, any> = {};
  for (const key of SETTINGS_KEYS) if (config[key] !== undefined) result[key] = config[key];
  // Provider definitions can contain arbitrary secrets. Only expose the editable public subset.
  if (result.providers)
    result.providers = Object.fromEntries(
      Object.entries(result.providers).map(([id, value]) => {
        const p = value as Record<string, unknown>;
        return [
          id,
          Object.fromEntries(providerKeys.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])),
        ];
      }),
    );
  return result;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
function retained(expected: unknown, actual: unknown): boolean {
  if (!expected || typeof expected !== "object" || Array.isArray(expected))
    return canonical(expected) === canonical(actual);
  return (
    !!actual &&
    typeof actual === "object" &&
    Object.entries(expected).every(([k, v]) => retained(v, (actual as Record<string, unknown>)[k]))
  );
}
/** A daemon provider snapshot entry as the settings page shows it: every provider, enabled or not. */
export function projectProviderEntry(entry: any): HostProviderInfo {
  return {
    id: entry.provider,
    label: entry.label ?? entry.provider,
    ...(entry.description ? { description: entry.description } : {}),
    source: entry.source === "custom" ? "custom" : "builtin",
    enabled: entry.enabled !== false,
    status: entry.status,
    ...(entry.error ? { error: entry.error } : {}),
    fetchedAt: entry.fetchedAt ?? null,
    defaultModeId: entry.defaultModeId ?? null,
    modes: (entry.modes ?? []).map((m: any) => ({
      id: m.id,
      label: m.label,
      ...(m.description ? { description: m.description } : {}),
    })),
    models: (entry.models ?? [])
      .filter((m: any) => m.isSelectable !== false)
      .map((m: any) => ({
        id: m.id,
        label: m.label,
        ...(m.description ? { description: m.description } : {}),
        isDefault: m.isDefault === true,
        thinking: (m.thinkingOptions ?? []).map((t: any) => ({ id: t.id, label: t.label })),
        defaultThinkingId: m.defaultThinkingOptionId ?? null,
      })),
  };
}
const revision = (config: unknown) => createHash("sha256").update(canonical(config)).digest("hex");
const patchSchema = MutableDaemonConfigPatchSchema.pick(
  Object.fromEntries(SETTINGS_KEYS.map((k) => [k, true])) as Record<
    (typeof SETTINGS_KEYS)[number],
    true
  >,
).strict();
export function registerHostSettings<E extends Env>(app: Hono<E>, hosts: Hosts) {
  const jobs = new Map<string, LifecycleJob>();
  const writers = new Map<string, Promise<void>>();
  app.use("/api/hosts/:host/settings", async (c, next) => {
    if (c.req.method !== "PATCH") return next();
    const host = c.req.param("host"),
      previous = writers.get(host) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    writers.set(host, current);
    await previous;
    try {
      await next();
    } finally {
      release();
      if (writers.get(host) === current) writers.delete(host);
    }
  });
  app.get("/api/hosts/:host/settings", async (c) => {
    const driver = hosts.get(c.req.param("host")).driver;
    const { config } = await driver.getDaemonConfig();
    const safe = projectSettings(config);
    const info = driver.getLastServerInfoMessage();
    return c.json({
      config: safe,
      revision: revision(safe),
      features: info?.features ?? {},
      version: info?.version ?? null,
      desktopManaged: info?.desktopManaged === true,
    });
  });
  app.patch("/api/hosts/:host/settings", async (c) => {
    const body = z
      .object({
        revision: z.string(),
        patch: patchSchema
          .extend({ removeProviders: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1).optional() })
          .strict(),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!body.success)
      return c.json(
        {
          error: "Invalid host settings",
          issues: body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        400,
      );
    const driver = hosts.get(c.req.param("host")).driver;
    const features = driver.getLastServerInfoMessage()?.features as
      | Record<string, unknown>
      | undefined;
    const { removeProviders, ...patch } = body.data.patch;
    for (const key of Object.keys(patch))
      if (gates[key] && features?.[gates[key]] !== true)
        return c.json({ error: `This host does not support ${key}` }, 409);
    // Do not allow passthrough provider fields (credentials and environment overrides) through this public form.
    if (
      patch.providers &&
      Object.values(patch.providers).some((p) =>
        Object.keys(p).some((k) => !providerKeys.includes(k)),
      )
    )
      return c.json({ error: "Unsupported provider field" }, 400);
    const current = projectSettings((await driver.getDaemonConfig()).config);
    if (revision(current) !== body.data.revision)
      return c.json({ error: "Host settings changed elsewhere. Reload before saving." }, 409);
    if (removeProviders) {
      if (features?.providerRemoval !== true)
        return c.json({ error: "This host cannot remove providers. Update it first." }, 409);
      // Only custom providers (those extending a built-in) can go; built-ins can only be disabled.
      const unknown = removeProviders.find((id) => !current.providers?.[id]?.extends);
      if (unknown) return c.json({ error: `${unknown} is not a custom provider on this host` }, 400);
      if (patch.providers && removeProviders.some((id) => id in patch.providers!))
        return c.json({ error: "A provider cannot be changed and removed in the same save" }, 400);
    }
    if (patch.providers) {
      const publicProvider = z
        .object({
          enabled: z.boolean().optional(),
          label: z.string().trim().min(1).optional(),
          extends: z
            .enum(["claude", "codex", "copilot", "opencode", "pi", "omp", "acp"])
            .optional(),
          command: z.array(z.string().min(1)).min(1).optional(),
          paseoTools: z
            .object({
              enabled: z.boolean().optional(),
              disabledTools: z.array(z.string()).optional(),
            })
            .strict()
            .optional(),
          additionalModels: z
            .array(
              z
                .object({
                  id: z.string().min(1),
                  label: z.string().min(1),
                  description: z.string().optional(),
                  isDefault: z.boolean().optional(),
                  thinkingOptions: z.array(z.unknown()).optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .strict();
      const valid = z
        .record(z.string().regex(/^[a-z][a-z0-9-]*$/), publicProvider)
        .safeParse(patch.providers);
      if (!valid.success)
        return c.json(
          { error: "Invalid provider settings: check provider IDs, model names and commands" },
          400,
        );
    }
    await driver.patchDaemonConfig(removeProviders ? { ...patch, removeProviders } : patch);
    const saved = projectSettings((await driver.getDaemonConfig()).config);
    const lingering = removeProviders?.find((id) => saved.providers?.[id] !== undefined);
    if (lingering)
      return c.json(
        { error: `The host did not remove ${lingering}. Some other changes may have applied; reload before retrying.` },
        409,
      );
    for (const [key, value] of Object.entries(patch)) {
      // Object patches merge, but every submitted field must survive the round trip.
      if (!retained(value, saved[key]))
        return c.json(
          {
            error: `The host did not retain ${key}. Some other changes may have applied; reload before retrying.`,
          },
          409,
        );
    }
    return c.json({ config: saved, revision: revision(saved), features: features ?? {} });
  });
  /** Every provider the host knows (also disabled and unavailable ones), with catalogue freshness. */
  app.get("/api/hosts/:host/settings/providers", async (c) => {
    const snapshot = await hosts.get(c.req.param("host")).api.providers.snapshot();
    return c.json(snapshot.entries.map(projectProviderEntry));
  });
  /**
   * Re-fetches model catalogues. The daemon caches them until asked, so a model released after
   * it started stays hidden until this runs. It resolves once the daemon has finished fetching.
   */
  const refreshing = new Map<string, Promise<unknown>>();
  app.post("/api/hosts/:host/settings/providers/refresh", async (c) => {
    const hostId = c.req.param("host");
    const input = z
      .object({ providers: z.array(z.string().min(1).max(200)).min(1).max(50).optional() })
      .strict()
      .parse(await c.req.json().catch(() => ({})));
    const { api } = hosts.get(hostId);
    const key = hostId + "|" + (input.providers ? [...input.providers].sort().join(",") : "*");
    let pending = refreshing.get(key);
    if (!pending) {
      pending = api.providers
        .refresh(input.providers ? { providers: input.providers as never } : {})
        .finally(() => refreshing.delete(key));
      refreshing.set(key, pending);
    }
    await pending;
    const snapshot = await api.providers.snapshot();
    return c.json(snapshot.entries.map(projectProviderEntry));
  });
  app.get("/api/hosts/:host/provider-diagnostic/:provider", async (c) => {
    return c.json(
      await hosts.get(c.req.param("host")).driver.getProviderDiagnostic(c.req.param("provider")),
    );
  });
  app.get("/api/hosts/:host/skills", async (c) =>
    c.json(await hosts.get(c.req.param("host")).driver.getAgentSkillsStatus()),
  );
  app.put("/api/hosts/:host/skills", async (c) => {
    const input = z
      .object({
        selection: AgentSkillSelectionSchema,
        confirmedRemovals: z.array(z.string()).optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await hosts
        .get(c.req.param("host"))
        .driver.saveAgentSkillsSelection(input.selection, input.confirmedRemovals),
    );
  });

  app.get("/api/hosts/:host/plugins", async (c) => {
    const plugins = await hosts.get(c.req.param("host")).driver.listPlugins();
    return c.json(
      plugins.map(({ id, name, enabled, status, description, error }) => ({
        id,
        name,
        enabled,
        status,
        description,
        error,
      })),
    );
  });
  app.post("/api/hosts/:host/plugins/:plugin/:action", async (c) => {
    const driver = hosts.get(c.req.param("host")).driver,
      id = c.req.param("plugin");
    if (!driver.getLastServerInfoMessage()?.features?.pluginManagement)
      return c.json({ error: "Plugin management is unavailable on this host" }, 409);
    const action = z.enum(["enable", "disable", "reload", "remove"]).parse(c.req.param("action"));
    if (action === "enable") await driver.enablePlugin(id);
    if (action === "disable") await driver.disablePlugin(id);
    if (action === "reload") await driver.reloadPlugin(id);
    if (action === "remove") await driver.removePlugin(id);
    return c.json({ ok: true });
  });
  app.post("/api/hosts/:host/plugins", async (c) => {
    const driver = hosts.get(c.req.param("host")).driver;
    if (!driver.getLastServerInfoMessage()?.features?.pluginSourceInstallation)
      return c.json({ error: "Plugin installation is unavailable on this host" }, 409);
    const input = z
      .object({ source: z.string().trim().min(1).max(4096) })
      .strict()
      .parse(await c.req.json());
    await driver.installPluginSource(input);
    return c.json({ ok: true });
  });
  app.get("/api/hosts/:host/status", async (c) =>
    c.json(await hosts.get(c.req.param("host")).driver.getDaemonStatus()),
  );
  app.get("/api/hosts/:host/lifecycle", (c) => c.json(jobs.get(c.req.param("host")) ?? null));
  app.post("/api/hosts/:host/lifecycle/:action", async (c) => {
    const host = c.req.param("host"),
      driver = hosts.get(host).driver;
    const action = z.enum(["restart", "update"]).parse(c.req.param("action"));
    const info = driver.getLastServerInfoMessage();
    if (!info?.features?.daemonStatusRpc)
      return c.json(
        { error: "This host cannot verify daemon restarts. Update it manually first." },
        409,
      );
    if (driver.getConnectionState().status !== "connected")
      return c.json({ error: "Host is not connected" }, 409);
    if (action === "update" && (info.desktopManaged || !info.features.daemonSelfUpdate))
      return c.json(
        {
          error: info.desktopManaged
            ? "Update this host through Paseo Desktop."
            : "Self-update is unavailable for this installation.",
        },
        409,
      );
    const existing = jobs.get(host);
    if (existing?.state === "running") return c.json(existing, 202);
    const job: LifecycleJob = { action, state: "running", phase: "Starting" };
    jobs.set(host, job);
    void runLifecycle(hosts, host, job);
    return c.json(job, 202);
  });
}
