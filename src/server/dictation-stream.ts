import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { transcribe, type DictationConfig } from "./dictation.ts";

export const DICTATION_RATE = 24_000;
const BYTES_PER_SECOND = DICTATION_RATE * 2;
const MAX_BYTES = BYTES_PER_SECOND * 300;
const MAX_BUFFERED = BYTES_PER_SECOND * 10;

type Event = { type: string; [key: string]: unknown };
type Segment = { text: string; done: boolean; id?: string };
type Ticket = { config: DictationConfig; valid: () => boolean; expires: number };
export type DictationMetrics = { mode: string; audioMs: number; firstTextMs: number | null; finishMs: number };

/** One-use, short-lived tickets keep credentials out of WebSocket URLs. */
export class DictationStreams {
  private tickets = new Map<string, Ticket>();
  private sessions = new Set<DictationStream>();
  private unsupported = new Map<string, number>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: BYTES_PER_SECOND, perMessageDeflate: false });
  private fetchImpl: typeof fetch;
  private log: (metrics: DictationMetrics) => void;
  constructor(fetchImpl: typeof fetch = fetch, log: (metrics: DictationMetrics) => void = () => {}) {
    this.fetchImpl = fetchImpl;
    this.log = log;
  }

  issue(config: DictationConfig, valid: () => boolean) {
    for (const [key, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(key);
    if (this.tickets.size + this.sessions.size >= 16) throw new Error("Too many voice sessions. Try again shortly.");
    const ticket = randomUUID();
    this.tickets.set(ticket, { config, valid, expires: Date.now() + 30_000 });
    return { ticket, rate: DICTATION_RATE };
  }

  attach(server: Server) {
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/api/dictation/stream") { socket.destroy(); return; }
      const key = url.searchParams.get("ticket") ?? "";
      const ticket = this.tickets.get(key);
      this.tickets.delete(key);
      if (!ticket || ticket.expires < Date.now() || !ticket.valid()) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (client) => {
        const cacheKey = ticket.config.baseUrl + ":" + ticket.config.model;
        const stream = new DictationStream(client, ticket.config, ticket.valid, {
          fetch: this.fetchImpl,
          skipRealtime: (this.unsupported.get(cacheKey) ?? 0) > Date.now(),
          unsupported: () => {
            for (const [key, until] of this.unsupported) if (until < Date.now()) this.unsupported.delete(key);
            this.unsupported.set(cacheKey, Date.now() + 5 * 60_000);
          },
          closed: () => this.sessions.delete(stream),
          log: this.log,
        });
        this.sessions.add(stream);
        void stream.start();
      });
    });
  }
  close() {
    for (const stream of this.sessions) stream.close();
    this.tickets.clear();
    this.unsupported.clear();
    this.wss.close();
  }
}

type Options = { fetch: typeof fetch; skipRealtime: boolean; unsupported: () => void; closed: () => void; log: (m: DictationMetrics) => void };

/** Audio flows while recording. Realtime is preferred; file-only services transcribe phrases. */
class DictationStream {
  private upstream?: WebSocket;
  private mode = "connecting";
  private closed = false;
  private finishing = false;
  private totalBytes = 0;
  private segmentBytes = 0;
  private silenceBytes = 0;
  private speech = false;
  private chunks: Buffer[] = [];
  private segments: Segment[] = [];
  private commits: Segment[] = [];
  private items = new Map<string, Segment>();
  private jobs: { audio: Buffer; segment: Segment }[] = [];
  private activeJobs = 0;
  private abort = new AbortController();
  private started = Date.now();
  private stopped = 0;
  private firstText: number | null = null;
  private deadline?: ReturnType<typeof setTimeout>;
  private heartbeat: ReturnType<typeof setInterval>;

  private client: WebSocket;
  private config: DictationConfig;
  private valid: () => boolean;
  private options: Options;
  constructor(client: WebSocket, config: DictationConfig, valid: () => boolean, options: Options) {
    this.client = client;
    this.config = config;
    this.valid = valid;
    this.options = options;
    this.heartbeat = setInterval(() => {
      if (!valid()) this.fail("Your session ended. Sign in again.");
      else if (Date.now() - this.started > 430_000) this.fail("Voice session timed out.");
      else if (client.readyState === WebSocket.OPEN) client.ping();
    }, 10_000);
    this.heartbeat.unref();
    client.on("message", (data, binary) => {
      if (this.closed) return;
      if (!valid()) { this.fail("Your session ended. Sign in again."); return; }
      try {
        if (binary) this.append(Buffer.from(data as Buffer));
        else {
          const event = JSON.parse(data.toString());
          if (event.type === "stop") this.finish();
          else if (event.type === "cancel") this.close();
          else this.fail("Unknown voice command.");
        }
      } catch { this.fail("Invalid voice data."); }
    });
    client.on("error", () => this.close());
    client.on("close", () => this.close());
  }

  async start() {
    // Unknown compatible file models need not incur a doomed Realtime handshake.
    const realtimeModel = /^(gpt-transcribe|gpt-live-transcribe|gpt-4o(-mini)?-transcribe|whisper-1)$/.test(this.config.model);
    if (this.options.skipRealtime || !realtimeModel) { this.ready("segmented"); return; }
    try {
      await this.connectRealtime();
      if (!this.closed) this.ready("realtime");
    } catch (error) {
      if (this.closed) return;
      if (error instanceof Unavailable) {
        this.options.unsupported();
        this.ready("segmented");
      } else this.fail((error as Error).message);
    }
  }

  private connectRealtime() {
    return new Promise<void>((resolve, reject) => {
      const url = new URL(this.config.baseUrl + "/realtime");
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("intent", "transcription");
      const ws = this.upstream = new WebSocket(url, { headers: { Authorization: `Bearer ${this.config.apiKey}` }, handshakeTimeout: 4_000, maxPayload: 1024 * 1024 });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) { this.upstream = undefined; ws.terminate(); reject(error); }
        else resolve();
      };
      const timeout = setTimeout(() => finish(new Unavailable("Realtime connection timed out")), 5_000);
      ws.on("open", () => {
        const hints = /^(gpt-transcribe|gpt-live-transcribe)$/.test(this.config.model);
        const transcription = {
          model: this.config.model,
          ...(hints ? {
            ...(this.config.languages.length ? { languages: this.config.languages } : {}),
            ...(this.config.keywords.length ? { keywords: this.config.keywords } : {}),
          } : {
            ...(this.config.languages.length === 1 ? { language: this.config.languages[0]!.split("-")[0] } : {}),
            ...(this.config.keywords.length ? { prompt: this.config.keywords.join(", ").slice(0, 600) } : {}),
          }),
        };
        ws.send(JSON.stringify({ type: "session.update", session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: DICTATION_RATE }, transcription, turn_detection: null } } } }));
      });
      ws.on("unexpected-response", (_, response) => {
        const status = response.statusCode;
        response.destroy();
        finish([400, 404, 405, 501].includes(status ?? 0)
          ? new Unavailable("Realtime is not supported")
          : new Error(`Voice connection failed (${status}). Check the transcription service settings.`));
      });
      ws.on("message", (data) => {
        let event: Event;
        try { event = JSON.parse(data.toString()); } catch { finish(new Error("Invalid transcription service response.")); return; }
        if (!settled) {
          if (event.type === "session.updated") finish();
          else if (event.type === "error") finish(new Unavailable("Realtime configuration is not supported"));
        } else if (this.mode === "realtime" && !this.closed) this.upstreamEvent(event);
      });
      ws.on("error", () => {
        if (!settled) finish(new Unavailable("Realtime is unavailable"));
        else if (this.mode === "realtime") this.fail("Voice connection interrupted. Please try again.");
      });
      ws.on("close", () => {
        if (!settled) finish(new Unavailable("Realtime is unavailable"));
        else if (this.mode === "realtime" && !this.closed) this.fail("Voice connection interrupted. Please try again.");
      });
    });
  }

  private ready(mode: string) {
    if (this.closed) return;
    // Live-only models have no file-transcription fallback.
    if (mode === "segmented" && this.config.model === "gpt-live-transcribe") {
      this.fail("This service does not support realtime transcription. Choose gpt-transcribe or a realtime-compatible service.");
      return;
    }
    this.mode = mode;
    this.send({ type: "ready", mode, rate: DICTATION_RATE });
  }

  private append(audio: Buffer) {
    if (this.finishing || this.mode === "connecting") { this.fail("Voice session is not recording."); return; }
    if (!audio.length || audio.length % 2 || audio.length > BYTES_PER_SECOND) { this.fail("Invalid audio chunk."); return; }
    this.totalBytes += audio.length;
    if (this.totalBytes > MAX_BYTES) { this.fail("Recording exceeds five minutes."); return; }
    this.chunks.push(audio);
    this.segmentBytes += audio.length;
    // RMS over PCM16; only silence determines phrase boundaries, never each network packet.
    let energy = 0;
    for (let i = 0; i < audio.length; i += 2) { const sample = audio.readInt16LE(i) / 32768; energy += sample * sample; }
    if (Math.sqrt(energy / (audio.length / 2)) >= 0.006) { this.speech = true; this.silenceBytes = 0; }
    else this.silenceBytes += audio.length;
    if (this.mode === "realtime") {
      if (!this.upstream || this.upstream.bufferedAmount > MAX_BUFFERED) { this.fail("Voice upload cannot keep up with recording."); return; }
      this.upstream.send(JSON.stringify({ type: "input_audio_buffer.append", audio: audio.toString("base64") }));
    }
    if (this.speech && ((this.segmentBytes >= BYTES_PER_SECOND && this.silenceBytes >= BYTES_PER_SECOND * 0.7) || this.segmentBytes >= BYTES_PER_SECOND * 30)) this.commit();
    else if (!this.speech && this.segmentBytes >= BYTES_PER_SECOND * 2) this.clearAudio();
  }

  private clearAudio() {
    this.chunks = [];
    this.segmentBytes = this.silenceBytes = 0;
    this.speech = false;
    if (this.mode === "realtime") this.upstream?.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
  }

  private commit() {
    if (!this.segmentBytes) return;
    const segment: Segment = { text: "", done: false };
    this.segments.push(segment);
    if (this.mode === "realtime") {
      // The service requires at least 100 ms; pad a very short final word, never drop it.
      if (this.segmentBytes < BYTES_PER_SECOND / 10) this.upstream?.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.alloc(BYTES_PER_SECOND / 10 - this.segmentBytes).toString("base64") }));
      this.commits.push(segment);
      this.upstream?.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    } else {
      this.jobs.push({ audio: Buffer.concat(this.chunks), segment });
      this.pump();
    }
    this.chunks = [];
    this.segmentBytes = this.silenceBytes = 0;
    this.speech = false;
  }

  private pump() {
    while (!this.closed && this.activeJobs < 2 && this.jobs.length) {
      const job = this.jobs.shift()!;
      this.activeJobs++;
      void transcribe(this.config, job.audio, DICTATION_RATE, this.options.fetch, this.abort.signal)
        .then((text) => {
          if (this.closed) return;
          job.segment.text = text;
          job.segment.done = true;
          this.publish();
        })
        .catch(() => { if (!this.closed) this.fail("Transcription failed. Please try again or check the service settings."); })
        .finally(() => { this.activeJobs--; this.pump(); });
    }
  }

  private upstreamEvent(event: Event) {
    const id = typeof event.item_id === "string" ? event.item_id : "";
    if (event.type === "input_audio_buffer.committed") {
      const segment = this.commits.shift();
      if (!segment || !id) { this.fail("Unexpected transcription sequence."); return; }
      const draft = this.items.get(id);
      if (draft) { segment.text = draft.text; segment.done = draft.done; }
      segment.id = id;
      this.items.set(id, segment);
      this.publish();
    } else if (event.type === "conversation.item.input_audio_transcription.delta" || event.type === "conversation.item.input_audio_transcription.completed") {
      let segment = this.items.get(id);
      if (!segment) { segment = { text: "", done: false, id }; this.items.set(id, segment); }
      if (event.type.endsWith(".completed")) { segment.text = String(event.transcript ?? ""); segment.done = true; }
      else if (!segment.done) segment.text += String(event.delta ?? "");
      this.publish();
    } else if (event.type === "error" || event.type === "conversation.item.input_audio_transcription.failed") this.fail("The transcription service could not process this recording.");
  }

  private text() {
    // Do not expose a later phrase before an earlier result has arrived.
    const parts: string[] = [];
    for (const segment of this.segments) {
      if (segment.text.trim()) parts.push(segment.text.trim());
      if (!segment.done) break;
    }
    // Live transcription can start before commit acknowledges an item.
    if (this.mode === "realtime" && this.config.model === "gpt-live-transcribe") {
      for (const segment of this.items.values()) if (!this.segments.includes(segment) && segment.text.trim()) parts.push(segment.text.trim());
    }
    return parts.join(" ");
  }

  private publish() {
    if (this.closed) return;
    const text = this.text();
    if (text && this.firstText === null) this.firstText = Date.now() - this.started;
    if (this.finishing && this.segments.every((s) => s.done)) {
      this.options.log({ mode: this.mode, audioMs: this.totalBytes / BYTES_PER_SECOND * 1000, firstTextMs: this.firstText, finishMs: Date.now() - this.stopped });
      this.send({ type: "done", text });
      this.close();
    } else this.send({ type: "partial", text });
  }

  private finish() {
    if (this.finishing || this.closed) return;
    if (this.mode === "connecting") { this.fail("Voice session is still connecting."); return; }
    this.finishing = true;
    this.stopped = Date.now();
    if (this.speech) this.commit();
    else this.clearAudio();
    this.deadline = setTimeout(() => this.fail("Timed out waiting for transcription."), 120_000);
    this.publish();
  }
  private send(event: Event) {
    if (this.client.readyState === WebSocket.OPEN) {
      if (this.client.bufferedAmount > 1024 * 1024) { this.close(); return; }
      this.client.send(JSON.stringify(event));
    }
  }
  private fail(message: string) {
    if (this.closed) return;
    this.send({ type: "error", message, text: this.text() });
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.deadline);
    this.abort.abort();
    this.upstream?.terminate();
    this.chunks = [];
    this.jobs = [];
    this.client.close();
    this.options.closed();
  }
}
class Unavailable extends Error {}
