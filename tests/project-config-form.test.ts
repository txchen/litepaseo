import test from "node:test";
import assert from "node:assert/strict";
import { configToDraft, draftToConfig, scriptHint, scriptIsValid } from "../src/web/project-config-form.ts";

test("an empty or missing paseo.json gives an empty form and saves as an empty object", () => {
  const draft = configToDraft(null);
  assert.equal(draft.setupText, "");
  assert.deepEqual(draft.scripts, []);
  assert.deepEqual(draft.prompts, { branchName: "", commitMessage: "", pullRequest: "" });
  assert.deepEqual(draftToConfig(draft, null), {});
});

test("commands keep how the file wrote them: a string stays a string, a list stays a list", () => {
  const draft = configToDraft({ worktree: { setup: "npm ci", teardown: ["a", "b"] } });
  assert.equal(draft.setupText, "npm ci");
  assert.equal(draft.teardownText, "a\nb");
  draft.setupText = "npm ci\nnpm run build";
  draft.teardownText = "a\n\n  \nc";
  assert.deepEqual(draftToConfig(draft, { worktree: { setup: "npm ci", teardown: ["a", "b"] } }).worktree, {
    setup: "npm ci\nnpm run build",
    teardown: ["a", "c"],
  });
});

test("a new command field is a string for one line, a list for several, omitted when empty", () => {
  const draft = configToDraft({});
  draft.setupText = "npm ci";
  assert.deepEqual(draftToConfig(draft, {}), { worktree: { setup: "npm ci" } });
  draft.setupText = "npm ci\nmake";
  assert.deepEqual(draftToConfig(draft, {}), { worktree: { setup: ["npm ci", "make"] } });
  draft.setupText = " \n";
  assert.deepEqual(draftToConfig(draft, {}), {});
});

test("fields the form does not show survive a save, at every level", () => {
  const base = {
    version: 2,
    worktree: { setup: "npm ci", terminals: [{ name: "x" }], servicePorts: { range: "3000-3100" } },
    scripts: { dev: { type: "service", command: "npm run dev", port: 3000, env: { A: "1" } } },
    metadataGeneration: { title: { instructions: "legacy" }, branchName: { instructions: "feat/", model: "m" } },
  };
  const draft = configToDraft(base);
  assert.deepEqual(draftToConfig(draft, base), base, "an untouched form saves the file unchanged");
  draft.prompts.branchName = "";
  draft.scripts[0].commandText = "vite";
  assert.deepEqual(draftToConfig(draft, base), {
    ...base,
    scripts: { dev: { type: "service", command: "vite", port: 3000, env: { A: "1" } } },
    metadataGeneration: { title: { instructions: "legacy" }, branchName: { model: "m" } },
  });
});

test("scripts: renames, removals, numeric ports, and unnamed rows are dropped", () => {
  const base = { scripts: { dev: { command: ["a", "b"] }, test: { command: "npm test" } } };
  const draft = configToDraft(base);
  assert.equal(scriptHint(draft.scripts[0]), "a");
  draft.scripts[0].name = "web";
  draft.scripts[0].type = "service";
  draft.scripts[0].portText = "5173";
  draft.scripts = draft.scripts.filter((s) => s.name !== "test");
  draft.scripts.push({ id: "n", name: " ", commandText: "x", commandKind: "missing", type: "", portText: "auto", raw: {} });
  assert.deepEqual(draftToConfig(draft, base).scripts, { web: { command: ["a", "b"], type: "service", port: 5173 } });
  assert.equal(scriptHint(draft.scripts[0]), "service · port 5173 · a");
  assert.equal(scriptIsValid(draft.scripts[1]), false);
});

test("metadata prompts: written only when filled; the group goes away when all are empty", () => {
  const draft = configToDraft({});
  draft.prompts.commitMessage = "Conventional Commits";
  assert.deepEqual(draftToConfig(draft, {}), { metadataGeneration: { commitMessage: { instructions: "Conventional Commits" } } });
  draft.prompts.commitMessage = "  ";
  assert.deepEqual(draftToConfig(draft, {}), {});
});
