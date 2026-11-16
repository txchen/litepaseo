import test from "node:test";
import assert from "node:assert/strict";
import {
  editDiff,
  formatDuration,
  formatMessageTimestamp,
  localLinkPath,
  localLinkTarget,
  parseFileLink,
  relativeAge,
  rewriteFileImages,
  rewriteFileLinks,
  rewriteImageSources,
  rewriteMessageImages,
  toolDisplay,
  toolOutput,
  turnFooters,
} from "../src/web/timeline-display.ts";
import { renderMarkdown } from "../src/web/markdown.ts";
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

test("local link destinations resolve to absolute paths; web links and anchors are not files", () => {
  const cwd = "/repo/app";
  assert.equal(localLinkPath("/repo/app/src/a.ts:42", cwd), "/repo/app/src/a.ts");
  assert.equal(localLinkPath("/repo/app/src/a.ts:42:7", cwd), "/repo/app/src/a.ts");
  assert.equal(localLinkPath("docs/x.md#setup", cwd), "/repo/app/docs/x.md");
  assert.equal(localLinkPath("src/a.ts#L12", cwd), "/repo/app/src/a.ts");
  assert.equal(localLinkPath("../lib/b.md", cwd), "/repo/lib/b.md");
  assert.equal(localLinkPath("./My%20Notes.md", cwd), "/repo/app/My Notes.md");
  assert.equal(localLinkPath("<docs/a b.md>", cwd), "/repo/app/docs/a b.md");
  assert.equal(localLinkPath("file:///repo/app/README.md", cwd), "/repo/app/README.md");
  assert.equal(localLinkPath("docs/", cwd), "/repo/app/docs/");
  // The line a link points at, in each form agents write it.
  assert.deepEqual(localLinkTarget("/repo/app/src/a.ts:42", cwd), { path: "/repo/app/src/a.ts", line: 42 });
  assert.deepEqual(localLinkTarget("src/a.ts:42:7", cwd), { path: "/repo/app/src/a.ts", line: 42 });
  assert.deepEqual(localLinkTarget("src/a.ts:42-50", cwd), { path: "/repo/app/src/a.ts", line: 42, end: 50 });
  assert.deepEqual(localLinkTarget("src/a.ts#L12", cwd), { path: "/repo/app/src/a.ts", line: 12 });
  assert.deepEqual(localLinkTarget("src/a.ts#L12C4-L20C1", cwd), { path: "/repo/app/src/a.ts", line: 12, end: 20 });
  assert.deepEqual(localLinkTarget("src/a.ts#L9-12", cwd), { path: "/repo/app/src/a.ts", line: 9, end: 12 });
  assert.deepEqual(localLinkTarget("docs/x.md#setup", cwd), { path: "/repo/app/docs/x.md" });
  assert.deepEqual(localLinkTarget("src/a.ts:0", cwd), { path: "/repo/app/src/a.ts" });
  for (const href of ["https://x.y/a.md", "mailto:a@b.c", "#top", "//cdn.x/a.js", "/api/hosts/h/agents/a/image?path=x.png", "vscode://file/a"])
    assert.equal(localLinkPath(href, cwd), null, href);
});

test("file links in messages open workspace files in a tab or copy paths the workspace cannot serve", () => {
  const ctx = { session: "h:a1", cwd: "/home/me/dev_portal", workspace: "/home/me/dev_portal" };
  const open = rewriteFileLinks("[查看完整发现报告](/home/me/dev_portal/.local/d/FINDINGS.md)。", ctx);
  assert.equal(open, `[查看完整发现报告](/?session=h%3Aa1&file=.local%2Fd%2FFINDINGS.md ".local/d/FINDINGS.md")。`);
  assert.deepEqual(parseFileLink("/?session=h%3Aa1&file=.local%2Fd%2FFINDINGS.md"), { kind: "open", session: "h:a1", path: ".local/d/FINDINGS.md" });
  assert.equal(rewriteFileLinks("[a](src/a.ts:3) and [b](README.md)", ctx),
    `[a](/?session=h%3Aa1&file=src%2Fa.ts&line=3 "src/a.ts:3") and [b](/?session=h%3Aa1&file=README.md "README.md")`);
  assert.deepEqual(parseFileLink("/?session=h%3Aa1&file=src%2Fa.ts&line=3-9"), { kind: "open", session: "h:a1", path: "src/a.ts", line: 3, end: 9 });
  assert.deepEqual(parseFileLink("/?session=h%3Aa1&file=a.ts&line=0"), { kind: "open", session: "h:a1", path: "a.ts" });

  const outside = rewriteFileLinks("see [spec](/tmp/paseo-src/SPEC.md)", ctx);
  const href = /\]\((\S+)/.exec(outside)![1];
  assert.deepEqual(parseFileLink(href), { kind: "copy", path: "/tmp/paseo-src/SPEC.md" });
  assert.deepEqual(parseFileLink(/\]\((\S+)/.exec(rewriteFileLinks("[d](docs/)", ctx))![1]), { kind: "reveal", session: "h:a1", path: "docs" });
  assert.deepEqual(parseFileLink(/\]\((\S+)/.exec(rewriteFileLinks("[root](/home/me/dev_portal/)", ctx))![1]), { kind: "reveal", session: "h:a1", path: "." });
  assert.equal(parseFileLink(/\]\((\S+)/.exec(rewriteFileLinks("[d](/opt/elsewhere/)", ctx))![1])?.kind, "copy");
  assert.equal(parseFileLink(/\]\((\S+)/.exec(rewriteFileLinks("[s](/home/me/dev_portal_old/a.md)", ctx))![1])?.kind, "copy");

  // Web links, images, code and escaped brackets stay as written.
  for (const text of [
    "[site](https://example.com/a.md)",
    "![shot](/api/hosts/h/agents/a/image?path=x.png)",
    "`[x](docs/a.md)`",
    "```md\n[x](docs/a.md)\n```",
    "\\[x](docs/a.md)",
  ]) assert.equal(rewriteFileLinks(text, ctx), text);
  assert.equal(parseFileLink("https://example.com/?session=x&file=y"), null);
});

test("the fallback renderer keeps rewritten file links in the page", () => {
  const ctx = { session: "h:a1", cwd: "/repo", workspace: "/repo" };
  const html = renderMarkdown(rewriteFileLinks("[a](/repo/a.md) [b](/etc/hosts)", ctx));
  assert.match(html, /<a href="\/\?session=h%3Aa1&amp;file=a\.md" title="a\.md">a<\/a>/);
  assert.match(html, /<a href="#litepaseo-copy-path=%2Fetc%2Fhosts" title="Can&#39;t be opened here: click to copy the path">b<\/a>/);
  assert.doesNotMatch(html, /target="_blank"[^>]*>a</);
});

test("images in a Markdown file tab load from the workspace relative to that file", () => {
  const ctx = { session: "h:a1", cwd: "/repo/docs", workspace: "/repo", rawBase: "/api/hosts/h/fs" };
  const out = rewriteFileImages("![arch](img/arch.png) ![logo](../logo.svg) ![x](/tmp/x.png) ![w](https://x.y/a.png) `![c](c.png)`", ctx);
  assert.equal(out.split(" ")[0], "![arch](/api/hosts/h/fs/raw?cwd=%2Frepo&path=docs%2Fimg%2Farch.png)");
  assert.match(out, /\[logo\]\(\/\?session=h%3Aa1&file=logo\.svg "logo\.svg"\)/);
  assert.match(out, /\[x\]\(#litepaseo-copy-path=%2Ftmp%2Fx\.png /);
  assert.match(out, /!\[w\]\(https:\/\/x\.y\/a\.png\) `!\[c\]\(c\.png\)`$/);
  // Links produced for images are not rewritten again.
  assert.equal(rewriteFileLinks(out, ctx), out);
});

test("images in agent messages show when the host can serve them, otherwise open or copy", () => {
  const base = "/api/hosts/h/agents/a";
  const ctx = { session: "h:a1", cwd: "/repo/app", workspace: "/repo" };
  const hash = "a".repeat(64);
  const out = (src: string) => rewriteMessageImages(`![i](${src})`, base, ctx);
  assert.equal(out(`file:///tmp/paseo-attachments-x/${hash}.png`), `![i](${base}/image?path=${encodeURIComponent(`/tmp/paseo-attachments-x/${hash}.png`)})`);
  assert.equal(out("docs/shot.jpg"), `![i](${base}/image?path=${encodeURIComponent("/repo/app/docs/shot.jpg")})`);
  // In the workspace but outside the agent's cwd: the host's file endpoint.
  assert.equal(out("/repo/shared/a.webp"), "![i](/api/hosts/h/fs/raw?cwd=%2Frepo&path=shared%2Fa.webp)");
  assert.equal(out("diagram.svg"), `[i](/?session=h%3Aa1&file=app%2Fdiagram.svg "app/diagram.svg")`);
  assert.deepEqual(parseFileLink(/\]\((\S+)/.exec(out("/tmp/elsewhere/x.png"))![1]), { kind: "copy", path: "/tmp/elsewhere/x.png" });
  assert.equal(parseFileLink(/\]\((\S+)/.exec(out("/etc/passwd"))![1])?.kind, "copy");
  for (const src of ["https://x.y/a.png", "data:image/png;base64,AA==", "/api/hosts/h/agents/a/image?path=x.png"]) assert.equal(out(src), `![i](${src})`);
  assert.equal(rewriteMessageImages("`![i](x.png)`", base, ctx), "`![i](x.png)`");
});

test("home, Windows and nested-bracket links resolve like any other local link", () => {
  const hrefOf = (markdown: string) => /\]\((\S+)/.exec(markdown)?.[1];
  const ctx = { session: "h:a1", cwd: "/home/me/app", workspace: "/home/me/app" };
  // `~` expands to the home the workspace sits in.
  assert.deepEqual(parseFileLink(hrefOf(rewriteFileLinks("[n](~/app/notes.md:4)", ctx))), { kind: "open", session: "h:a1", path: "notes.md", line: 4 });
  assert.deepEqual(parseFileLink(hrefOf(rewriteFileLinks("[n](~/other/x.md)", ctx))), { kind: "copy", path: "/home/me/other/x.md" });
  assert.deepEqual(parseFileLink(hrefOf(rewriteFileLinks("[n](~/x.md)", { ...ctx, cwd: "/srv/app", workspace: "/srv/app" }))), { kind: "copy", path: "~/x.md" });
  // Windows hosts: drive paths, backslashes, file:///C:/ and relative paths under a drive.
  const win = { session: "h:a1", cwd: "C:\\repo\\app", workspace: "C:\\repo" };
  assert.deepEqual(parseFileLink(hrefOf(rewriteFileLinks("[a](C:\\repo\\src\\a.ts:7)", win))), { kind: "open", session: "h:a1", path: "src/a.ts", line: 7 });
  assert.deepEqual(parseFileLink(hrefOf(rewriteFileLinks("[a](file:///c:/repo/README.md)", win))), { kind: "open", session: "h:a1", path: "README.md" });
  assert.deepEqual(parseFileLink(hrefOf(rewriteFileLinks("[a](../lib/b.md)", win))), { kind: "open", session: "h:a1", path: "lib/b.md" });
  assert.deepEqual(parseFileLink(hrefOf(rewriteFileLinks("[a](D:\\tmp\\x.md)", win))), { kind: "copy", path: "D:/tmp/x.md" });
  // Link text with brackets, and an image inside a link.
  assert.equal(rewriteFileLinks("[see [1]](notes.md)", ctx), `[see [1]](/?session=h%3Aa1&file=notes.md "notes.md")`);
  const linked = rewriteFileLinks("[![logo](https://x.y/l.png)](docs/a.md)", ctx);
  assert.equal(linked, `[![logo](https://x.y/l.png)](/?session=h%3Aa1&file=docs%2Fa.md "docs/a.md")`);
  const both = rewriteFileLinks(rewriteMessageImages("[![logo](img/l.png)](docs/a.md)", "/api/hosts/h/agents/a", ctx), ctx);
  assert.equal(both, `[![logo](/api/hosts/h/agents/a/image?path=%2Fhome%2Fme%2Fapp%2Fimg%2Fl.png)](/?session=h%3Aa1&file=docs%2Fa.md "docs/a.md")`);
});

test("images Paseo saved on a remote daemon's machine are copied, not shown broken", () => {
  const hash = "b".repeat(64);
  const ctx = { session: "h:a1", cwd: "/repo", workspace: "/repo", localHost: false };
  const out = rewriteMessageImages(`![shot](/tmp/paseo-attachments-x/${hash}.png)`, "/api/hosts/h/agents/a", ctx);
  assert.deepEqual(parseFileLink(/\]\((\S+)/.exec(out)![1]), { kind: "copy", path: `/tmp/paseo-attachments-x/${hash}.png` });
  assert.match(rewriteMessageImages(`![shot](/tmp/paseo-attachments-x/${hash}.png)`, "/api/hosts/h/agents/a", { ...ctx, localHost: true }), /^!\[shot\]\(\/api\/hosts\/h\/agents\/a\/image\?path=/);
});
