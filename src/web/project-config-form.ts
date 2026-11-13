/**
 * paseo.json <-> the project settings form. Follows Paseo's own form (packages/app
 * project-config-form, Apache-2.0): the form edits worktree setup/teardown, scripts and metadata
 * prompts, and every other field in the file — known or not — survives a save unchanged.
 */

type Json = Record<string, unknown>;
/** How a command was written, so an edit keeps the file's style (a string stays a string). */
export type CommandKind = "string" | "array" | "missing";

export const METADATA_PROMPT_KEYS = ["branchName", "commitMessage", "pullRequest"] as const;
export type MetadataPromptKey = (typeof METADATA_PROMPT_KEYS)[number];

export interface ScriptDraft {
  id: string;
  name: string;
  commandText: string;
  commandKind: CommandKind;
  type: string;
  portText: string;
  /** The entry as read, so fields the form does not show are written back. */
  raw: Json;
}

export interface ConfigDraft {
  setupText: string;
  setupKind: CommandKind;
  teardownText: string;
  teardownKind: CommandKind;
  scripts: ScriptDraft[];
  prompts: Record<MetadataPromptKey, string>;
  metadataBase: Json | undefined;
}

export const SERVICE_TYPE = "service";

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

function readCommand(value: unknown): { text: string; kind: CommandKind } {
  if (typeof value === "string") return { text: value, kind: "string" };
  if (Array.isArray(value)) return { text: value.filter((v) => typeof v === "string").join("\n"), kind: "array" };
  return { text: "", kind: "missing" };
}

/** One command per non-empty line; a new field with one line is written as a plain string. */
function writeCommand(text: string, kind: CommandKind): string | string[] | undefined {
  const lines = text.split("\n").filter((line) => line.trim());
  if (!lines.length) return undefined;
  if (kind === "string") return lines.join("\n");
  if (kind === "array") return lines;
  return lines.length === 1 ? lines[0] : lines;
}

function readPort(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value : "";
}
function writePort(text: string): number | string | undefined {
  const value = text.trim();
  if (!value) return undefined;
  return /^[0-9]+$/.test(value) ? Number(value) : value;
}

let nextId = 0;
export const scriptId = () => `script-${++nextId}`;

export function configToDraft(config: Json | null | undefined): ConfigDraft {
  const worktree = isObject(config?.worktree) ? config.worktree : {};
  const setup = readCommand(worktree.setup);
  const teardown = readCommand(worktree.teardown);
  const scripts: ScriptDraft[] = Object.entries(isObject(config?.scripts) ? config.scripts : {}).map(([name, value]) => {
    const raw = isObject(value) ? value : {};
    const command = readCommand(raw.command);
    return {
      id: scriptId(),
      name,
      commandText: command.text,
      commandKind: command.kind,
      type: typeof raw.type === "string" ? raw.type : "",
      portText: readPort(raw.port),
      raw,
    };
  });
  const metadataBase = isObject(config?.metadataGeneration) ? config.metadataGeneration : undefined;
  const prompts = { branchName: "", commitMessage: "", pullRequest: "" };
  for (const key of METADATA_PROMPT_KEYS) {
    const entry = metadataBase?.[key];
    if (isObject(entry) && typeof entry.instructions === "string") prompts[key] = entry.instructions;
  }
  return {
    setupText: setup.text,
    setupKind: setup.kind,
    teardownText: teardown.text,
    teardownKind: teardown.kind,
    scripts,
    prompts,
    metadataBase,
  };
}

const assign = (target: Json, key: string, value: unknown) => {
  if (value === undefined) delete target[key];
  else target[key] = value;
};

export function draftToConfig(draft: ConfigDraft, base: Json | null | undefined): Json {
  const config: Json = { ...(base ?? {}) };

  const worktree: Json = { ...(isObject(config.worktree) ? config.worktree : {}) };
  assign(worktree, "setup", writeCommand(draft.setupText, draft.setupKind));
  assign(worktree, "teardown", writeCommand(draft.teardownText, draft.teardownKind));

  const scripts: Json = {};
  for (const script of draft.scripts) {
    const name = script.name.trim();
    if (!name) continue;
    const entry: Json = { ...script.raw };
    assign(entry, "command", writeCommand(script.commandText, script.commandKind));
    assign(entry, "type", script.type.trim() || undefined);
    assign(entry, "port", writePort(script.portText));
    scripts[name] = entry;
  }

  const metadata: Json = { ...(draft.metadataBase ?? {}) };
  for (const key of METADATA_PROMPT_KEYS) {
    const text = draft.prompts[key];
    const entry: Json = { ...(isObject(draft.metadataBase?.[key]) ? (draft.metadataBase[key] as Json) : {}) };
    if (text.trim()) entry.instructions = text;
    else delete entry.instructions;
    assign(metadata, key, Object.keys(entry).length ? entry : undefined);
  }

  assign(config, "worktree", Object.keys(worktree).length ? worktree : undefined);
  assign(config, "scripts", Object.keys(scripts).length ? scripts : undefined);
  assign(config, "metadataGeneration", Object.keys(metadata).length ? metadata : undefined);
  return config;
}

export function scriptProblems(script: ScriptDraft) {
  return {
    name: script.name.trim() ? "" : "Name is required",
    command: script.commandText.trim() ? "" : "Command is required",
  };
}
export const scriptIsValid = (script: ScriptDraft) => {
  const p = scriptProblems(script);
  return !p.name && !p.command;
};
/** "service · port 3000 · npm run dev": the line under a script's name. */
export function scriptHint(script: ScriptDraft) {
  return [script.type, script.portText && `port ${script.portText}`, script.commandText.split("\n")[0]]
    .filter(Boolean)
    .join(" · ");
}
