<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { safeGetItem, safeSetItem } from "./safe-storage.ts";

interface UsageWindow {
  id: string;
  label: string;
  shortLabel: string | null;
  remainingPct: number | null;
  resetsAt: string | null;
  durationSeconds?: number | null;
  runsOutAt?: string | null;
  shortfallPct?: number | null;
  summary?: boolean;
  tone: string | null;
}
interface UsageBalance {
  id: string;
  label: string;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  unit: "usd" | "credits" | "requests" | "tokens";
  resetsAt: string | null;
  tone: string | null;
}
interface UsageAccount {
  key: string;
  providerId?: string;
  name: string;
  plan: string | null;
  source: string | null;
  status: string;
  error: string | null;
  windows: UsageWindow[];
  balances?: UsageBalance[];
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
const editing = ref(false);

// ---- Persisted card order & visibility ---------------------------------------------------------
const PREF_KEY = "litepaseo-usage-prefs-v1";
interface UsagePrefs {
  order: string[];
  hidden: string[];
}
function loadPrefs(): UsagePrefs {
  try {
    const raw = safeGetItem(PREF_KEY);
    if (!raw) return { order: [], hidden: [] };
    const parsed = JSON.parse(raw) as Partial<UsagePrefs>;
    return {
      order: Array.isArray(parsed.order) ? parsed.order.filter((x): x is string => typeof x === "string") : [],
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    return { order: [], hidden: [] };
  }
}
const usagePrefs = reactive<UsagePrefs>(loadPrefs());
watch(usagePrefs, (v) => safeSetItem(PREF_KEY, JSON.stringify({ order: v.order, hidden: v.hidden })), { deep: true });

const accountId = (a: UsageAccount) => a.providerId ? `${a.providerId}|${a.plan ?? ""}|${a.source ?? ""}` : a.key;
const isHidden = (a: UsageAccount) => usagePrefs.hidden.includes(accountId(a));
function toggleHidden(a: UsageAccount) {
  const id = accountId(a);
  const idx = usagePrefs.hidden.indexOf(id);
  if (idx >= 0) usagePrefs.hidden.splice(idx, 1);
  else usagePrefs.hidden.push(id);
}
function moveAccount(a: UsageAccount, delta: -1 | 1) {
  const ids = allAccounts.value.map(accountId);
  const id = accountId(a);
  const idx = ids.indexOf(id);
  const next = idx + delta;
  if (idx < 0 || next < 0 || next >= ids.length) return;
  [ids[idx], ids[next]] = [ids[next]!, ids[idx]!];
  usagePrefs.order = ids;
}

const allAccounts = computed(() => {
  const list = (props.report?.accounts ?? []).filter((a) => a.windows.length || a.balances?.length || a.error);
  const rank = new Map(usagePrefs.order.map((id, i) => [id, i]));
  return [...list].sort((a, b) => {
    const ra = rank.get(accountId(a));
    const rb = rank.get(accountId(b));
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0;
  });
});
const visibleAccounts = computed(() => allAccounts.value.filter((a) => !isHidden(a)));
const shownInCard = computed(() => (editing.value ? allAccounts.value : visibleAccounts.value));

// ---- Formatting & quota forecast ---------------------------------------------------------------
function periodMs(w: UsageWindow) {
  if (typeof w.durationSeconds === "number" && w.durationSeconds > 0) return w.durationSeconds * 1000;
  const name = `${w.shortLabel ?? ""} ${w.label}`.toLowerCase();
  if (/5\s*h|5-hour|five/.test(name)) return 5 * 3600_000;
  if (/wk|week/.test(name)) return 7 * 86400_000;
  if (/month|mo\b/.test(name)) return 30 * 86400_000;
  return null;
}
function formatIn(ms: number) {
  const h = Math.floor(ms / 3600_000);
  const m = Math.max(1, Math.round((ms % 3600_000) / 60_000));
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function forecast(w: UsageWindow) {
  if (w.runsOutAt) {
    const ms = Date.parse(w.runsOutAt) - Date.now();
    if (Number.isFinite(ms)) {
      if (ms <= 0) return { text: "Exhausted at current pace", tone: "danger" };
      const resetMs = w.resetsAt ? Date.parse(w.resetsAt) - Date.now() : Infinity;
      if (ms < resetMs) {
        return {
          text: `Runs out in ${formatIn(ms)}`,
          tone: ms < 3 * 3600_000 || (w.shortfallPct ?? 0) >= 30 ? "danger" : "warning",
        };
      }
    }
  }
  const period = periodMs(w);
  if (w.remainingPct === null || !w.resetsAt || !period) return null;
  const left = Date.parse(w.resetsAt) - Date.now();
  const unit = period <= 5 * 3600_000 ? 3600_000 : 86400_000;
  if (left <= unit) return null;
  const perUnit = w.remainingPct / (left / unit);
  const even = 100 / (period / unit);
  const ratio = perUnit / even;
  return {
    text: `${perUnit.toFixed(perUnit < 10 ? 1 : 0)}% / ${unit === 3600_000 ? "hr" : "day"}`,
    tone: ratio >= 0.85 ? "ok" : ratio >= 0.5 ? "warning" : "danger",
  };
}
function level(w: UsageWindow) {
  if (w.tone === "danger" || w.tone === "warning" || w.tone === "ok") return w.tone;
  if (w.remainingPct === null) return "default";
  if (w.remainingPct < 10) return "danger";
  if (w.remainingPct < 30) return "warning";
  return "ok";
}
function resets(resetsAt: string | null) {
  if (!resetsAt) return "";
  const at = new Date(resetsAt);
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
  return `${day} ${clock} · in ${formatIn(ms)}`;
}
function formatUnit(value: number | null, unit: UsageBalance["unit"]) {
  if (value === null) return "—";
  if (unit === "usd") return `$${value.toFixed(value < 10 ? 2 : 1)}`;
  if (unit === "tokens") return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
function balancePct(b: UsageBalance) {
  if (b.limit && b.limit > 0) {
    const rem = b.remaining ?? (b.used !== null ? Math.max(0, b.limit - b.used) : null);
    if (rem !== null) return Math.max(0, Math.min(100, (rem / b.limit) * 100));
  }
  return null;
}
function balanceSummary(b: UsageBalance) {
  if (b.remaining !== null && b.limit !== null) return `${formatUnit(b.remaining, b.unit)} / ${formatUnit(b.limit, b.unit)}`;
  if (b.remaining !== null) return `${formatUnit(b.remaining, b.unit)} left`;
  if (b.used !== null && b.limit !== null) return `${formatUnit(b.used, b.unit)} / ${formatUnit(b.limit, b.unit)}`;
  if (b.used !== null) return `${formatUnit(b.used, b.unit)} used`;
  return "—";
}
const short = (w: UsageWindow) => w.shortLabel ?? w.label;
</script>

<template>
  <div v-if="allAccounts.length" class="usage">
    <button class="usage-summary" :aria-expanded="open" @click="open = !open">
      <template v-if="visibleAccounts.length">
        <span v-for="a in visibleAccounts" :key="a.key" class="usage-line">
          <span class="usage-name">{{ a.name }}</span>
          <span v-for="w in a.windows.slice(0, 3)" :key="w.id" class="usage-pct" :class="'tone-' + level(w)">
            {{ w.remainingPct === null ? "—" : Math.round(w.remainingPct) + "%" }}<small>{{ short(w) }}</small>
          </span>
          <span v-if="!a.windows.length && a.balances?.length" class="usage-pct tone-ok">
            {{ formatUnit(a.balances[0]!.remaining ?? a.balances[0]!.used, a.balances[0]!.unit) }}
          </span>
        </span>
      </template>
      <span v-else class="usage-line">
        <span class="usage-name">Usage</span>
        <span class="usage-pct">{{ allAccounts.length }} hidden</span>
      </span>
    </button>
    <div v-if="open" class="usage-card" role="dialog" aria-label="Usage limits">
      <header>
        <strong>Usage left</strong>
        <button
          class="icon-btn"
          :class="{ chosen: editing }"
          title="Reorder or hide usage sources"
          aria-label="Customize usage sources"
          :aria-pressed="editing"
          @click="editing = !editing"
        >
          <Icon name="sliders" :size="14" />
        </button>
        <button class="icon-btn" :disabled="loading" title="Refresh" aria-label="Refresh usage" @click="emit('refresh')">
          <span v-if="loading" class="spinner spinner-sm"></span><Icon v-else name="refresh" :size="14" />
        </button>
        <button class="icon-btn" aria-label="Close" @click="open = false; editing = false"><Icon name="close" :size="14" /></button>
      </header>
      <p v-if="!shownInCard.length" class="row-sub">All usage sources are hidden. Click the sliders icon to show them.</p>
      <section
        v-for="(a, idx) in shownInCard"
        :key="a.key"
        class="usage-account"
        :class="{ 'is-hidden-source': editing && isHidden(a) }"
      >
        <div class="usage-account-head">
          <span class="row-title">{{ a.name }}</span>
          <span class="row-sub">{{ [a.plan, a.hosts.join(", ")].filter(Boolean).join(" · ") }}</span>
          <div v-if="editing" class="usage-edit-actions">
            <button type="button" class="icon-btn" :disabled="idx === 0" title="Move up" aria-label="Move up" @click="moveAccount(a, -1)"><Icon name="arrow-up" :size="12" /></button>
            <button type="button" class="icon-btn" :disabled="idx === shownInCard.length - 1" title="Move down" aria-label="Move down" @click="moveAccount(a, 1)"><Icon name="arrow-down" :size="12" /></button>
            <button type="button" class="icon-btn" :title="isHidden(a) ? 'Show in summary' : 'Hide from summary'" :aria-label="isHidden(a) ? 'Show' : 'Hide'" @click="toggleHidden(a)">
              <Icon :name="isHidden(a) ? 'eye-off' : 'eye'" :size="13" />
            </button>
          </div>
        </div>
        <p v-if="a.error" class="row-sub is-error">{{ a.error }}</p>
        <div v-for="w in a.windows" :key="w.id" class="usage-window">
          <div class="usage-window-head">
            <span>{{ w.label }}</span>
            <strong :class="'tone-' + level(w)">{{ w.remainingPct === null ? "—" : Math.round(w.remainingPct) + "% left" }}</strong>
          </div>
          <div class="usage-bar"><span :class="'tone-' + level(w)" :style="{ width: Math.max(0, Math.min(100, w.remainingPct ?? 0)) + '%' }"></span></div>
          <div class="usage-window-foot">
            <span>{{ resets(w.resetsAt) }}</span>
            <span v-if="forecast(w)" :class="'tone-' + forecast(w)!.tone">{{ forecast(w)!.text }}</span>
          </div>
        </div>
        <div v-for="b in a.balances ?? []" :key="b.id" class="usage-window">
          <div class="usage-window-head">
            <span>{{ b.label }}</span>
            <strong :class="b.tone ? 'tone-' + b.tone : 'tone-ok'">{{ balanceSummary(b) }}</strong>
          </div>
          <div v-if="balancePct(b) !== null" class="usage-bar">
            <span :class="b.tone ? 'tone-' + b.tone : 'tone-ok'" :style="{ width: balancePct(b) + '%' }"></span>
          </div>
          <div v-if="b.resetsAt" class="usage-window-foot">
            <span>{{ resets(b.resetsAt) }}</span>
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
