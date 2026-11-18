/**
 * The host settings form: the daemon's settings projection as an editable draft, and back again
 * as the smallest patch that applies the edits. Pure, so it is tested without a browser.
 *
 * Text areas edit lists as text (one entry per line) so typing a newline is never swallowed;
 * the lists are rebuilt only when the patch is made.
 */

export type Config = Record<string, any>;

export interface AdditionalModelDraft {
  id: string;
  label: string;
  isDefault: boolean;
  /** Fields the form does not edit (description, thinking options) survive untouched. */
  rest: Record<string, unknown>;
}
export interface ProviderDraft {
  enabled?: boolean;
  label?: string;
  extends?: string;
  commandText: string;
  paseoTools?: { enabled?: boolean; disabledTools?: string[] };
  additionalModels: AdditionalModelDraft[];
}
export interface AgentProfileDraft {
  key: string;
  id: string;
  name: string;
  provider: string;
  model: string;
  modeId: string;
  thinkingOptionId: string;
  notes: string;
  rest: Record<string, unknown>;
}
export interface TerminalProfileDraft {
  key: string;
  id: string;
  name: string;
  command: string;
  argsText: string;
  rest: Record<string, unknown>;
}
export interface MetadataProviderDraft {
  key: string;
  provider: string;
  model: string;
  thinkingOptionId: string;
  rest: Record<string, unknown>;
}
export interface Draft {
  /** Simple values edited in place: toggles, prompts, mcp, relay, usage, browser tools. */
  values: Config;
  providers: Record<string, ProviderDraft>;
  removeProviders: string[];
  agentProfiles: AgentProfileDraft[] | null;
  terminalProfiles: TerminalProfileDraft[] | null;
  metadataProviders: MetadataProviderDraft[] | null;
}

export const BASE_PROVIDERS = ["claude", "codex", "copilot", "opencode", "pi", "omp", "acp"];
export const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;
const LIST_KEYS = ["agentProfiles", "terminalProfiles", "metadataGeneration", "providers"];

/** Settings are plain JSON; a JSON copy also unwraps Vue reactive proxies, which structuredClone rejects. */
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
let keys = 0;
const key = () => `k${++keys}`;
/** randomUUID exists only in secure contexts; a plain-http LAN address still needs unique IDs. */
const uuid = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
function omit(value: Record<string, unknown>, fields: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !fields.includes(k)));
}
/** Optional strings travel only when set; the daemon rejects empty IDs. */
function optional(fields: Record<string, string>) {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));
}

export function toDraft(config: Config): Draft {
  const c = clone(config);
  const values = omit(c, LIST_KEYS);
  const providers: Record<string, ProviderDraft> = {};
  for (const [id, p] of Object.entries((c.providers ?? {}) as Record<string, any>))
    providers[id] = {
      ...omit(p, ["command", "additionalModels"]),
      commandText: (p.command ?? []).join("\n"),
      additionalModels: (p.additionalModels ?? []).map((m: any) => ({
        id: m.id ?? "",
        label: m.label ?? "",
        isDefault: m.isDefault === true,
        rest: omit(m, ["id", "label", "isDefault"]),
      })),
    };
  return {
    values,
    providers,
    removeProviders: [],
    agentProfiles: c.agentProfiles
      ? c.agentProfiles.map((p: any) => ({
          key: key(),
          id: p.id,
          name: p.name ?? "",
          provider: p.provider ?? "",
          model: p.model ?? "",
          modeId: p.modeId ?? "",
          thinkingOptionId: p.thinkingOptionId ?? "",
          notes: p.notes ?? "",
          rest: omit(p, ["id", "name", "provider", "model", "modeId", "thinkingOptionId", "notes"]),
        }))
      : null,
    terminalProfiles: c.terminalProfiles
      ? c.terminalProfiles.map((p: any) => ({
          key: key(),
          id: p.id,
          name: p.name ?? "",
          command: p.command ?? "",
          argsText: (p.args ?? []).join("\n"),
          rest: omit(p, ["id", "name", "command", "args"]),
        }))
      : null,
    metadataProviders: c.metadataGeneration
      ? (c.metadataGeneration.providers ?? []).map((p: any) => ({
          key: key(),
          provider: p.provider ?? "",
          model: p.model ?? "",
          thinkingOptionId: p.thinkingOptionId ?? "",
          rest: omit(p, ["provider", "model", "thinkingOptionId"]),
        }))
      : null,
  };
}

/** The settings a draft describes, in the daemon's shape. */
export function fromDraft(draft: Draft): Config {
  const config: Config = clone(draft.values);
  const providers: Config = {};
  for (const [id, p] of Object.entries(draft.providers)) {
    if (draft.removeProviders.includes(id)) continue;
    const { commandText, additionalModels, ...rest } = p;
    const out: Config = { ...clone(rest) };
    if (lines(commandText).length) out.command = lines(commandText);
    if (additionalModels.length)
      out.additionalModels = additionalModels.map((m) => ({
        ...m.rest,
        id: m.id.trim(),
        label: m.label.trim(),
        ...(m.isDefault ? { isDefault: true } : {}),
      }));
    providers[id] = out;
  }
  if (Object.keys(providers).length || Object.keys(draft.providers).length) config.providers = providers;
  if (draft.agentProfiles)
    config.agentProfiles = draft.agentProfiles.map((p) => ({
      ...p.rest,
      id: p.id,
      name: p.name.trim(),
      provider: p.provider.trim(),
      ...optional({ model: p.model, modeId: p.modeId, thinkingOptionId: p.thinkingOptionId }),
      ...(p.notes.trim() ? { notes: p.notes.trim() } : {}),
    }));
  if (draft.terminalProfiles)
    config.terminalProfiles = draft.terminalProfiles.map((p) => ({
      ...p.rest,
      id: p.id,
      name: p.name.trim(),
      command: p.command.trim(),
      ...(lines(p.argsText).length ? { args: lines(p.argsText) } : {}),
    }));
  if (draft.metadataProviders)
    config.metadataGeneration = {
      providers: draft.metadataProviders.map((p) => ({
        ...p.rest,
        provider: p.provider.trim(),
        ...optional({ model: p.model, thinkingOptionId: p.thinkingOptionId }),
      })),
    };
  return config;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const isObject = (v: unknown): v is Config => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The smallest patch from `saved` (the daemon's settings) to the draft. The daemon merges
 * objects and replaces arrays, so providers carry only their changed fields.
 */
export function buildPatch(saved: Config, draft: Draft): Config {
  const base = fromDraft(toDraft(saved));
  const next = fromDraft(draft);
  const patch: Config = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (k === "providers" || next[k] === undefined || same(base[k], next[k])) continue;
    // Objects merge on the daemon: send only what changed, so an untouched field the daemon
    // controls elsewhere (such as relay.enabled under a launch override) is never resent.
    patch[k] = isObject(base[k]) && isObject(next[k])
      ? Object.fromEntries(Object.entries(next[k]).filter(([f, v]) => !same(base[k][f], v)))
      : next[k];
  }
  const providers: Config = {};
  for (const [id, p] of Object.entries((next.providers ?? {}) as Config)) {
    const before = base.providers?.[id] ?? {};
    const changed = Object.fromEntries(Object.entries(p).filter(([k, v]) => !same(before[k], v)));
    if (Object.keys(changed).length) providers[id] = changed;
  }
  if (Object.keys(providers).length) patch.providers = providers;
  if (draft.removeProviders.length) patch.removeProviders = [...draft.removeProviders];
  return patch;
}

/** Why the draft cannot be saved, in words a person can act on. Empty when it can. */
export function problems(saved: Config, draft: Draft): string[] {
  const out: string[] = [];
  draft.agentProfiles?.forEach((p, i) => {
    const name = p.name.trim() || `Agent profile ${i + 1}`;
    if (!p.name.trim()) out.push(`${name} needs a name.`);
    if (!p.provider.trim()) out.push(`${name} needs a provider.`);
  });
  const names = (draft.agentProfiles ?? []).map((p) => p.name.trim().toLowerCase()).filter(Boolean);
  if (new Set(names).size !== names.length) out.push("Agent profile names must be unique.");
  draft.terminalProfiles?.forEach((p, i) => {
    const name = p.name.trim() || `Terminal profile ${i + 1}`;
    if (!p.name.trim()) out.push(`${name} needs a name.`);
    if (!p.command.trim()) out.push(`${name} needs a command.`);
  });
  draft.metadataProviders?.forEach((p, i) => {
    if (!p.provider.trim()) out.push(`Metadata provider ${i + 1} needs a provider.`);
  });
  for (const [id, p] of Object.entries(draft.providers)) {
    if (draft.removeProviders.includes(id)) continue;
    if (p.extends !== undefined && !p.label?.trim()) out.push(`${id} needs a display name.`);
    if (saved.providers?.[id]?.command?.length && !lines(p.commandText).length)
      out.push(`${id}: a command override cannot be cleared from here. Edit the host's config file instead.`);
    const ids = p.additionalModels.map((m) => m.id.trim());
    if (p.additionalModels.some((m) => !m.id.trim() || !m.label.trim()))
      out.push(`${id}: every additional model needs an ID and a label.`);
    else if (new Set(ids).size !== ids.length) out.push(`${id}: additional model IDs must be unique.`);
    if (p.additionalModels.filter((m) => m.isDefault).length > 1)
      out.push(`${id}: only one additional model can be the default.`);
  }
  return out;
}

export function newAgentProfile(provider: string): AgentProfileDraft {
  return { key: key(), id: uuid(), name: "", provider, model: "", modeId: "", thinkingOptionId: "", notes: "", rest: {} };
}
export function newTerminalProfile(): TerminalProfileDraft {
  return { key: key(), id: uuid(), name: "", command: "", argsText: "", rest: {} };
}
export function newMetadataProvider(provider: string): MetadataProviderDraft {
  return { key: key(), provider, model: "", thinkingOptionId: "", rest: {} };
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "unknown";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}
