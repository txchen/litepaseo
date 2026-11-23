import { z } from "zod";
import {
  NextSuggestionCache,
  NextSuggestionError,
  clearNextSuggestion,
  generateNextSuggestion,
  nextSuggestionConfig,
  nextSuggestionSettings,
  saveNextSuggestion,
} from "./next-suggestion.ts";
import { errorMessage, type App, type RouteContext } from "./route-context.ts";

const PredictRequest = z.object({
  lastSeqEnd: z.number().int().nonnegative(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(12_000),
      }),
    )
    .min(1)
    .max(20),
});

/**
 * Centralized next-message suggestions through an OpenAI-compatible chat endpoint configured once
 * in LitePaseo, shared across every host without any daemon plugin.
 */
export function registerSuggestionRoutes(app: App, { store, fetch }: RouteContext) {
  const cache = new NextSuggestionCache();

  app.get("/api/next-suggestion", (c) => c.json(nextSuggestionSettings(store)));
  app.put("/api/next-suggestion", async (c) => {
    try {
      const saved = saveNextSuggestion(store, await c.req.json());
      cache.clear();
      return c.json(saved);
    } catch (error) {
      const message = error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid settings" : errorMessage(error);
      return c.json({ error: message }, 400);
    }
  });
  app.delete("/api/next-suggestion", (c) => {
    clearNextSuggestion(store);
    cache.clear();
    return c.json(nextSuggestionSettings(store));
  });

  app.post("/api/hosts/:host/agents/:agent/next-suggestion", async (c) => {
    const config = nextSuggestionConfig(store);
    if (!config) return c.json({ status: "disabled", text: "" });
    const input = PredictRequest.parse(await c.req.json());
    const key = `${c.req.param("host")}:${c.req.param("agent")}:${input.lastSeqEnd}`;
    try {
      const text = await cache.getOrRun(key, () => generateNextSuggestion(config, input.messages, fetch));
      return c.json({ status: text ? "ready" : "empty", text });
    } catch (error) {
      if (error instanceof NextSuggestionError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });
}
