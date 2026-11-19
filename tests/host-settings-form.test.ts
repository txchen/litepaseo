import test from "node:test";
import assert from "node:assert/strict";
import { ago, buildPatch, fromDraft, newAgentProfile, newMetadataProvider, problems, providerRows, restoreMetadataProviders, toDraft } from "../src/web/host-settings-form.ts";

const saved = {
  appendSystemPrompt: "",
  mcp: { enabled: true, injectIntoAgents: true },
  relay: { enabled: false, requireProtectedSecurity: false },
  agentProfiles: [
    { id: "p1", name: "Review", provider: "pi", model: "m", thinkingOptionId: "high", notes: "Look", color: "teal" },
  ],
  terminalProfiles: [{ id: "t1", name: "Shell", command: "/bin/bash", args: ["-l"] }],
  metadataGeneration: { providers: [{ provider: "codex", model: "gpt-6.1-sol" }] },
  providers: {
    claude: { enabled: false },
    mine: { extends: "codex", label: "Mine", enabled: true, command: ["codex", "--x"], additionalModels: [{ id: "a", label: "A", description: "kept" }] },
  },
};

test("an untouched draft is clean; opening a provider leaves no change", () => {
  const draft = toDraft(saved);
  assert.deepEqual(buildPatch(saved, draft), {});
  draft.providers.codex = { commandText: "", additionalModels: [] };
  assert.deepEqual(buildPatch(saved, draft), {});
  assert.deepEqual(problems(saved, draft), []);
});

test("patches are sparse: changed fields only, objects partial, arrays whole", () => {
  const draft = toDraft(saved);
  draft.values.relay.requireProtectedSecurity = true;
  draft.providers.claude!.enabled = true;
  draft.providers.mine!.additionalModels[0]!.label = "Alpha";
  draft.agentProfiles![0]!.model = "";
  assert.deepEqual(buildPatch(saved, draft), {
    relay: { requireProtectedSecurity: true },
    providers: { claude: { enabled: true }, mine: { additionalModels: [{ id: "a", label: "Alpha", description: "kept" }] } },
    agentProfiles: [{ id: "p1", name: "Review", provider: "pi", thinkingOptionId: "high", notes: "Look", color: "teal" }],
  });
});

test("list text areas keep newlines while typing and become lists on save", () => {
  const draft = toDraft(saved);
  draft.terminalProfiles![0]!.argsText = "-l\n";
  assert.deepEqual(buildPatch(saved, draft), {});
  draft.terminalProfiles![0]!.argsText = "-l\n -i \n";
  assert.deepEqual(fromDraft(draft).terminalProfiles[0].args, ["-l", "-i"]);
  assert.deepEqual(buildPatch(saved, draft).terminalProfiles[0].args, ["-l", "-i"]);
});

test("removing a custom provider stages removeProviders, not a provider patch", () => {
  const draft = toDraft(saved);
  draft.removeProviders.push("mine");
  draft.metadataProviders = [];
  const patch = buildPatch(saved, draft);
  assert.deepEqual(patch.removeProviders, ["mine"]);
  assert.equal(patch.providers, undefined);
  assert.deepEqual(patch.metadataGeneration, { providers: [] });
});

test("problems name what blocks a save", () => {
  const draft = toDraft(saved);
  draft.agentProfiles!.push(newAgentProfile(""));
  draft.providers.mine!.commandText = "";
  draft.providers.mine!.additionalModels.push({ id: "", label: "", isDefault: false, rest: {} });
  const found = problems(saved, draft);
  assert.ok(found.some((p) => /needs a name/.test(p)));
  assert.ok(found.some((p) => /needs a provider/.test(p)));
  assert.ok(found.some((p) => /cannot be cleared/.test(p)));
  assert.ok(found.some((p) => /ID and a label/.test(p)));
});

test("ago describes catalogue age", () => {
  const now = Date.parse("2026-11-18T00:00:00Z");
  assert.equal(ago(null, now), "never");
  assert.equal(ago("2026-11-17T23:59:30Z", now), "just now");
  assert.equal(ago("2026-11-17T23:30:00Z", now), "30 min ago");
  assert.equal(ago("2026-11-17T21:00:00Z", now), "3 h ago");
  assert.equal(ago("2026-11-15T00:00:00Z", now), "3 days ago");
});

test("restoring a provider brings back only its metadata entries, keeping other unsaved edits", () => {
  const saved = [
    { ...newMetadataProvider("claude"), model: "opus" },
    { ...newMetadataProvider("mine"), model: "fast" },
    { ...newMetadataProvider("codex"), model: "gpt" },
  ];
  // Removing "mine" dropped its entry; the reader then edited another entry and added one.
  const current = [{ ...saved[0]!, model: "sonnet" }, saved[2]!, newMetadataProvider("pi")];
  const restored = restoreMetadataProviders(current, saved, "mine")!;
  assert.deepEqual(restored.map((p) => `${p.provider}:${p.model}`), ["claude:sonnet", "mine:fast", "codex:gpt", "pi:"]);
  assert.deepEqual(restoreMetadataProviders(restored, saved, "mine"), restored, "restoring twice adds nothing");
  assert.equal(restoreMetadataProviders(null, saved, "mine"), null, "metadata settings stay off when turned off");
  assert.equal(restoreMetadataProviders(current, null, "mine"), current);
});

test("provider rows: reported providers first, then new drafts, with the draft's edits applied", () => {
  const reported = (id: string, enabled: boolean, source: "builtin" | "custom" = "builtin") =>
    ({ id, label: id.toUpperCase(), enabled, source, status: "ready", models: [], modes: [], fetchedAt: null }) as any;
  const draft = toDraft(saved);
  draft.providers.claude.enabled = true;
  draft.removeProviders.push("mine");
  draft.providers.fresh = { extends: "pi", label: " Fresh ", enabled: true, commandText: "", additionalModels: [] };
  const rows = providerRows([reported("claude", false), reported("mine", true, "custom")], draft, saved);
  assert.deepEqual(rows.map((r) => r.id), ["claude", "mine", "fresh"]);
  const [claude, mine, fresh] = rows;
  assert.equal(claude.label, "CLAUDE");
  assert.equal(claude.enabled, true);
  assert.equal(claude.pendingToggle, true);
  assert.equal(claude.custom, false);
  assert.equal(mine.label, "Mine");
  assert.equal(mine.removed, true);
  assert.equal(mine.custom, true);
  assert.equal(fresh.label, "Fresh");
  assert.equal(fresh.reported, undefined);
  assert.equal(fresh.saved, false);
  assert.equal(fresh.pendingToggle, false);
});
