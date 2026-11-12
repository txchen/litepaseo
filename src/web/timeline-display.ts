/** Pure display helpers for the conversation, modelled on Paseo's own web client. */
import type { InjectionKey, ShallowRef } from "vue";
import type { TimelineRow } from "../shared/wire.ts";

export interface TimelineContext {
  /** "/api/hosts/<host>/agents/<agent>" for the open conversation. */
  base: string;
  cwd: string;
}
export const TIMELINE_CONTEXT: InjectionKey<ShallowRef<TimelineContext>> = Symbol("litepaseo-timeline");

type Item = Record<string, any>;
const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined);

/** "/repo/src/a.ts" under cwd "/repo" → "src/a.ts" (Paseo's stripCwdPrefix). */
export function stripCwd(path: string, cwd?: string) {
  if (!cwd || !path) return path;
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = path.replace(/\\/g, "/");
  if (p.startsWith(base + "/")) return p.slice(base.length + 1);
  return p === base ? "." : path;
}

const humanize = (name: string) => {
  const n = name.trim();
  if (!n || /[:./]/.test(n) || n.includes("__")) return n || "Tool";
  return n.replace(/[._-]+/g, " ").split(" ").filter(Boolean).join(" ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
};

export interface ToolDisplay {
  icon: string;
  /** The verb ("Run", "Read"): the tooltip, and the label for tools an icon cannot name. */
  name: string;
  summary: string;
  kind: string;
  /** Paseo shows shell/file/search rows as icon + subject only; the icon says what it is. */
  showName: boolean;
  /** Right-aligned detail: "137 lines", "+4 −1". */
  meta: string;
}

/** The program a shell line runs, past `cd … &&` and env assignments. */
export function shellProgram(command: string): string {
  const segments = command.split(/&&|\|\||;|\|/).map((p) => p.trim()).filter(Boolean);
  for (const segment of segments) {
    const words = segment.split(/\s+/).filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
    const program = (words[0] ?? "").replace(/^.*\//, "");
    if (program && program !== "cd" && program !== "timeout" && program !== "sudo" && program !== "env") return program;
    if (program === "timeout" || program === "sudo" || program === "env") {
      const next = words.slice(1).find((w) => !/^-|^\d+[smh]?$/.test(w));
      if (next) return next.replace(/^.*\//, "");
    }
  }
  return "";
}
const SHELL_ICONS: [RegExp, string][] = [
  [/^(npm|npx|pnpm|yarn|bun|bunx)$/, "npm"],
  [/^(node|deno|tsx|ts-node|vitest|jest)$/, "js"],
  [/^(rg|grep|egrep|find|fd|ag|ls|tree|locate)$/, "search"],
  [/^git$/, "branch"],
  [/^(curl|wget|http)$/, "globe"],
  [/^(cat|head|tail|less|sed|awk|wc|jq)$/, "terminal"],
];
export const shellIcon = (command: string) => {
  const program = shellProgram(command);
  return SHELL_ICONS.find(([re]) => re.test(program))?.[1] ?? "terminal";
};

/** "/home/me/code/a/b/c/file.ts" → "/home/me/code/…/file.ts" inside a one-line command. */
export function elidePaths(text: string) {
  return text.replace(/(?:~|\/)[^\s'"`]*\/[^\s'"`]*/g, (path) => {
    const parts = path.split("/");
    return parts.length > 5 ? [...parts.slice(0, 4), "…", parts[parts.length - 1] || parts[parts.length - 2] + "/"].join("/") : path;
  });
}

const lineCount = (text: unknown) => {
  const t = typeof text === "string" ? text : "";
  if (!t) return 0;
  return t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
};
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
function diffMeta(diff: string) {
  if (!diff) return "";
  let add = 0, del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  return add || del ? `+${add} −${del}` : "";
}

/** A tool call as one line, as Paseo shows it: an icon that names the action, then the subject. */
export function toolDisplay(item: Item, cwd?: string): ToolDisplay {
  const d = (item.detail ?? {}) as Item;
  const input = (d.type === "unknown" && d.input && typeof d.input === "object" ? d.input : {}) as Item;
  const path = (p: unknown) => stripCwd(String(p ?? ""), cwd);
  const name = String(item.name ?? "");
  const make = (kind: string, icon: string, verb: string, summary: string, showName = false, meta = ""): ToolDisplay =>
    ({ kind, icon, name: verb, summary, showName, meta });
  const shell = (command: string) => make("shell", shellIcon(command), "Run", elidePaths(command.split("\n")[0]));
  switch (d.type) {
    case "shell":
      return shell(String(d.command ?? ""));
    case "read":
      return make("read", "eye", "Read", path(d.filePath));
    case "edit":
      return make("edit", "edit", "Edit", path(d.filePath), false, diffMeta(editDiff(item)));
    case "write":
      return make("write", "edit", "Write", path(d.filePath), false, d.content ? plural(lineCount(d.content), "line") : "");
    case "search":
      return make("search", d.toolName === "web_search" ? "globe" : "search", d.toolName === "web_search" ? "Search web" : "Search", String(d.query ?? ""));
    case "fetch":
      return make("fetch", "globe", "Fetch", String(d.url ?? ""), true);
    case "sub_agent":
      return make("sub_agent", "bot", str(d.subAgentType) ?? "Task", str(d.description) ?? "", true);
    case "worktree_setup":
      return make("worktree", "branch", "Worktree setup", String(d.branchName ?? ""), true);
    case "plain_text":
      return make("plain", "tool", humanize(name), str(d.label) ?? "", true);
    case "plan":
      return make("plan", "list", "Plan", "", true);
  }
  // Providers that report raw input/output: infer the action from the tool name.
  const lower = name.toLowerCase();
  const file = str(input.path) ?? str(input.file_path) ?? str(input.filePath);
  const subject = str(input.command) ?? str(input.cmd) ?? file ?? str(input.pattern) ?? str(input.query) ?? str(input.url) ?? str(input.description) ?? "";
  if (/^(bash|shell|exec|run|terminal)/.test(lower)) return shell(subject);
  if (/^(read|view|cat)/.test(lower)) return make("read", "eye", "Read", path(subject));
  if (/^(edit|patch|apply|multiedit|str_replace)/.test(lower)) return make("edit", "edit", "Edit", path(subject), false, diffMeta(editDiff(item)));
  if (/^write/.test(lower)) return make("write", "edit", "Write", path(subject), false, input.content ? plural(lineCount(input.content), "line") : "");
  if (/(grep|glob|find|search|ls)$/.test(lower)) return make("search", "search", "Search", subject);
  if (/fetch|browse|http/.test(lower)) return make("fetch", "globe", "Fetch", subject, true);
  if (lower === "thinking") return make("plain", "bulb", "Thinking", "", true);
  if (lower === "task" || lower === "subagent" || lower === "subagents") return make("sub_agent", "bot", "Task", subject, true);
  return make("unknown", "tool", humanize(name), subject, true);
}

/** The first line of a reasoning block, without Markdown emphasis: Paseo's thinking header. */
export function reasoningHeadline(text: string) {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.replace(/^#+\s*/, "").replace(/\*\*|__|`/g, "").slice(0, 300);
}

/** Text output of a tool, when the provider reported any. */
export function toolOutput(item: Item): string {
  const d = (item.detail ?? {}) as Item;
  if (d.type === "shell") return String(d.output ?? "");
  if (d.type === "read" || d.type === "write") return String(d.content ?? "");
  if (d.type === "search") return String(d.content ?? (d.filePaths ?? []).join("\n"));
  if (d.type === "fetch") return String(d.result ?? "");
  if (d.type === "sub_agent") return String(d.log ?? "");
  if (d.type === "plain_text" || d.type === "plan") return String(d.text ?? "");
  if (d.type === "worktree_setup") return String(d.log ?? "");
  if (d.type === "unknown") {
    const out = d.output as Item | string | undefined;
    if (typeof out === "string") return out;
    const parts = Array.isArray(out?.content) ? (out!.content as Item[]).filter((c) => c.type === "text").map((c) => String(c.text)) : [];
    if (parts.length) return parts.join("\n");
    return out === undefined || out === null ? "" : JSON.stringify(out, null, 2);
  }
  return "";
}

/** A unified diff for an edit: the provider's own, or one built from old/new strings. */
export function editDiff(item: Item): string {
  const d = (item.detail ?? {}) as Item;
  const lines = (text: unknown, mark: string) =>
    String(text ?? "").split("\n").filter((_, i, a) => i < a.length - 1 || a[i] !== "").map((l) => mark + l);
  const pair = (oldText: unknown, newText: unknown) => [...lines(oldText, "-"), ...lines(newText, "+")];
  if (d.type === "edit") {
    if (str(d.unifiedDiff)) return d.unifiedDiff;
    if (d.oldString === undefined && d.newString === undefined) return "";
    return pair(d.oldString, d.newString).join("\n");
  }
  // Raw provider input: { oldText, newText } or { edits: [{ oldText, newText }] }.
  const input = d.type === "unknown" && d.input && typeof d.input === "object" ? (d.input as Item) : null;
  if (!input) return "";
  const edits: Item[] = Array.isArray(input.edits) ? input.edits : [input];
  const out: string[] = [];
  for (const e of edits) {
    const oldText = e.oldText ?? e.old_string ?? e.oldString, newText = e.newText ?? e.new_string ?? e.newString;
    if (oldText === undefined && newText === undefined) continue;
    if (out.length) out.push("@@");
    out.push(...pair(oldText, newText));
  }
  return out.join("\n");
}

/** "42s", "11m 40s", "1h 5m" — Paseo's formatDuration. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = ms / 1000;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rest = Math.floor(s) % 60;
    return rest ? `${m}m ${rest}s` : `${m}m`;
  }
  const h = Math.floor(m / 60),
    rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

const timeOfDay = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dayIndex = (d: Date) => Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / 86_400_000);
/** Today: "23:23"; this week: "Tuesday 23:23"; older: "12 Nov 2026, 23:23". */
export function formatMessageTimestamp(at: Date, now = new Date()): string {
  const t = timeOfDay(at);
  const days = dayIndex(now) - dayIndex(at);
  if (days <= 0) return t;
  if (days < 7) return `${at.toLocaleDateString(undefined, { weekday: "long" })} ${t}`;
  return `${at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}, ${t}`;
}

/** Sidebar age: "now", "5m", "3h", "2d", "4w", "Mar 3". */
export function relativeAge(at: number, now = Date.now()): string {
  if (!at) return "";
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 35) return `${Math.floor(s / 86400 / 7)}w`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface TurnFooter {
  /** Completion time label. */
  at: string;
  /** "11m 40s", or "" when the turn's start is outside the loaded rows. */
  took: string;
  /** seqStarts of the turn's assistant messages, for "Copy turn". */
  messages: number[];
}

/**
 * Footers for finished turns, keyed by the seqStart of each turn's last row. A turn is the run of
 * rows sharing a turnId; it is finished once a later turn exists or the agent is idle. Its
 * duration runs from its user message to its last row. O(rows), once per membership/row change.
 */
export function turnFooters(rows: TimelineRow[], lastFinished: boolean, now = new Date()): Map<number, TurnFooter> {
  const out = new Map<number, TurnFooter>();
  let current: { id: string; first: TimelineRow; last: TimelineRow; messages: number[] } | null = null;
  const close = (finished: boolean) => {
    if (!current || !finished) return;
    const end = Date.parse(current.last.timestamp);
    if (!Number.isFinite(end)) return;
    const start = current.first.item.type === "user_message" ? Date.parse(current.first.timestamp) : NaN;
    out.set(current.last.seqStart, {
      at: formatMessageTimestamp(new Date(end), now),
      took: Number.isFinite(start) && end >= start ? formatDuration(end - start) : "",
      messages: current.messages,
    });
  };
  for (const row of rows) {
    if (!row.turnId) continue; // plugin rows and other out-of-turn entries
    if (current && current.id !== row.turnId) {
      close(true);
      current = null;
    }
    current ??= { id: row.turnId, first: row, last: row, messages: [] };
    current.last = row;
    if (row.item.type === "assistant_message") current.messages.push(row.seqStart);
  }
  close(lastFinished);
  return out;
}

/** Image sources an agent can reference: file:// URLs, absolute paths and workspace paths. */
const IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(\s+"[^"]*")?\s*\)/g;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
/**
 * Rewrites local image references in Markdown to this server's image endpoint, which reads
 * them through the host. Remote (http/https/data) sources are left untouched; the CSP still
 * decides whether they load.
 */
export function rewriteImageSources(markdown: string, base: string): string {
  if (!markdown.includes("![")) return markdown;
  return markdown.replace(IMAGE, (match, alt: string, src: string, title = "") => {
    if (/^(https?:|data:|blob:)/i.test(src)) return match;
    let path = src;
    if (/^file:\/\//i.test(path)) {
      try {
        path = decodeURIComponent(new URL(path).pathname);
      } catch {
        return match;
      }
    }
    if (!IMAGE_EXT.test(path)) return match;
    return `![${alt}](${base}/image?path=${encodeURIComponent(path)}${title})`;
  });
}
