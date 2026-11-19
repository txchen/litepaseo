import { z } from "zod";
import { DictationError, clearDictation, dictationConfig, dictationSettings, saveDictation, transcribe } from "./dictation.ts";
import type { DictationStreams } from "./dictation-stream.ts";
import { errorMessage, type App, type RouteContext } from "./route-context.ts";

const NOT_SET_UP = "Voice input is not set up. Add a transcription service in Settings.";

/**
 * Speech to text through the transcription service configured here, once for every host. The
 * browser streams PCM over a short-lived socket. The file endpoint remains for older
 * clients. The API key never leaves the server.
 */
export function registerDictationRoutes(app: App, { store, fetch, streamValidity }: RouteContext, streams: DictationStreams) {
  app.get("/api/dictation", (c) => c.json(dictationSettings(store)));
  app.post("/api/dictation/session", (c) => {
    const config = dictationConfig(store);
    if (!config) return c.json({ error: NOT_SET_UP }, 409);
    try {
      return c.json(streams.issue(config, streamValidity(c)));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 429);
    }
  });
  app.put("/api/dictation", async (c) => {
    try {
      return c.json(saveDictation(store, await c.req.json()));
    } catch (error) {
      const message = error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid settings" : errorMessage(error);
      return c.json({ error: message }, 400);
    }
  });
  app.delete("/api/dictation", (c) => {
    clearDictation(store);
    return c.json(dictationSettings(store));
  });
  app.post("/api/dictation/transcribe", async (c) => {
    const config = dictationConfig(store);
    if (!config) return c.json({ error: NOT_SET_UP }, 409);
    const format = /^audio\/pcm;rate=(\d{4,6});bits=16$/.exec(c.req.header("x-audio-format") ?? "");
    if (!format) return c.json({ error: "Unsupported audio format" }, 415);
    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.length < 3200 || audio.length % 2) return c.json({ error: "Recording too short" }, 400);
    try {
      return c.json({ text: await transcribe(config, audio, Number(format[1]), fetch) });
    } catch (error) {
      if (error instanceof DictationError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });
}
