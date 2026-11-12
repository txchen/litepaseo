<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import Icon from "./Icon.vue";

/**
 * Voice input through the transcription service configured in LitePaseo Settings (the same for
 * every host). Records 16 kHz mono PCM while the button is on (nothing runs otherwise), then
 * posts the clip once for transcription.
 */
defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ text: [text: string]; notice: [text: string] }>();

const RATE = 16_000;
const MAX_SECONDS = 300;
const state = ref<"idle" | "recording" | "transcribing">("idle");
const seconds = ref(0);
const supported = typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;

let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let node: ScriptProcessorNode | null = null;
let chunks: Int16Array[] = [];
let samples = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let inputRate = RATE;

/** Linear downsampling to 16 kHz and float → int16; the clip is speech, so this is plenty. */
function convert(input: Float32Array) {
  const step = inputRate / RATE;
  const length = Math.floor(input.length / step);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, input[Math.floor(i * step)]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function release() {
  clearInterval(timer);
  node?.disconnect();
  node = null;
  void context?.close().catch(() => {});
  context = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function start() {
  if (!supported) {
    emit("notice", "Voice input needs HTTPS (or localhost) and microphone access.");
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    emit("notice", "Microphone access was denied.");
    return;
  }
  try {
    context = new AudioContext({ sampleRate: RATE });
  } catch {
    context = new AudioContext(); // Some browsers refuse a custom rate; resample instead.
  }
  inputRate = context.sampleRate;
  const source = context.createMediaStreamSource(stream);
  node = context.createScriptProcessor(4096, 1, 1);
  chunks = [];
  samples = 0;
  node.onaudioprocess = (event) => {
    const pcm = convert(event.inputBuffer.getChannelData(0));
    chunks.push(pcm);
    samples += pcm.length;
    if (samples >= MAX_SECONDS * RATE) void stop();
  };
  source.connect(node);
  node.connect(context.destination);
  seconds.value = 0;
  timer = setInterval(() => seconds.value++, 1000);
  state.value = "recording";
}

async function stop() {
  if (state.value !== "recording") return;
  release();
  const audio = new Int16Array(samples);
  let offset = 0;
  for (const c of chunks) {
    audio.set(c, offset);
    offset += c.length;
  }
  chunks = [];
  if (samples < RATE / 2) {
    state.value = "idle";
    emit("notice", "Recording too short.");
    return;
  }
  state.value = "transcribing";
  try {
    const response = await fetch("/api/dictation/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-litepaseo": "1", "x-audio-format": `audio/pcm;rate=${RATE};bits=16` },
      body: audio.buffer,
      signal: AbortSignal.timeout(120_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? "Transcription failed");
    const text = String(data.text ?? "").trim();
    if (text) emit("text", text);
    else emit("notice", "No speech recognized.");
  } catch (e) {
    emit("notice", (e as Error).message);
  } finally {
    state.value = "idle";
  }
}

function cancel() {
  if (state.value !== "recording") return;
  release();
  chunks = [];
  state.value = "idle";
}
const toggle = () => (state.value === "recording" ? stop() : state.value === "idle" ? start() : undefined);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
defineExpose({ cancel });
onUnmounted(cancel);
</script>

<template>
  <button
    type="button"
    class="dictation"
    :class="'is-' + state"
    :disabled="disabled || state === 'transcribing'"
    :aria-label="state === 'recording' ? 'Stop recording and transcribe' : state === 'transcribing' ? 'Transcribing' : 'Voice input'"
    :title="state === 'recording' ? 'Stop and transcribe (Esc cancels)' : state === 'transcribing' ? 'Transcribing…' : 'Voice input'"
    @click="toggle"
    @keydown.esc.prevent="cancel"
  >
    <span v-if="state === 'transcribing'" class="spinner spinner-sm"></span>
    <template v-else-if="state === 'recording'"><span class="rec-dot"></span><span class="rec-time">{{ clock(seconds) }}</span></template>
    <Icon v-else name="mic" :size="17" />
  </button>
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
