import test from "node:test";
import assert from "node:assert/strict";
import { ago, buildPatch, fromDraft, newAgentProfile, problems, toDraft } from "../src/web/host-settings-form.ts";

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
