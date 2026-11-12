import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";
import { wav } from "../src/server/dictation.ts";

const PCM = "audio/pcm;rate=16000;bits=16";

function setup(reply: (url: string, init: RequestInit) => Response | Promise<Response> = () => Response.json({ text: " hello world " })) {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-dictation-"));
  const store = new Store(directory);
  const hosts = new Hosts();
  const calls: { url: string; auth: string; form: FormData }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: String((init.headers as Record<string, string>).authorization), form: init.body as FormData });
    return reply(url, init);
  }) as typeof globalThis.fetch;
  const app = createApp(store, hosts, "test-token", directory, { fetch });
  const request = (path: string, init: RequestInit = {}) =>
    app.request("/api" + path, { ...init, headers: { authorization: "Bearer test-token", "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
  const speak = (bytes = 16_000 * 2 * 2) =>
    request("/dictation/transcribe", { method: "POST", body: new Uint8Array(bytes), headers: { "Content-Type": "application/octet-stream", "x-audio-format": PCM } });
  return { store, calls, request, json, speak, done: async () => { app.dispose(); await hosts.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("voice input is off until a transcription service is set up, and the key never comes back", async () => {
  const { request, json, speak, done } = setup();
  try {
    assert.equal((await (await request("/dictation")).json()).configured, false);
    assert.equal((await speak()).status, 409);
    assert.equal((await request("/dictation/session", { method: "POST" })).status, 409);
    assert.equal((await request("/dictation", json("PUT", { baseUrl: "https://stt.example/v1" }))).status, 400, "a key is required the first time");
    assert.equal((await request("/dictation", json("PUT", { apiKey: "k", baseUrl: "ftp://x" }))).status, 400);
    assert.equal((await request("/dictation", json("PUT", { apiKey: "k", languages: ["Chinese"] }))).status, 400);
    const angle = await request("/dictation", json("PUT", { apiKey: "k", keywords: ["<b>"] }));
    assert.equal(angle.status, 400, "the API rejects the whole request for such a keyword");

    const saved = await (await request("/dictation", json("PUT", {
      baseUrl: "https://stt.example/v1/", apiKey: "sk-secret-1234", model: "", languages: ["ZH_TW", "en", "en"], keywords: [" LitePaseo ", "Claude Code"],
    }))).json();
    assert.deepEqual(saved, {
      configured: true, baseUrl: "https://stt.example/v1", model: "gpt-transcribe",
      languages: ["zh-tw", "en"], keywords: ["LitePaseo", "Claude Code"], keyHint: "…1234",
    });
    assert.doesNotMatch(await (await request("/dictation")).text(), /secret/);
    const ticket = await (await request("/dictation/session", { method: "POST" })).json();
    assert.equal(typeof ticket.ticket, "string");
    assert.equal(ticket.rate, 24_000);
    assert.doesNotMatch(JSON.stringify(ticket), /secret/);
    assert.equal((await request("/dictation/session", { method: "POST", headers: { authorization: "" } })).status, 401);

    // Editing without a key keeps the saved one.
    const edited = await (await request("/dictation", json("PUT", { baseUrl: "", model: "whisper-1" }))).json();
    assert.deepEqual(edited, { configured: true, baseUrl: "https://api.openai.com/v1", model: "whisper-1", languages: [], keywords: [], keyHint: "…1234" });

    assert.equal((await (await request("/dictation", { method: "DELETE" })).json()).configured, false);
    assert.equal((await speak()).status, 409);
  } finally {
    await done();
  }
});

const fields = (form: FormData) => {
  const out: string[][] = [];
  form.forEach((value, name) => name !== "file" && out.push([name, String(value)]));
  return out;
};

test("gpt-transcribe gets languages[] and keywords[], never the singular language", async () => {
  const { calls, request, json, speak, done } = setup();
  try {
    await request("/dictation", json("PUT", { baseUrl: "https://stt.example/v1", apiKey: "sk-abc", languages: ["zh", "en"], keywords: ["LitePaseo", "pnpm"] }));
    const response = await speak(16_000 * 2 * 2);
    assert.deepEqual(await response.json(), { text: "hello world" });
    assert.equal(calls.length, 1);
    const { url, auth, form } = calls[0]!;
    assert.equal(url, "https://stt.example/v1/audio/transcriptions");
    assert.equal(auth, "Bearer sk-abc");
    assert.deepEqual(fields(form), [
      ["model", "gpt-transcribe"], ["response_format", "json"],
      ["languages[]", "zh"], ["languages[]", "en"], ["keywords[]", "LitePaseo"], ["keywords[]", "pnpm"],
    ]);
    const file = form.get("file") as File;
    assert.equal(file.type, "audio/wav");
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes.length, 44 + 64_000);
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.readUInt32LE(24), 16_000);

    const bad = await request("/dictation/transcribe", { method: "POST", body: new Uint8Array(32_000), headers: { "x-audio-format": "audio/webm" } });
    assert.equal(bad.status, 415);
    assert.equal((await speak(100)).status, 400);
    const signedOut = await request("/dictation", { ...json("PUT", { apiKey: "x" }), headers: { authorization: "", cookie: "lp_session=nope" } });
    assert.equal(signedOut.status, 401);
  } finally {
    await done();
  }
});

test("Whisper-style models get one language and the vocabulary as a prompt", async () => {
  const { calls, request, json, speak, done } = setup();
  try {
    await request("/dictation", json("PUT", { apiKey: "k", model: "gpt-4o-mini-transcribe", languages: ["zh-cn"], keywords: ["LitePaseo", "Claude Code"] }));
    await speak();
    assert.deepEqual(fields(calls[0]!.form), [
      ["model", "gpt-4o-mini-transcribe"], ["response_format", "json"], ["language", "zh"], ["prompt", "LitePaseo, Claude Code"],
    ]);
    // Several languages: let the model detect rather than force the first one.
    await request("/dictation", json("PUT", { model: "whisper-large-v3", languages: ["zh", "en"] }));
    await speak();
    assert.deepEqual(fields(calls[1]!.form), [["model", "whisper-large-v3"], ["response_format", "json"]]);
  } finally {
    await done();
  }
});

test("a model that rejects the language field is asked once the other way", async () => {
  let attempt = 0;
  const { calls, request, json, speak, done } = setup(() =>
    ++attempt === 1
      ? Response.json({ error: { message: "Unsupported parameter: 'language'. Use 'languages' instead." } }, { status: 400 })
      : Response.json({ text: "你好 world" }));
  try {
    await request("/dictation", json("PUT", { apiKey: "k", model: "proxy-transcribe-v2", languages: ["zh"] }));
    assert.deepEqual(await (await speak()).json(), { text: "你好 world" });
    assert.deepEqual(calls.map((c) => fields(c.form).find(([name]) => name.startsWith("language"))), [["language", "zh"], ["languages[]", "zh"]]);
  } finally {
    await done();
  }
});

test("other errors are not retried", async () => {
  const { calls, request, json, speak, done } = setup(() => Response.json({ error: { message: "Audio file is too short" } }, { status: 400 }));
  try {
    await request("/dictation", json("PUT", { apiKey: "k", languages: ["en"] }));
    const response = await speak();
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /too short/);
    assert.equal(calls.length, 1);
  } finally {
    await done();
  }
});

test("a provider error is reported without the key", async () => {
  const { request, json, speak, done } = setup(() =>
    Response.json({ error: { message: "Incorrect API key provided: sk-leak-9999" } }, { status: 401 }));
  try {
    await request("/dictation", json("PUT", { apiKey: "sk-leak-9999" }));
    const response = await speak();
    assert.equal(response.status, 502);
    const { error } = await response.json();
    assert.match(error, /Transcription failed \(401\)/);
    assert.doesNotMatch(error, /sk-leak/);
  } finally {
    await done();
  }
});

test("wav() writes a standard 16-bit mono header", () => {
  const out = wav(new Uint8Array(10), 24_000);
  assert.equal(out.toString("ascii", 8, 12), "WAVE");
  assert.equal(out.readUInt32LE(4), 46);
  assert.equal(out.readUInt32LE(28), 48_000);
  assert.equal(out.readUInt32LE(40), 10);
});
