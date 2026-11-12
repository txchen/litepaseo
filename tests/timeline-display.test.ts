import test from "node:test";
import assert from "node:assert/strict";
import {
  editDiff,
  formatDuration,
  formatMessageTimestamp,
  relativeAge,
  rewriteImageSources,
  toolDisplay,
  toolOutput,
  turnFooters,
} from "../src/web/timeline-display.ts";
import { isLocalConnection, isMaterializedImagePath } from "../src/server/media.ts";
import type { TimelineRow } from "../src/shared/wire.ts";

test("tool calls read as Paseo's verb + subject, relative to the workspace", () => {
  const cwd = "/repo";
  assert.deepEqual(
    [toolDisplay({ name: "shell", detail: { type: "shell", command: "npm test" } }, cwd).name, toolDisplay({ name: "shell", detail: { type: "shell", command: "npm test" } }, cwd).summary],
    ["Run", "npm test"],
  );
  assert.equal(toolDisplay({ name: "read", detail: { type: "read", filePath: "/repo/src/a.ts" } }, cwd).summary, "src/a.ts");
  // Providers reporting raw input still get a verb.
  const raw = toolDisplay({ name: "read", detail: { type: "unknown", input: { path: "/repo/x.png" }, output: null } }, cwd);
  assert.equal(raw.name, "Read");
  assert.equal(raw.summary, "x.png");
  assert.equal(toolDisplay({ name: "bash", detail: { type: "unknown", input: { command: "ls" } } }).name, "Run");
  assert.equal(toolDisplay({ name: "my_custom-tool", detail: { type: "unknown" } }).name, "My custom tool");
  assert.equal(toolOutput({ detail: { type: "unknown", output: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } } }), "a\nb");
  assert.equal(editDiff({ detail: { type: "edit", filePath: "a", oldString: "x\n", newString: "y\n" } }), "-x\n+y");
});

test("durations and timestamps follow Paseo's formats", () => {
  assert.equal(formatDuration(42_900), "42s");
  assert.equal(formatDuration(700_000), "11m 40s");
  assert.equal(formatDuration(120_000), "2m");
  assert.equal(formatDuration(3_900_000), "1h 5m");
  const now = new Date(2026, 10, 12, 23, 30);
  const today = new Date(2026, 10, 12, 23, 23);
  assert.equal(formatMessageTimestamp(today, now), today.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
  const earlier = new Date(2026, 10, 10, 9, 5);
  assert.ok(formatMessageTimestamp(earlier, now).startsWith(earlier.toLocaleDateString(undefined, { weekday: "long" })));
  assert.equal(relativeAge(Date.now() - 30_000), "now");
  assert.equal(relativeAge(Date.now() - 3 * 3600_000), "3h");
});

const row = (seqStart: number, turnId: string | undefined, type: string, at: string, text = ""): TimelineRow => ({
  seqStart,
  seqEnd: seqStart,
  timestamp: at,
  provider: "pi",
  ...(turnId ? { turnId } : {}),
  item: { type, text },
});

test("finished turns get a footer on their last row with completion time and duration", () => {
  const rows = [
    row(1, "a", "user_message", "2026-11-12T06:58:42Z"),
    row(2, "a", "tool_call", "2026-11-12T06:58:50Z"),
    row(3, "a", "assistant_message", "2026-11-12T06:59:32Z", "done"),
    row(4, undefined, "plugin", "2026-11-12T06:59:35Z"),
    row(5, "b", "user_message", "2026-11-12T07:00:00Z"),
    row(6, "b", "assistant_message", "2026-11-12T07:11:40Z", "ok"),
  ];
  const running = turnFooters(rows, false);
  assert.deepEqual([...running.keys()], [3], "the running turn has no footer yet");
  assert.equal(running.get(3)!.took, "50s");
  assert.deepEqual(running.get(3)!.messages, [3]);
  const idle = turnFooters(rows, true);
  assert.equal(idle.get(6)!.took, "11m 40s");
  // A turn whose start is outside the window shows its time but no duration.
  assert.equal(turnFooters(rows.slice(1), true).get(3)!.took, "");
});

test("local image references point at the host image endpoint; remote ones are untouched", () => {
  const base = "/api/hosts/h/agents/a";
  assert.equal(
    rewriteImageSources("![Image](file:///tmp/paseo-attachments-x/ab.png)", base),
    `![Image](${base}/image?path=${encodeURIComponent("/tmp/paseo-attachments-x/ab.png")})`,
  );
  assert.equal(rewriteImageSources("![s](docs/shot.jpg)", base), `![s](${base}/image?path=docs%2Fshot.jpg)`);
  assert.equal(rewriteImageSources("![r](https://x.y/a.png)", base), "![r](https://x.y/a.png)");
  assert.equal(rewriteImageSources("![f](/etc/passwd)", base), "![f](/etc/passwd)");
});

test("only daemon-materialized images are read from disk, and only for local daemons", () => {
  const hash = "a".repeat(64);
  assert.equal(isMaterializedImagePath(`/tmp/paseo-attachments-QbOIcz/${hash}.png`), true);
  assert.equal(isMaterializedImagePath(`/tmp/paseo-attachments-QbOIcz/../../etc/${hash}.png`), false);
  assert.equal(isMaterializedImagePath(`/tmp/other/${hash}.png`), false);
  assert.equal(isMaterializedImagePath(`/tmp/paseo-attachments-QbOIcz/${hash}.svg`), false);
  assert.equal(isMaterializedImagePath(`/tmp/paseo-attachments-QbOIcz/notahash.png`), false);
  assert.equal(isLocalConnection("6767"), true);
  assert.equal(isLocalConnection("ws://127.0.0.1:6767/ws?password=x"), true);
  assert.equal(isLocalConnection("unix:///tmp/paseo.sock"), true);
  assert.equal(isLocalConnection("tcp://10.0.0.2:6767"), false);
  assert.equal(isLocalConnection("ssh://me@box"), false);
});

test("activity lines pick Paseo-style icons, shorten long paths and show thinking headlines", async () => {
  const { shellIcon, shellProgram, elidePaths, reasoningHeadline } = await import("../src/web/timeline-display.ts");
  assert.equal(shellProgram("cd /repo && npm run check"), "npm");
  assert.equal(shellIcon("cd /repo && npm run check"), "npm");
  assert.equal(shellIcon("cd /repo && node --test x.ts 2>&1 | grep ok"), "js");
  assert.equal(shellIcon("cd /repo && grep -n foo src"), "search");
  assert.equal(shellIcon("FOO=1 timeout 30 git status"), "branch");
  assert.equal(shellIcon("cd /repo && sed -n 1,5p a.ts"), "terminal");
  assert.equal(elidePaths("cd /home/txchen/code/txchen/litepaseo/tests/app.test.ts"), "cd /home/txchen/code/…/app.test.ts");
  assert.equal(elidePaths("ls /tmp/x"), "ls /tmp/x");
  assert.equal(reasoningHeadline("\n**Planning the change**\n\nMore detail here"), "Planning the change");
  const write = toolDisplay({ name: "write", detail: { type: "unknown", input: { path: "/repo/a.ts", content: "a\nb\nc\n" } } }, "/repo");
  assert.deepEqual([write.icon, write.summary, write.meta], ["edit", "a.ts", "3 lines"]);
  const edit = toolDisplay({ name: "edit", detail: { type: "unknown", input: { path: "/repo/a.ts", edits: [{ oldText: "x", newText: "y\nz" }] } } }, "/repo");
  assert.equal(edit.meta, "+2 −1");
});
