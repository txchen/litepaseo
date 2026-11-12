import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { DictationStreams, DICTATION_RATE } from "../src/server/dictation-stream.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(predicate: () => boolean) {
  const end = Date.now() + 4_000;
  while (!predicate()) { if (Date.now() > end) throw new Error("Timed out waiting for dictation event"); await sleep(5); }
}
const listen = async (server: Server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; };
const stop = async (server: Server) => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); };
const audio = (seconds: number, sound = true) => {
  const data = Buffer.alloc(Math.round(seconds * DICTATION_RATE) * 2);
  if (sound) for (let i = 0; i < data.length; i += 2) data.writeInt16LE(Math.round(Math.sin(i / 20) * 2_000), i);
  return data;
};
function phrase(ws: WebSocket) { ws.send(audio(0.7)); ws.send(audio(0.7)); ws.send(audio(0.8, false)); }

async function setup(realtime: boolean, fetchImpl: typeof fetch = fetch) {
  const upstream = createServer();
  const upstreamUrl = await listen(upstream);
  const upstreamWs = new WebSocketServer({ noServer: true });
  let upgrades = 0;
  let connection: WebSocket | undefined;
  const commands: any[] = [];
  upstream.on("upgrade", (req, socket, head) => {
    upgrades++;
    assert.equal(req.headers.authorization, "Bearer secret");
    assert.equal(req.url, "/v1/realtime?intent=transcription");
    if (!realtime) { socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n"); return; }
    upstreamWs.handleUpgrade(req, socket, head, ws => {
      connection = ws;
      ws.on("message", data => {
        const event = JSON.parse(data.toString()); commands.push(event);
        if (event.type === "session.update") ws.send(JSON.stringify({ type: "session.updated" }));
      });
    });
  });
  const metrics: unknown[] = [];
  const manager = new DictationStreams(fetchImpl, m => metrics.push(m));
  const server = createServer();
  manager.attach(server);
  const url = await listen(server);
  let valid = true;
  const config = { baseUrl: upstreamUrl + "/v1", apiKey: "secret", model: "gpt-transcribe", languages: ["zh", "en"], keywords: ["LitePaseo"] };
  const connect = async () => {
    const { ticket } = manager.issue(config, () => valid);
    const wsUrl = url.replace("http:", "ws:") + "/api/dictation/stream?ticket=" + ticket;
    const ws = new WebSocket(wsUrl);
    const events: any[] = [];
    ws.on("message", data => events.push(JSON.parse(data.toString())));
    await once(ws, "open");
    await until(() => events.some(e => e.type === "ready"));
    return { ws, events, wsUrl };
  };
  return { connect, commands, config, manager, metrics, get upstream() { return connection!; }, get upgrades() { return upgrades; }, revoke: () => { valid = false; }, done: async () => {
    manager.close(); connection?.terminate(); upstreamWs.close(); await stop(server); await stop(upstream);
  } };
}

test("Realtime uploads before stop, commits phrases, and reconciles reversed completion order", async () => {
  const s = await setup(true);
  try {
    const { ws, events } = await s.connect();
    const input = s.commands[0].session.audio.input;
    assert.deepEqual(input.transcription, { model: "gpt-transcribe", languages: ["zh", "en"], keywords: ["LitePaseo"] });
    assert.equal(input.turn_detection, null);
    ws.send(audio(0.5));
    await until(() => s.commands.some(e => e.type === "input_audio_buffer.append"));
    assert.equal(s.commands.some(e => e.type === "input_audio_buffer.commit"), false, "upload does not commit each network packet");
    ws.send(audio(0.8, false));
    phrase(ws);
    await until(() => s.commands.filter(e => e.type === "input_audio_buffer.commit").length === 2);
    const emit = (e: unknown) => s.upstream.send(JSON.stringify(e));
    emit({ type: "input_audio_buffer.committed", item_id: "a", previous_item_id: null });
    emit({ type: "input_audio_buffer.committed", item_id: "b", previous_item_id: "a" });
    emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "b", transcript: "第二句" });
    emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "第一" });
    await until(() => events.some(e => e.type === "partial" && e.text === "第一"));
    assert.equal(events.some(e => e.text === "第二句"), false);
    emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "第一句。" });
    await until(() => events.some(e => e.text === "第一句。 第二句"));
    ws.send(audio(0.3, false));
    ws.send(JSON.stringify({ type: "stop" }));
    await until(() => events.some(e => e.type === "done"));
    assert.equal(events.at(-1).text, "第一句。 第二句");
    assert.equal(s.commands.filter(e => e.type === "input_audio_buffer.commit").length, 2, "silence-only tail must not trigger another transcription");
    assert.equal(s.metrics.length, 1);
  } finally { await s.done(); }
});

test("file-only gateway transcribes phrases before stop, preserves order and caches unsupported realtime", async () => {
  const requests: { resolve: (r: Response) => void; signal: AbortSignal; form: FormData }[] = [];
  const fetchImpl = ((_: unknown, init: RequestInit) => new Promise<Response>(resolve => requests.push({ resolve, signal: init.signal!, form: init.body as FormData }))) as typeof fetch;
  const s = await setup(false, fetchImpl);
  try {
    const { ws, events } = await s.connect();
    assert.equal(events[0].mode, "segmented");
    phrase(ws); phrase(ws);
    await until(() => requests.length === 2);
    const bytes = Buffer.from(await (requests[0].form.get("file") as Blob).arrayBuffer());
    assert.equal(bytes.readUInt32LE(24), 24_000);
    assert.deepEqual(requests[0].form.getAll("languages[]"), ["zh", "en"]);
    requests[1].resolve(Response.json({ text: "second" }));
    requests[0].resolve(Response.json({ text: "first" }));
    await until(() => events.some(e => e.type === "partial" && e.text === "first second"));
    assert.equal(events.some(e => e.type === "done"), false, "speech is visible while still recording");
    ws.send(audio(0.4)); ws.send(JSON.stringify({ type: "stop" }));
    await until(() => requests.length === 3);
    requests[2].resolve(Response.json({ text: "last" }));
    await until(() => events.some(e => e.type === "done"));
    assert.equal(events.at(-1).text, "first second last");
    const next = await s.connect();
    assert.equal(s.upgrades, 1, "avoid failed handshake on every recording");
    next.ws.send(JSON.stringify({ type: "cancel" }));
    await once(next.ws, "close");
  } finally { await s.done(); }
});

test("cancel aborts pending transcription and produces no final text", async () => {
  let signal: AbortSignal | undefined;
  const fetchImpl = ((_: unknown, init: RequestInit) => {
    signal = init.signal!;
    return new Promise<Response>((_, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  }) as typeof fetch;
  const s = await setup(false, fetchImpl);
  try {
    const { ws, events } = await s.connect();
    phrase(ws);
    await until(() => !!signal);
    ws.send(JSON.stringify({ type: "cancel" }));
    await once(ws, "close");
    assert.equal(signal!.aborted, true);
    assert.equal(events.some(e => e.type === "done"), false);
  } finally { await s.done(); }
});

test("tickets are single use and session revocation rejects further audio", async () => {
  const s = await setup(true);
  try {
    const { ws, events, wsUrl } = await s.connect();
    const duplicate = new WebSocket(wsUrl);
    duplicate.on("error", () => {});
    const status = await new Promise(resolve => duplicate.on("unexpected-response", (_, res) => { resolve(res.statusCode); res.destroy(); duplicate.terminate(); }));
    assert.equal(status, 401);
    s.revoke(); ws.send(audio(0.3));
    await until(() => events.some(e => e.type === "error"));
    assert.match(events.at(-1).message, /session ended/);
    assert.equal(s.commands.some(e => e.type === "input_audio_buffer.append"), false);
  } finally { await s.done(); }
});

test("silence finishes empty and malformed chunks fail without leaking credentials", async () => {
  const s = await setup(true);
  try {
    const silent = await s.connect();
    silent.ws.send(audio(0.8, false)); silent.ws.send(JSON.stringify({ type: "stop" }));
    await until(() => silent.events.some(e => e.type === "done"));
    assert.equal(silent.events.at(-1).text, "");
    const bad = await s.connect();
    bad.ws.send(Buffer.alloc(3));
    await until(() => bad.events.some(e => e.type === "error"));
    assert.doesNotMatch(JSON.stringify(bad.events), /secret/);
  } finally { await s.done(); }
});

test("disconnect aborts file jobs, and reconnect starts with no previous transcript", async () => {
  let signal: AbortSignal | undefined;
  const fetchImpl = ((_: unknown, init: RequestInit) => {
    signal = init.signal!;
    return new Promise<Response>((_, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  }) as typeof fetch;
  const s = await setup(false, fetchImpl);
  try {
    const first = await s.connect();
    phrase(first.ws); await until(() => !!signal);
    first.ws.terminate(); await until(() => signal!.aborted);
    const next = await s.connect();
    next.ws.send(audio(0.3, false)); next.ws.send(JSON.stringify({ type: "stop" }));
    await until(() => next.events.some(e => e.type === "done"));
    assert.equal(next.events.at(-1).text, "");
  } finally { await s.done(); }
});

test("Realtime failure retains recognized text and never resubmits audio as a file", async () => {
  let fileCalls = 0;
  const s = await setup(true, (async () => { fileCalls++; return Response.json({ text: "duplicated" }); }) as typeof fetch);
  try {
    const { ws, events } = await s.connect(); phrase(ws);
    await until(() => s.commands.some(e => e.type === "input_audio_buffer.commit"));
    s.upstream.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "a" }));
    s.upstream.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "Keep this" }));
    await until(() => events.some(e => e.text === "Keep this"));
    s.upstream.terminate();
    await until(() => events.some(e => e.type === "error"));
    assert.equal(events.at(-1).text, "Keep this");
    assert.equal(fileCalls, 0);
  } finally { await s.done(); }
});
