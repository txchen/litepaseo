import test from "node:test";
import assert from "node:assert/strict";
import { HostBackgroundWork, type BackgroundWorkDriver } from "../src/server/background-work.ts";
import { UsageService } from "../src/server/usage.ts";
import { projectProviderEntry } from "../src/server/host-settings.ts";
import {
  NextSuggestionCache,
  clearNextSuggestion,
  generateNextSuggestion,
  nextSuggestionSettings,
  parseSuggestionOutput,
  saveNextSuggestion,
  trimSuggestionContext,
} from "../src/server/next-suggestion.ts";
import type { AgentBackgroundWorkItem } from "../src/shared/wire.ts";

const bgItem = (id: string, kind = "shell"): AgentBackgroundWorkItem => ({
  id,
  kind,
  description: `Run ${id}`,
  command: `npm run ${id}`,
  startedAt: "2026-11-23T00:00:00Z",
  canStop: true,
});

test("HostBackgroundWork lists, streams updates, stops items, and disposes cleanly", async () => {
  let handlers: ((msg: { payload: unknown }) => void)[] = [];
  let stopped: { agentId: string; item: AgentBackgroundWorkItem }[] = [];
  let released = 0;
  let current: AgentBackgroundWorkItem[] = [bgItem("build")];

  const driver: BackgroundWorkDriver = {
    observeEvents: () => ({
      ready: Promise.resolve({}),
      subscribe: () => () => {},
      release: async () => {
        released++;
      },
    }),
    on: (_type, handler) => {
      handlers.push(handler);
      return () => {
        handlers = handlers.filter((h) => h !== handler);
      };
    },
    listAgentBackgroundWork: async () => ({ items: current, error: null }),
    stopAgentBackgroundWork: async (agentId, item) => {
      stopped.push({ agentId, item });
      current = current.filter((i) => i.id !== item.id);
      return { error: null };
    },
  };

  const bw = new HostBackgroundWork(driver);
  const seen: AgentBackgroundWorkItem[][] = [];
  const unwatch = bw.watch("agent-1", (items) => seen.push(items));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.length, 1);
  assert.equal(seen[0]![0]!.id, "build");

  // Live update pushes a heartbeat alongside the task.
  for (const h of handlers) h({ payload: { agentId: "agent-1", items: [bgItem("build"), bgItem("hb-1", "monitor")] } });
  await new Promise((r) => setTimeout(r, 550));
  assert.equal(seen.at(-1)!.length, 2);
  assert.equal(seen.at(-1)![1]!.kind, "monitor");

  // Stopping forwards the item and refreshes.
  await bw.stop("agent-1", bgItem("build"));
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0]!.agentId, "agent-1");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.at(-1)!.length, 0);

  unwatch();
  await bw.dispose();
  assert.equal(released, 1);
});

test("HostBackgroundWork degrades gracefully on hosts without background-work support", async () => {
  const bw = new HostBackgroundWork({});
  const seen: AgentBackgroundWorkItem[][] = [];
  const unwatch = bw.watch("a1", (items) => seen.push(items));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [[]]);
  await assert.rejects(() => bw.stop("a1", bgItem("x")), /does not support/);
  unwatch();
  await bw.dispose();
});

test("UsageService forwards quota forecast fields and balances-only accounts (OpenRouter / Copilot)", async () => {
  const fakeHosts = {
    clients: new Map([["h1", {}]]),
    state: () => "connected",
    label: () => "Local",
    get: () => ({
      api: {
        providers: {
          listUsage: async () => ({
            providers: [
              {
                providerId: "claude",
                displayName: "Claude",
                status: "ok",
                planLabel: "Max",
                windows: [
                  {
                    id: "5h",
                    label: "5-hour",
                    shortLabel: "5h",
                    remainingPct: 40,
                    resetsAt: "2026-11-23T05:00:00Z",
                    durationSeconds: 18000,
                    runsOutAt: "2026-11-23T02:30:00Z",
                    shortfallPct: 35,
                    summary: true,
                    tone: "warning",
                  },
                ],
              },
              {
                providerId: "openrouter",
                displayName: "OpenRouter",
                status: "ok",
                planLabel: "API",
                windows: [],
                balances: [
                  { id: "credits", label: "Credits", used: 12.5, remaining: 37.5, limit: 50, unit: "usd", resetsAt: null, tone: "ok" },
                ],
              },
            ],
          }),
        },
      },
    }),
  };

  const svc = new UsageService(fakeHosts as never, () => Date.parse("2026-11-23T01:00:00Z"));
  const report = await svc.report();
  assert.equal(report.accounts.length, 2);

  const claude = report.accounts.find((a) => a.providerId === "claude")!;
  assert.equal(claude.windows[0]!.runsOutAt, "2026-11-23T02:30:00Z");
  assert.equal(claude.windows[0]!.shortfallPct, 35);
  assert.equal(claude.windows[0]!.durationSeconds, 18000);

  const openrouter = report.accounts.find((a) => a.providerId === "openrouter")!;
  assert.equal(openrouter.balances?.length, 1);
  assert.equal(openrouter.balances![0]!.unit, "usd");
  assert.equal(openrouter.balances![0]!.remaining, 37.5);
});

test("projectProviderEntry retains safe http(s) docsUrl and drops unsafe schemes", () => {
  const safe = projectProviderEntry({
    provider: "claude",
    status: "available",
    docsUrl: "https://paseo.sh/docs/supported-providers/claude",
    models: [],
    modes: [],
  });
  assert.equal(safe.docsUrl, "https://paseo.sh/docs/supported-providers/claude");

  const unsafe = projectProviderEntry({
    provider: "custom",
    status: "available",
    docsUrl: "javascript:alert(1)",
    models: [],
    modes: [],
  });
  assert.equal(unsafe.docsUrl, undefined);
});

test("next-suggestion settings bind API keys to their origin and reject unsafe URLs", () => {
  const settings = new Map<string, string>();
  const store = {
    setting: (k: string) => settings.get(k) ?? null,
    setSetting: (k: string, v: string | null) => { if (v === null) settings.delete(k); else settings.set(k, v); },
  } as never;

  assert.equal(nextSuggestionSettings(store).configured, false);
  assert.throws(() => saveNextSuggestion(store, { baseUrl: "https://user:pass@api.openai.com/v1", apiKey: "sk-test" }));
  assert.throws(() => saveNextSuggestion(store, { baseUrl: "https://api.openai.com/v1?foo=1", apiKey: "sk-test" }));

  const saved = saveNextSuggestion(store, { baseUrl: "https://api.openai.com/v1/", apiKey: "sk-secret-1234", model: "gpt-4o-mini" });
  assert.equal(saved.configured, true);
  assert.equal(saved.baseUrl, "https://api.openai.com/v1");
  assert.equal(saved.keyHint, "…1234");
  assert.ok(!JSON.stringify(saved).includes("sk-secret-1234"));

  // Updating model on the same origin keeps the saved key.
  const sameOrigin = saveNextSuggestion(store, { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-nano" });
  assert.equal(sameOrigin.model, "gpt-4.1-nano");
  assert.equal(sameOrigin.keyHint, "…1234");

  // Changing origin without providing a new key is refused.
  assert.throws(() => saveNextSuggestion(store, { baseUrl: "https://other.example.com/v1", model: "gpt-4o-mini" }), /API key is required/);

  clearNextSuggestion(store);
  assert.equal(nextSuggestionSettings(store).configured, false);
});

test("next-suggestion trims context, parses JSON/fenced output, redacts keys on error, and dedupes cache", async () => {
  const trimmed = trimSuggestionContext([
    { role: "user", text: "Fix the bug" },
    { role: "assistant", text: "Working on it" },
    { role: "assistant", text: "Fixed it and tests pass." },
  ]);
  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[1]!.text, "Fixed it and tests pass.");

  assert.equal(parseSuggestionOutput('{"suggestion":"Run the full check suite"}'), "Run the full check suite");
  assert.equal(parseSuggestionOutput("```json\n{\"suggestion\":\"Add a test for empty input\"}\n```"), "Add a test for empty input");
  assert.equal(parseSuggestionOutput('{"suggestion":""}'), "");
  assert.throws(() => parseSuggestionOutput('{"suggestion":"line1\\nline2"}'));

  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"suggestion":"Ship 0.12.0"}' } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const cache = new NextSuggestionCache();
  const cfg = { baseUrl: "https://api.openai.com/v1", apiKey: "sk-top-secret", model: "gpt-4o-mini" };
  const [a, b] = await Promise.all([
    cache.getOrRun("h:a:10", () => generateNextSuggestion(cfg, trimmed, fakeFetch)),
    cache.getOrRun("h:a:10", () => generateNextSuggestion(cfg, trimmed, fakeFetch)),
  ]);
  assert.equal(a, "Ship 0.12.0");
  assert.equal(b, "Ship 0.12.0");
  assert.equal(calls, 1);

  const errFetch = (async () =>
    new Response(JSON.stringify({ error: { message: "Invalid key sk-top-secret" } }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    () => generateNextSuggestion(cfg, trimmed, errFetch),
    (err: Error) => !err.message.includes("sk-top-secret") && err.message.includes("[redacted]"),
  );
});
