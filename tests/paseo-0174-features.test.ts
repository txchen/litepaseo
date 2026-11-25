import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";
import { rewriteIssueLinks } from "../src/web/timeline-display.ts";

test("rewriteIssueLinks turns cross-repo and local issue/PR references into links while skipping code and URLs", () => {
  assert.equal(
    rewriteIssueLinks("Fixes getpaseo/paseo#10798 and #42."),
    "Fixes [getpaseo/paseo#10798](https://github.com/getpaseo/paseo/issues/10798) and #42.",
  );
  assert.equal(
    rewriteIssueLinks("See #42 and owner/other#9", "https://github.com/txchen/litepaseo"),
    "See [#42](https://github.com/txchen/litepaseo/issues/42) and [owner/other#9](https://github.com/owner/other/issues/9)",
  );
  assert.equal(
    rewriteIssueLinks("GitLab #7", "https://gitlab.example.com/group/app"),
    "GitLab [#7](https://gitlab.example.com/group/app/-/issues/7)",
  );
  // A GitHub repo whose slug contains "gitlab" must still use GitHub's /issues/ path.
  assert.equal(
    rewriteIssueLinks("See gitlabhq/gitlabhq#42"),
    "See [gitlabhq/gitlabhq#42](https://github.com/gitlabhq/gitlabhq/issues/42)",
  );
  // Code blocks, inline code, existing Markdown links, and URL fragments must remain untouched.
  const untouched = [
    "Inline `owner/repo#123` and `#45` stay literal.",
    "Link [already getpaseo/paseo#10](https://example.com/#10) stays literal.",
    "URL https://github.com/a/b#12 stays literal.",
    "```ts\n// owner/repo#99 and #88\n```",
  ].join("\n\n");
  assert.equal(rewriteIssueLinks(untouched, "https://github.com/txchen/litepaseo"), untouched);
});

test("server routes: worktree modes, branches, importable sessions, create-directory, plugin registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "litepaseo-0174-"));
  const store = new Store(dir);
  const hosts = new Hosts();
  const host = store.addHost("Main", "ws://example.invalid/ws");
  const calls: { method: string; args: unknown }[] = [];

  const mockDriver = {
    getConnectionState: () => ({ status: "connected" }),
    subscribeConnectionStatus: () => () => {},
    getLastServerInfoMessage: () => ({
      features: { pluginManagement: true, pluginSourceInstallation: true, pluginRegistry: true },
    }),
    observeAgents: () => ({
      subscribe: () => () => {},
      release: async () => {},
    }),
    getBranchSuggestions: async (opts: unknown) => {
      calls.push({ method: "getBranchSuggestions", args: opts });
      return { branches: ["main", "feat/worktree"], error: null };
    },
    fetchRecentProviderSessions: async (opts: unknown) => {
      calls.push({ method: "fetchRecentProviderSessions", args: opts });
      return {
        entries: [
          {
            providerId: "claude",
            providerLabel: "Claude Code",
            providerHandleId: "sess-1",
            cwd: "/home/dev/repo",
            title: "Refactor parser",
            firstPromptPreview: "Refactor parser",
            lastPromptPreview: "Looks good",
            lastActivityAt: "2026-11-24T10:00:00Z",
          },
        ],
        filteredAlreadyImportedCount: 2,
        providerErrors: [{ provider: "codex", message: "timed out" }],
      };
    },
    importAgent: async (input: unknown) => {
      calls.push({ method: "importAgent", args: input });
      return { id: "agent-imported-1" };
    },
    createProjectDirectory: async (input: unknown) => {
      calls.push({ method: "createProjectDirectory", args: input });
      return { directoryPath: "/home/dev/code/fresh-app", project: { projectId: "p1" }, error: null, errorCode: null };
    },
    listPluginRegistry: async () => ({
      registry: { name: "Paseo Registry", url: "https://plugins.paseo.sh" },
      categories: [{ slug: "workflow", label: "Workflow" }],
      featured: ["paseo/demo"],
      plugins: [
        {
          id: "paseo/demo",
          name: "Demo Plugin",
          description: "A helpful plugin",
          categories: ["workflow"],
          author: { github: "paseo", name: "Paseo Team" },
          repository: { url: "https://github.com/getpaseo/demo" },
          license: "MIT",
          installs: 42,
          updatedAt: "2026-11-20T00:00:00Z",
          artifact: { kind: "npm", version: "1.2.3" },
        },
      ],
    }),
    getRegistryPlugin: async (id: string) => ({
      id,
      name: "Demo Plugin",
      description: "A helpful plugin",
      categories: ["workflow"],
      author: { github: "paseo" },
      repository: { url: "https://github.com/getpaseo/demo" },
      updatedAt: "2026-11-20T00:00:00Z",
      readme: "# Demo\nHello world",
      artifact: { kind: "npm", version: "1.2.3" },
    }),
  };

  const mockApi = {
    providers: {
      snapshot: async () => ({
        entries: [
          {
            provider: "claude",
            enabled: true,
            status: "ready",
            models: [{ id: "claude-opus-4", label: "Opus 4", isDefault: true, isSelectable: true }],
          },
        ],
      }),
    },
    agents: {
      create: async (opts: unknown) => {
        calls.push({ method: "agents.create", args: opts });
        return { id: "agent-wt-1" };
      },
    },
    dispose: async () => {},
  };

  hosts.attach(host.id, mockDriver as never, mockApi as never);

  const app = createApp(store, hosts, "test-token", dir);
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" };

  try {
    // 1. Branch suggestions
    const brRes = await app.request(`/api/hosts/${host.id}/branches?cwd=/home/dev/repo`, { headers });
    assert.equal(brRes.status, 200);
    assert.deepEqual(await brRes.json(), { branches: ["main", "feat/worktree"] });

    // 2. Create session with checkout-branch and checkout-pr worktrees
    const wtBranch = await app.request(`/api/hosts/${host.id}/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        cwd: "/home/dev/repo",
        provider: "claude",
        model: "claude-opus-4",
        prompt: "Review branch",
        worktree: { mode: "checkout-branch", branch: "feat/worktree" },
      }),
    });
    assert.equal(wtBranch.status, 201);
    assert.deepEqual((calls.at(-1)?.args as any)?.worktree, { mode: "checkout-branch", branch: "feat/worktree" });

    const wtPr = await app.request(`/api/hosts/${host.id}/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        cwd: "/home/dev/repo",
        provider: "claude",
        model: "claude-opus-4",
        prompt: "Review PR",
        worktree: { mode: "checkout-pr", prNumber: 123 },
      }),
    });
    assert.equal(wtPr.status, 201);
    assert.deepEqual((calls.at(-1)?.args as any)?.worktree, { mode: "checkout-pr", prNumber: 123 });

    // 3. Importable sessions & import
    const impList = await app.request(`/api/hosts/${host.id}/importable-sessions?q=parser&limit=25`, { headers });
    assert.equal(impList.status, 200);
    const impJson = (await impList.json()) as any;
    assert.equal(impJson.entries.length, 1);
    assert.equal(impJson.entries[0].providerHandleId, "sess-1");
    assert.equal(impJson.providerErrors[0].provider, "codex");

    const impDo = await app.request(`/api/hosts/${host.id}/import-session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: "claude", providerHandleId: "sess-1", cwd: "/home/dev/repo" }),
    });
    assert.equal(impDo.status, 201);
    assert.equal(((await impDo.json()) as any).key, `${host.id}:agent-imported-1`);

    // 4. Create project directory (valid + invalid folder name)
    const badDir = await app.request(`/api/hosts/${host.id}/projects/create-directory`, {
      method: "POST",
      headers,
      body: JSON.stringify({ parentPath: "/home/dev/code", name: "../escape" }),
    });
    assert.equal(badDir.status, 400);

    const okDir = await app.request(`/api/hosts/${host.id}/projects/create-directory`, {
      method: "POST",
      headers,
      body: JSON.stringify({ parentPath: "/home/dev/code", name: "fresh-app" }),
    });
    assert.equal(okDir.status, 200);
    assert.equal(((await okDir.json()) as any).path, "/home/dev/code/fresh-app");

    // 5. Plugin registry index & detail
    const regIdx = await app.request(`/api/hosts/${host.id}/plugin-registry`, { headers });
    assert.equal(regIdx.status, 200);
    const regJson = (await regIdx.json()) as any;
    assert.equal(regJson.plugins[0].id, "paseo/demo");
    assert.equal(regJson.plugins[0].version, "1.2.3");

    const regDetail = await app.request(`/api/hosts/${host.id}/plugin-registry/paseo/demo`, { headers });
    assert.equal(regDetail.status, 200);
    assert.match(((await regDetail.json()) as any).readme, /# Demo/);
  } finally {
    app.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
