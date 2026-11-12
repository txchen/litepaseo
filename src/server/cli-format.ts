/**
 * Pure parts of the command line: the command table, argument parsing, help text and the
 * human-readable status. Kept free of side effects so tests can check them directly.
 */

export type Flag = { name: string; short?: string; value?: string; summary: string };
export type Command = {
  name: string;
  group: string;
  /** Arguments after the command name, as shown in usage. */
  args?: string;
  summary: string;
  details?: string[];
  flags?: Flag[];
  examples?: string[];
  /** Number of required positional arguments. */
  positional?: number;
};

const json: Flag = { name: "json", summary: "Print machine-readable JSON" };

export const TOKEN_ACTIONS = ["set", "rotate"] as const;
export const CONFIG_ACTIONS = ["set", "unset"] as const;
export const SERVICE_ACTIONS = ["print", "install", "uninstall", "status", "start", "stop", "restart"] as const;

export const COMMANDS: Command[] = [
  {
    name: "start", group: "Service", summary: "Start in the background",
    details: ["Waits up to 10 s until the web console answers, then prints its address.", "Does nothing if LitePaseo is already running."],
    flags: [json],
  },
  { name: "stop", group: "Service", summary: "Stop the background instance", details: ["Waits until the instance has exited."] },
  { name: "restart", group: "Service", summary: "Stop, then start again", details: ["Use after upgrading so the new version serves."], flags: [json] },
  {
    name: "status", group: "Service", summary: "Show state, address and processes",
    details: ["Exit status: 0 running, 3 not running."], flags: [json],
  },
  {
    name: "logs", group: "Service", summary: "Show recent logs",
    flags: [
      { name: "lines", short: "n", value: "<count>", summary: "Number of lines to show (default 100)" },
      { name: "follow", short: "f", summary: "Keep printing new lines until Ctrl-C" },
    ],
    examples: ["litepaseo logs -n 500", "litepaseo logs -f"],
  },
  { name: "serve", group: "Service", summary: "Run in the foreground (for service managers)" },

  {
    name: "token", group: "Sign-in", args: "[set|rotate]", summary: "Print, choose or replace the access token",
    details: [
      "The token is required to sign in from a browser.",
      "",
      "Actions:",
      "  (none)    print the current token",
      "  set       choose your own token: typed twice without echo, or read from standard input",
      "  rotate    replace it with a new random token and print it",
      "",
      `A chosen token needs at least 16 characters (letters, digits, punctuation; no spaces).`,
      "Both actions take effect immediately and sign out every browser.",
    ],
    examples: ["litepaseo token", "litepaseo token set", "litepaseo token rotate"],
  },
  {
    name: "config", group: "Configuration", args: "[set|unset] [key] [value]", summary: "Show or change saved settings",
    details: [
      "Saved settings apply on every start, so environment variables are no longer needed.",
      "An environment variable still overrides its setting for that run.",
      "",
      "Keys:",
      "  port            port the web console listens on (8787)",
      "  bind            address to listen on (127.0.0.1; keep it behind a tunnel)",
      "  push-subject    contact for push services: mailto:you@example.com or an https:// URL",
      "",
      "Changes apply after 'litepaseo restart' (or 'litepaseo service restart').",
    ],
    flags: [json],
    examples: ["litepaseo config", "litepaseo config set push-subject mailto:you@example.com", "litepaseo config unset port"],
  },
  { name: "totp-reset", group: "Sign-in", summary: "Turn off authenticator sign-in (lost phone)" },
  { name: "signout-all", group: "Sign-in", summary: "Sign out every browser and stop its notifications" },

  {
    name: "backup", group: "Data", args: "<directory>", positional: 1, summary: "Back up all data into a new directory",
    details: ["The backup contains credentials: keep it private."], examples: ["litepaseo backup ~/litepaseo-backup"],
  },
  {
    name: "restore", group: "Data", args: "<directory>", positional: 1, summary: "Restore a backup into an empty home",
    examples: ["LITEPASEO_HOME=~/.litepaseo-restored litepaseo restore ~/litepaseo-backup"],
  },

  {
    name: "service", group: "Autostart", args: "<action>", summary: "Manage the systemd / launchd user service",
    details: [
      "Actions:",
      "  print       show the service definition without installing it",
      "  install     install and start it at login",
      "  uninstall   stop and remove it",
      "  status      show the service manager's status",
      "  start | stop | restart",
    ],
    examples: ["litepaseo service install"],
  },

  { name: "version", group: "Other", summary: "Show version details", flags: [json] },
  { name: "help", group: "Other", args: "[command]", summary: "Show help for a command" },
];

export function findCommand(name: string) {
  return COMMANDS.find((c) => c.name === name);
}

/** Edit distance counting a swap of neighbouring letters as one edit, the commonest typo. */
function distance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[a.length]![b.length]!;
}

/** The closest known name, if it is plausibly a typo. */
export function suggest(input: string, names: readonly string[]) {
  let best: string | undefined, score = Infinity;
  for (const name of names) {
    const d = name.startsWith(input) && input.length >= 2 ? 0 : distance(input, name);
    if (d < score) [best, score] = [name, d];
  }
  return score <= Math.max(1, Math.floor((best?.length ?? 0) / 3)) ? best : undefined;
}

export class UsageError extends Error {}

export type Parsed = { positional: string[]; flags: Record<string, string | true>; help: boolean };

/** Parses the arguments after the command name against its declared flags. */
export function parseArgs(command: Command, argv: string[]): Parsed {
  const result: Parsed = { positional: [], flags: {}, help: false };
  const flags = command.flags ?? [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") { result.help = true; continue; }
    if (arg === "--") { result.positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("-") || arg === "-") { result.positional.push(arg); continue; }
    const [raw, inline] = arg.startsWith("--") ? [arg.slice(2).split("=")[0]!, arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined] : [arg.slice(1), undefined];
    const flag = arg.startsWith("--") ? flags.find((f) => f.name === raw) : flags.find((f) => f.short === raw);
    if (!flag) throw new UsageError(`Unknown option ${arg} for '${command.name}'.`);
    if (!flag.value) {
      if (inline !== undefined) throw new UsageError(`Option --${flag.name} takes no value.`);
      result.flags[flag.name] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new UsageError(`Option ${arg} needs a value ${flag.value}.`);
    result.flags[flag.name] = value;
  }
  if (result.help) return result;
  const required = command.positional ?? 0;
  if (result.positional.length < required) throw new UsageError(`Missing ${command.args} for '${command.name}'.`);
  const allowed = command.args ? command.args.split(" ").length : 0;
  if (result.positional.length > allowed) throw new UsageError(`Unexpected argument '${result.positional[allowed]}' for '${command.name}'.`);
  return result;
}

export type Style = { bold: (s: string) => string; dim: (s: string) => string; green: (s: string) => string; red: (s: string) => string; yellow: (s: string) => string; cyan: (s: string) => string };

export function makeStyle(enabled: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), green: wrap(32, 39), red: wrap(31, 39), yellow: wrap(33, 39), cyan: wrap(36, 39) };
}

/** Colour only for a terminal, and never against NO_COLOR; FORCE_COLOR overrides both. */
export function colorEnabled(env: NodeJS.ProcessEnv, isTTY: boolean | undefined) {
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return Boolean(isTTY) && env.TERM !== "dumb";
}

const usageOf = (c: Command) => `litepaseo ${c.name}${c.args ? " " + c.args : ""}${c.flags?.length ? " [options]" : ""}`;

export function mainHelp(version: string, directory: string, s: Style) {
  const lines = [`${s.bold("LitePaseo")} ${version}: a resource-conscious web console for your Paseo agents`, "", `${s.bold("Usage:")} litepaseo <command> [options]`];
  const groups = [...new Set(COMMANDS.map((c) => c.group))];
  const label = (c: Command) => c.name + (c.args ? " " + c.args : "");
  const width = Math.max(22, ...COMMANDS.map((c) => label(c).length + 2));
  for (const group of groups) {
    lines.push("", s.bold(group));
    for (const c of COMMANDS.filter((x) => x.group === group))
      lines.push(`  ${s.cyan(label(c).padEnd(width))}${c.summary}`);
  }
  lines.push(
    "", s.bold("Options"),
    `  ${s.cyan("-h, --help".padEnd(22))}Show help (also after a command)`,
    `  ${s.cyan("-v, --version".padEnd(22))}Print the version`,
    "", `${s.bold("Environment")} ${s.dim("(overrides 'litepaseo config' for one run)")}`,
    `  ${s.cyan("LITEPASEO_HOME".padEnd(24))}Data directory ${s.dim(`(now ${directory})`)}`,
    `  ${s.cyan("LITEPASEO_PORT".padEnd(24))}Port ${s.dim("(8787)")}`,
    `  ${s.cyan("LITEPASEO_BIND".padEnd(24))}Listen address ${s.dim("(127.0.0.1)")}`,
    `  ${s.cyan("LITEPASEO_PUSH_SUBJECT".padEnd(24))}mailto: or https: contact for push services`,
    "", `Run ${s.bold("litepaseo help <command>")} for details on a command.`,
  );
  return lines.join("\n");
}

export function commandHelp(c: Command, s: Style) {
  const lines = [`${s.bold("Usage:")} ${usageOf(c)}`, "", c.summary + "."];
  if (c.details?.length) lines.push("", ...c.details);
  if (c.flags?.length) {
    lines.push("", s.bold("Options"));
    for (const f of c.flags) {
      const label = `${f.short ? `-${f.short}, ` : "    "}--${f.name}${f.value ? " " + f.value : ""}`;
      lines.push(`  ${s.cyan(label.padEnd(24))}${f.summary}`);
    }
  }
  if (c.examples?.length) lines.push("", s.bold("Examples"), ...c.examples.map((e) => "  " + e));
  return lines.join("\n");
}

export type Status = {
  ready: boolean; url: string; pid: number; workerPid: number | null; restarts: number;
  version?: string; startedAt?: string; lastError?: string;
};

export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** A note when the running instance is not the installed version (an upgrade needs a restart). */
export function versionNote(status: Status, installed: string, s: Style) {
  if (status.version === installed) return null;
  const running = status.version ? `version ${status.version}` : "an earlier version";
  return s.yellow(`! The running instance is ${running}; ${installed} is installed. Run 'litepaseo restart' to switch.`);
}

export function formatStatus(status: Status, installed: string, directory: string, s: Style, now = Date.now()) {
  const state = status.ready ? s.green("● running") : status.restarts ? s.yellow("● restarting the worker") : s.yellow("● starting");
  const row = (label: string, value: string) => `  ${s.dim(label.padEnd(11))}${value}`;
  const lines = [`${s.bold("LitePaseo")} ${status.version ?? ""} ${state}`.replace("  ", " ")];
  if (status.url) lines.push(row("Address", s.cyan(status.url)));
  if (status.startedAt) {
    const started = new Date(status.startedAt);
    if (!Number.isNaN(started.getTime())) lines.push(row("Uptime", `${formatDuration(now - started.getTime())} ${s.dim(`(since ${started.toLocaleString()})`)}`));
  }
  lines.push(row("Processes", `supervisor ${status.pid}${status.workerPid ? `, worker ${status.workerPid}` : ", no worker"}`));
  if (status.restarts) lines.push(row("Restarts", String(status.restarts)));
  if (status.lastError) lines.push(row("Last error", s.red(status.lastError)));
  lines.push(row("Data", directory));
  const note = versionNote(status, installed, s);
  if (note) lines.push("", note);
  return lines.join("\n");
}

/** The last `count` lines of a text, keeping a trailing newline out of the count. */
export function lastLines(text: string, count: number) {
  if (count <= 0) return "";
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  let index = body.length;
  for (let i = 0; i < count; i++) {
    index = body.lastIndexOf("\n", index - 1);
    if (index < 0) return text;
  }
  return text.slice(index + 1);
}
