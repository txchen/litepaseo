import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMANDS, UsageError, colorEnabled, commandHelp, findCommand, formatDuration, formatStatus, lastLines,
  mainHelp, makeStyle, parseArgs, suggest,
} from "../src/server/cli-format.ts";

const plain = makeStyle(false);
const names = COMMANDS.map((c) => c.name);

test("typos and prefixes suggest the intended command", () => {
  assert.equal(suggest("stauts", names), "status");
  assert.equal(suggest("restrat", names), "restart");
  assert.equal(suggest("tok", names), "token");
  assert.equal(suggest("xyzzy", names), undefined);
});

test("arguments are parsed against the command's declared options", () => {
  const logs = findCommand("logs")!;
  assert.deepEqual(parseArgs(logs, ["-n", "20", "-f"]).flags, { lines: "20", follow: true });
  assert.deepEqual(parseArgs(logs, ["--lines=5"]).flags, { lines: "5" });
  assert.equal(parseArgs(logs, ["--help"]).help, true);
  assert.throws(() => parseArgs(logs, ["--json"]), UsageError);
  assert.throws(() => parseArgs(logs, ["-n"]), /needs a value/);
  assert.throws(() => parseArgs(findCommand("backup")!, []), /Missing <directory>/);
  assert.throws(() => parseArgs(findCommand("stop")!, ["now"]), /Unexpected argument 'now'/);
  assert.deepEqual(parseArgs(findCommand("backup")!, ["/tmp/b"]).positional, ["/tmp/b"]);
});

test("help lists every command with its version and data directory", () => {
  const help = mainHelp("9.9.9", "/data", plain);
  assert.match(help, /LitePaseo 9\.9\.9/);
  assert.match(help, /now \/data/);
  for (const name of names) assert.match(help, new RegExp(`\\n  ${name}\\b`));
  assert.match(commandHelp(findCommand("logs")!, plain), /-f, --follow/);
});

test("status reads as a summary and flags a version that needs a restart", () => {
  const now = Date.parse("2026-01-01T03:00:00Z");
  const status = { ready: true, url: "http://127.0.0.1:8787", version: "0.2.0", startedAt: "2026-01-01T01:30:00Z", pid: 10, workerPid: 11, restarts: 0 };
  const text = formatStatus(status, "0.2.0", "/data", plain, now);
  assert.match(text, /^LitePaseo 0\.2\.0 ● running/);
  assert.match(text, /Uptime\s+1h 30m/);
  assert.match(text, /supervisor 10, worker 11/);
  assert.doesNotMatch(text, /restart/);
  assert.match(formatStatus({ ...status, version: undefined }, "0.2.0", "/data", plain, now), /earlier version; 0\.2\.0 is installed/);
  assert.match(formatStatus({ ...status, ready: false, restarts: 2, lastError: "boom" }, "0.2.0", "/data", plain, now), /restarting the worker[\s\S]*Restarts\s+2[\s\S]*boom/);
});

test("durations, log tails and colour choice", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(3 * 86_400_000 + 3_600_000), "3d 1h");
  assert.equal(lastLines("a\nb\nc\n", 2), "b\nc\n");
  assert.equal(lastLines("a\nb", 5), "a\nb");
  assert.equal(lastLines("a\nb\n", 0), "");
  assert.equal(colorEnabled({}, true), true);
  assert.equal(colorEnabled({ NO_COLOR: "1" }, true), false);
  assert.equal(colorEnabled({}, false), false);
  assert.equal(colorEnabled({ FORCE_COLOR: "1" }, false), true);
});
