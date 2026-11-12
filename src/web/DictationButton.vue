<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import Icon from "./Icon.vue";

// Only the active recording owns audio, a socket and a temporary transcript.
defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ text: [text: string]; preview: [text: string]; notice: [text: string] }>();
const RATE = 24_000;
const MAX_SECONDS = 300;
const state = ref<"idle" | "starting" | "recording" | "transcribing">("idle");
const seconds = ref(0);
const supported = typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let node: ScriptProcessorNode | null = null;
let socket: WebSocket | null = null;
let pending: Int16Array[] = [];
let pendingSamples = 0;
let samples = 0;
let ready = false;
let generation = 0;
let request: AbortController | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let inputRate = RATE;
let preview = "";

function convert(input: Float32Array) {
  const step = inputRate / RATE;
  const out = new Int16Array(Math.floor(input.length / step));
  for (let i = 0; i < out.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[Math.floor(i * step)]));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

function releaseAudio() {
  if (node) { node.onaudioprocess = null; node.disconnect(); }
  node = null;
  void context?.close().catch(() => {});
  context = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}
function cleanup() {
  generation++;
  releaseAudio();
  clearTimeout(deadline);
  request?.abort();
  request = undefined;
  if (socket) {
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    socket.close();
  }
  socket = null;
  pending = [];
  pendingSamples = 0;
  ready = false;
  state.value = "idle";
  preview = "";
  emit("preview", "");
}
function fail(message: string) {
  const text = preview.trim();
  cleanup();
  if (text) emit("text", text);
  emit("notice", message + (text ? " Recognized text was kept; the last phrase may be missing." : ""));
}
function flush() {
  if (!ready || socket?.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > RATE * 2 * 10) { fail("Voice upload cannot keep up with recording. Please try again."); return; }
  for (const chunk of pending) socket.send(chunk.buffer as ArrayBuffer);
  pending = [];
  pendingSamples = 0;
  if (state.value === "transcribing") socket.send(JSON.stringify({ type: "stop" }));
}

async function start() {
  if (state.value !== "idle") return;
  if (!supported) { emit("notice", "Voice input needs HTTPS (or localhost) and microphone access."); return; }
  state.value = "starting";
  const run = ++generation;
  try {
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    if (run !== generation) { microphone.getTracks().forEach((t) => t.stop()); return; }
    stream = microphone;
    try { context = new AudioContext({ sampleRate: RATE }); } catch { context = new AudioContext(); }
    await context.resume();
    if (run !== generation) return;
    inputRate = context.sampleRate;
    const source = context.createMediaStreamSource(stream);
    node = context.createScriptProcessor(4096, 1, 1);
    samples = 0;
    pending = [];
    pendingSamples = 0;
    node.onaudioprocess = (event) => {
      if (run !== generation || state.value !== "recording") return;
      const pcm = convert(event.inputBuffer.getChannelData(0)).subarray(0, MAX_SECONDS * RATE - samples);
      pending.push(pcm);
      pendingSamples += pcm.length;
      samples += pcm.length;
      if (pendingSamples > RATE * 12) { fail("Voice connection is taking too long. Please try again."); return; }
      flush();
      seconds.value = Math.floor(samples / RATE);
      if (samples >= MAX_SECONDS * RATE) stop();
    };
    source.connect(node);
    node.connect(context.destination);
    seconds.value = 0;
    state.value = "recording";
    // Capture immediately while the authenticated session connects; flush in order once ready.
    deadline = setTimeout(() => { if (run === generation) fail("Could not connect to the transcription service."); }, 12_000);
    request = new AbortController();
    const response = await fetch("/api/dictation/session", { method: "POST", headers: { "x-litepaseo": "1" }, signal: request.signal });
    const data = await response.json();
    if (run !== generation) return;
    if (!response.ok) throw new Error(data.error ?? "Could not start voice input.");
    const url = new URL("/api/dictation/stream", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", data.ticket);
    socket = new WebSocket(url);
    socket.onmessage = (message) => {
      if (run !== generation) return;
      try {
        const event = JSON.parse(message.data);
        if (event.type === "ready") {
          ready = true;
          clearTimeout(deadline);
          if (state.value === "transcribing") armFinishDeadline(run);
          flush();
        } else if (event.type === "partial") {
          preview = String(event.text ?? "");
          emit("preview", preview);
        }
        else if (event.type === "done") {
          const text = String(event.text ?? "").trim();
          cleanup();
          if (text) emit("text", text);
          else emit("notice", "No speech recognized.");
        } else if (event.type === "error") {
          const text = String(event.text ?? "").trim();
          cleanup();
          if (text) emit("text", text);
          emit("notice", String(event.message ?? "Transcription failed.") + (text ? " Recognized text was kept; the last phrase may be missing." : ""));
        }
      } catch { fail("Invalid transcription response."); }
    };
    socket.onerror = () => { if (run === generation) fail("Voice connection failed. Please try again."); };
    socket.onclose = () => { if (run === generation) fail("Voice connection interrupted. Please try again."); };
  } catch (error) {
    if (run !== generation) return;
    fail((error as Error).name === "NotAllowedError" ? "Microphone access was denied." : (error as Error).message);
  }
}
function armFinishDeadline(run: number) {
  clearTimeout(deadline);
  deadline = setTimeout(() => { if (run === generation) fail("Timed out waiting for transcription."); }, 125_000);
}
function stop() {
  if (state.value !== "recording") return;
  releaseAudio();
  if (samples < RATE / 5) { fail("Recording too short."); return; }
  state.value = "transcribing";
  if (ready) { armFinishDeadline(generation); flush(); }
}
function cancel() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel" }));
  cleanup();
}
const toggle = () => state.value === "recording" ? stop() : state.value === "idle" ? void start() : undefined;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
defineExpose({ cancel });
onUnmounted(cancel);
</script>

<template>
  <button
    type="button"
    class="dictation"
    :class="'is-' + state"
    :disabled="(disabled && state === 'idle') || state === 'transcribing' || state === 'starting'"
    :aria-label="state === 'recording' ? 'Stop recording and transcribe' : state === 'transcribing' ? 'Transcribing' : state === 'starting' ? 'Starting voice input' : 'Voice input'"
    :title="state === 'recording' ? 'Stop recording (Esc cancels)' : state === 'transcribing' ? 'Finishing transcription…' : 'Voice input'"
    @click="toggle"
    @keydown.esc.prevent="cancel"
  >
    <span v-if="state === 'transcribing' || state === 'starting'" class="spinner spinner-sm"></span>
    <template v-else-if="state === 'recording'"><span class="rec-dot"></span><span class="rec-time">{{ clock(seconds) }}</span></template>
    <Icon v-else name="mic" :size="17" />
  </button>
  <button v-if="state !== 'idle'" type="button" class="dictation" aria-label="Cancel voice input" title="Cancel voice input" @click="cancel">×</button>
</template>

<style scoped>
.dictation {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 34px;
  height: 34px;
  padding: 0 8px;
  border-radius: 999px;
  color: var(--fg-muted);
}
@media (hover: hover) {
  .dictation:hover:not(:disabled) {
    background: var(--hover);
    color: var(--fg);
  }
}
.dictation.is-recording {
  background: var(--danger-soft);
  color: var(--danger);
}
.rec-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger);
}
.rec-time {
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
.spinner-sm {
  margin: 0;
}
</style>
