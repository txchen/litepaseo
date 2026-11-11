<script setup lang="ts">
import { computed, ref } from "vue";
import Icon from "./Icon.vue";

interface UsageWindow {
  id: string;
  label: string;
  shortLabel: string | null;
  remainingPct: number | null;
  resetsAt: string | null;
  tone: string | null;
}
interface UsageAccount {
  key: string;
  name: string;
  plan: string | null;
  source: string | null;
  status: string;
  error: string | null;
  windows: UsageWindow[];
  hosts: string[];
}
export interface UsageReport {
  fetchedAt: string | null;
  accounts: UsageAccount[];
  unavailableHosts: { hostId: string; label: string; error: string }[];
}

const props = defineProps<{ report: UsageReport | null; loading: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
const open = ref(false);

/** Window length, inferred from its name (5-hour, weekly, monthly), for the pace estimate. */
function periodMs(w: UsageWindow) {
  const name = `${w.shortLabel ?? ""} ${w.label}`.toLowerCase();
  if (/5\s*h|5-hour|five/.test(name)) return 5 * 3600_000;
  if (/wk|week/.test(name)) return 7 * 86400_000;
  if (/month|mo\b/.test(name)) return 30 * 86400_000;
  return null;
}
/**
 * Pace: what is left per day (per hour for a 5-hour window) until reset, against an even
 * split of the window. ≥85% of even pace is fine, below that ease off, below half it runs out.
 */
function pace(w: UsageWindow) {
  const period = periodMs(w);
  if (w.remainingPct === null || !w.resetsAt || !period) return null;
  const left = Date.parse(w.resetsAt) - Date.now();
  const unit = period <= 5 * 3600_000 ? 3600_000 : 86400_000;
  if (left <= unit) return null; // what is left is what you can use now
  const perUnit = w.remainingPct / (left / unit);
  const even = 100 / (period / unit);
  const ratio = perUnit / even;
  return {
    text: `${perUnit.toFixed(perUnit < 10 ? 1 : 0)}% per ${unit === 3600_000 ? "hour" : "day"}`,
    tone: ratio >= 0.85 ? "ok" : ratio >= 0.5 ? "warning" : "danger",
  };
}
function level(w: UsageWindow) {
  if (w.remainingPct === null) return "default";
  if (w.remainingPct < 10) return "danger";
  if (w.remainingPct < 30) return "warning";
  return "ok";
}
function resets(w: UsageWindow) {
  if (!w.resetsAt) return "";
  const at = new Date(w.resetsAt);
  const ms = at.getTime() - Date.now();
  if (ms <= 0) return "resetting";
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400_000);
  const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day =
    at.toDateString() === today.toDateString()
      ? "today"
      : at.toDateString() === tomorrow.toDateString()
        ? "tomorrow"
        : at.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" });
  const h = Math.floor(ms / 3600_000),
    m = Math.round((ms % 3600_000) / 60_000);
  const inText = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`;
  return `${day} ${clock} · in ${inText}`;
}
const accounts = computed(() => props.report?.accounts.filter((a) => a.windows.length || a.error) ?? []);
const short = (w: UsageWindow) => w.shortLabel ?? w.label;
</script>

<template>
  <div v-if="accounts.length" class="usage">
    <button class="usage-summary" :aria-expanded="open" @click="open = !open">
      <span v-for="a in accounts" :key="a.key" class="usage-line">
        <span class="usage-name">{{ a.name }}</span>
        <span v-for="w in a.windows.slice(0, 3)" :key="w.id" class="usage-pct" :class="'tone-' + level(w)">
          {{ w.remainingPct === null ? "—" : Math.round(w.remainingPct) + "%" }}<small>{{ short(w) }}</small>
        </span>
      </span>
    </button>
    <div v-if="open" class="usage-card" role="dialog" aria-label="Usage limits">
      <header>
        <strong>Usage left</strong>
        <button class="icon-btn" :disabled="loading" title="Refresh" aria-label="Refresh usage" @click="emit('refresh')">
          <span v-if="loading" class="spinner spinner-sm"></span><Icon v-else name="refresh" :size="14" />
        </button>
        <button class="icon-btn" aria-label="Close" @click="open = false"><Icon name="close" :size="14" /></button>
      </header>
      <section v-for="a in accounts" :key="a.key" class="usage-account">
        <div class="usage-account-head">
          <span class="row-title">{{ a.name }}</span>
          <span class="row-sub">{{ [a.plan, a.hosts.join(", ")].filter(Boolean).join(" · ") }}</span>
        </div>
        <p v-if="a.error" class="row-sub is-error">{{ a.error }}</p>
        <div v-for="w in a.windows" :key="w.id" class="usage-window">
          <div class="usage-window-head">
            <span>{{ w.label }}</span>
            <strong :class="'tone-' + level(w)">{{ w.remainingPct === null ? "—" : Math.round(w.remainingPct) + "% left" }}</strong>
          </div>
          <div class="usage-bar"><span :class="'tone-' + level(w)" :style="{ width: Math.max(0, Math.min(100, w.remainingPct ?? 0)) + '%' }"></span></div>
          <div class="usage-window-foot">
            <span>{{ resets(w) }}</span>
            <span v-if="pace(w)" :class="'tone-' + pace(w)!.tone">{{ pace(w)!.text }}</span>
          </div>
        </div>
      </section>
      <p v-for="h in report?.unavailableHosts ?? []" :key="h.hostId" class="row-sub">{{ h.label }}: {{ h.error }}</p>
      <p class="usage-foot">
        Updated {{ report?.fetchedAt ? new Date(report.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—" }}
        · hosts cache usage for 5 min
      </p>
    </div>
  </div>
</template>
