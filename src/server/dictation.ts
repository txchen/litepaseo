import { z } from "zod";
import type { Store } from "./store.ts";

/**
 * File transcription for phrases from dictation-stream and complete clips from older clients.
 * Wraps mono PCM as WAV for an OpenAI-compatible `/audio/transcriptions` endpoint.
 * Voice input is configured in LitePaseo; no Paseo host is involved.
 *
 * Request shape differs by model generation (OpenAI speech-to-text guide, 2026):
 * - `gpt-transcribe` takes `languages[]` (several expected languages, for code-switching) and
 *   `keywords[]`; it "replaces the singular `language` field. Don't send both fields."
 * - `whisper-1`, `gpt-4o(-mini)-transcribe` and most compatible providers (Groq, local Whisper
 *   servers) take a single `language` and a free-text `prompt`.
 * Paseo always sends `language` (default "en"), which is what breaks `gpt-transcribe` there.
 * Here the shape follows the model name, and a 400 about the language field retries once with
 * the other shape, so unknown models on compatible providers still work.
 */
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** The recommended model; whisper-1 and the gpt-4o transcribe models shut down 2027-02-26. */
export const DEFAULT_MODEL = "gpt-transcribe";
/** Five minutes of 16 kHz, 16-bit mono speech (9.6 MB as WAV, under the 25 MB upload limit). */
export const MAX_DICTATION_BYTES = 5 * 60 * 16_000 * 2;
const SETTING = "dictation";
const UPSTREAM_TIMEOUT_MS = 110_000;
/** Whisper reads at most 224 prompt tokens; keep the folded vocabulary well under that. */
const LEGACY_PROMPT_CHARS = 600;

export interface DictationConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Expected input languages (ISO 639-1/639-3 or zh-cn style); empty lets the model detect. */
  languages: string[];
  /** Names and terms to spell correctly: project names, tools, people. */
  keywords: string[];
}
/** What the browser may see: never the key itself. */
export interface DictationSettings {
  configured: boolean;
  baseUrl: string;
  model: string;
  languages: string[];
  keywords: string[];
  keyHint: string;
}

const baseUrl = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v || DEFAULT_BASE_URL).replace(/\/+$/, ""))
  .refine((v) => {
    try {
      return ["http:", "https:"].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, "Base URL must be an http(s) address");
const languageCode = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase().replace("_", "-"))
  .refine((v) => /^[a-z]{2,3}(-[a-z]{2})?$/.test(v), "Languages must be codes such as en, zh or zh-tw");
/** The API rejects the whole request for a keyword with <, > or a line break. */
const keyword = z
  .string()
  .trim()
  .min(1)
  .max(100, "Each vocabulary term must be under 100 characters")
  .refine((v) => !/[<>\r\n]/.test(v), "Vocabulary terms cannot contain < or >");
const unique = <T>(values: T[]) => [...new Set(values)];
export const DictationUpdate = z.object({
  baseUrl: baseUrl.optional().default(DEFAULT_BASE_URL),
  /** Omitted or empty keeps the saved key. */
  apiKey: z.string().trim().max(1000).optional(),
  model: z.string().trim().max(200).optional().transform((v) => v || DEFAULT_MODEL),
  languages: z.array(languageCode).max(10, "At most 10 languages").optional().default([]).transform(unique),
  keywords: z.array(keyword).max(100, "At most 100 vocabulary terms").optional().default([]).transform(unique),
});

export function dictationConfig(store: Store): DictationConfig | null {
  const raw = store.setting(SETTING);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DictationConfig>;
    if (!value.apiKey || !value.baseUrl || !value.model) return null;
    return { baseUrl: value.baseUrl, apiKey: value.apiKey, model: value.model, languages: value.languages ?? [], keywords: value.keywords ?? [] };
  } catch {
    return null;
  }
}
export function dictationSettings(store: Store): DictationSettings {
  const config = dictationConfig(store);
  return {
    configured: !!config,
    baseUrl: config?.baseUrl ?? DEFAULT_BASE_URL,
    model: config?.model ?? DEFAULT_MODEL,
    languages: config?.languages ?? [],
    keywords: config?.keywords ?? [],
    keyHint: config ? "…" + config.apiKey.slice(-4) : "",
  };
}
export function saveDictation(store: Store, input: unknown): DictationSettings {
  const update = DictationUpdate.parse(input);
  const apiKey = update.apiKey || dictationConfig(store)?.apiKey;
  if (!apiKey) throw new Error("An API key is required");
  const config: DictationConfig = { baseUrl: update.baseUrl, apiKey, model: update.model, languages: update.languages, keywords: update.keywords };
  store.setSetting(SETTING, JSON.stringify(config));
  return dictationSettings(store);
}
export function clearDictation(store: Store) {
  store.setSetting(SETTING, null);
}

/** A 44-byte RIFF header makes raw PCM16 a file every transcription API accepts. */
export function wav(pcm: Uint8Array, rate: number) {
  const out = Buffer.alloc(44 + pcm.length);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + pcm.length, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(pcm.length, 40);
  out.set(pcm, 44);
  return out;
}

/** "hints": languages[] + keywords[] (gpt-transcribe). "single": language + prompt (Whisper family). */
export type RequestShape = "hints" | "single";
export const shapeFor = (model: string): RequestShape => (/(^|\/)gpt-transcribe\b/i.test(model) ? "hints" : "single");

/** The multipart fields besides the file, for one request shape. */
export function transcriptionFields(config: DictationConfig, shape: RequestShape): [string, string][] {
  const fields: [string, string][] = [["model", config.model], ["response_format", "json"]];
  if (shape === "hints") {
    for (const code of config.languages) fields.push(["languages[]", code]);
    for (const term of config.keywords) fields.push(["keywords[]", term]);
    return fields;
  }
  // One hint only: a single expected language becomes `language` (ISO 639-1, so zh-tw → zh).
  // With several, the model detects; forcing the first would mistranscribe the others.
  if (config.languages.length === 1) fields.push(["language", config.languages[0]!.split("-")[0]!]);
  // Whisper-style prompting: a list of correct spellings is the documented way to teach terms.
  if (config.keywords.length) {
    let prompt = "";
    for (const term of config.keywords) {
      const next = prompt ? `${prompt}, ${term}` : term;
      if (next.length > LEGACY_PROMPT_CHARS) break;
      prompt = next;
    }
    fields.push(["prompt", prompt]);
  }
  return fields;
}

export class DictationError extends Error {
  readonly status: 502 | 504;
  constructor(message: string, status: 502 | 504) {
    super(message);
    this.status = status;
  }
}

interface Attempt { ok: boolean; status: number; text?: string; detail: string }

async function send(config: DictationConfig, file: Blob, shape: RequestShape, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Attempt> {
  const form = new FormData();
  form.append("file", file, "dictation.wav");
  for (const [name, value] of transcriptionFields(config, shape)) form.append(name, value);
  let response: Response;
  try {
    response = await fetchImpl(config.baseUrl + "/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]) : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = (error as Error).name === "TimeoutError";
    throw new DictationError(timeout ? "The transcription service did not answer in time" : `Could not reach the transcription service: ${(error as Error).message}`.slice(0, 300), timeout ? 504 : 502);
  }
  const body = await response.text();
  let data: { text?: unknown; error?: { message?: unknown } | string } = {};
  try {
    data = JSON.parse(body);
  } catch { /* plain-text error page */ }
  const detail = typeof data.error === "string" ? data.error : typeof data.error?.message === "string" ? data.error.message : response.ok ? "" : body;
  return { ok: response.ok, status: response.status, text: typeof data.text === "string" ? data.text : undefined, detail: String(detail) };
}

export async function transcribe(config: DictationConfig, pcm: Uint8Array, rate: number, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<string> {
  const file = new Blob([wav(pcm, rate)], { type: "audio/wav" });
  const shape = shapeFor(config.model);
  let result = await send(config, file, shape, fetchImpl, signal);
  // A model we guessed wrong about rejects the language/keyword fields; ask once the other way.
  const hinted = config.languages.length > 0 || config.keywords.length > 0;
  if (!result.ok && result.status === 400 && hinted && /language|keyword|prompt/i.test(result.detail))
    result = await send(config, file, shape === "hints" ? "single" : "hints", fetchImpl, signal).then((retry) => (retry.ok ? retry : result));
  if (!result.ok) {
    const scrubbed = result.detail.split(config.apiKey).join("…").replace(/\s+/g, " ").trim().slice(0, 200);
    throw new DictationError(`Transcription failed (${result.status})${scrubbed ? ": " + scrubbed : ""}`, 502);
  }
  if (result.text === undefined) throw new DictationError("The transcription service returned no text", 502);
  return result.text.trim();
}
