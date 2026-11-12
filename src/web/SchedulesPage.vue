<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { HostState, ProjectOption, ProviderOption } from "../shared/wire.ts";
import Icon from "./Icon.vue";
import { formatMessageTimestamp } from "./timeline-display.ts";

/** Scheduled agent runs on every host (Paseo's schedules): list, run now, pause, logs, create. */
const props = defineProps<{
  hosts: HostState[];
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}>();
const emit = defineEmits<{ back: []; openAgent: [key: string] }>();

interface Schedule {
  id: string;
  name: string | null;
  prompt: string;
  cadence: { type: string; expression: string; timezone?: string };
  target: { type: string; agentId?: string; config?: { provider?: string; model?: string; cwd?: string; title?: string | null } };
  status: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
}
interface Run { id: string; status: string; startedAt: string | null; endedAt: string | null; agentId: string | null; output: string | null; error: string | null }

const groups = ref<{ hostId: string; schedules: Schedule[]; error: string | null }[] | null>(null);
const error = ref("");
const busy = ref<string | null>(null);
const label = (id: string) => props.hosts.find((h) => h.id === id)?.label ?? "Unknown host";
async function load() {
  try {
    groups.value = await props.api("/schedules");
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);
const rows = computed(() => (groups.value ?? []).flatMap((g) => g.schedules.map((s) => ({ hostId: g.hostId, s }))));
const failures = computed(() => (groups.value ?? []).filter((g) => g.error));

async function act(hostId: string, s: Schedule, what: "run" | "pause" | "resume" | "delete") {
  if (what === "delete" && !confirm(`Delete the schedule “${s.name || s.prompt.slice(0, 40)}”?`)) return;
  busy.value = s.id;
  try {
    await props.api(`/hosts/${encodeURIComponent(hostId)}/schedules/${encodeURIComponent(s.id)}${what === "delete" ? "" : "/" + what}`, what === "delete" ? "DELETE" : "POST");
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}

// ---- run history ------------------------------------------------------------------------------
const openLogs = ref<string | null>(null);
const runs = ref<Run[]>([]);
async function toggleLogs(hostId: string, s: Schedule) {
  if (openLogs.value === s.id) return (openLogs.value = null);
  openLogs.value = s.id;
  runs.value = [];
  try {
    runs.value = (await props.api(`/hosts/${encodeURIComponent(hostId)}/schedules/${encodeURIComponent(s.id)}/logs`)).runs;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// ---- cadence ----------------------------------------------------------------------------------
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Common cron shapes in words; anything else is shown as the expression itself. */
function describe(expression: string) {
  const [min, hour, dom, mon, dow] = expression.trim().split(/\s+/);
  const at = (h: string, m: string) => `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*") {
    if (dow === "*") return `Every day at ${at(hour, min)}`;
    if (dow === "1-5") return `Weekdays at ${at(hour, min)}`;
    if (/^\d$/.test(dow)) return `Every ${DAYS[Number(dow) % 7]} at ${at(hour, min)}`;
  }
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `Every hour at :${min.padStart(2, "0")}`;
  const every = /^\*\/(\d+)$/.exec(min);
  if (every && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `Every ${every[1]} minutes`;
  return expression;
}
const when = (iso: string | null) => (iso ? formatMessageTimestamp(new Date(iso)) : "—");

// ---- create -----------------------------------------------------------------------------------
const creating = ref(false);
const form = ref({ hostId: "", cwd: "", provider: "", model: "", name: "", prompt: "", preset: "daily", time: "09:00", day: "1", cron: "0 9 * * *", archive: true, runNow: false });
const providers = ref<ProviderOption[] | null>(null);
const projects = ref<ProjectOption[] | null>(null);
const connected = computed(() => props.hosts.filter((h) => h.state === "connected"));
watch(() => form.value.hostId, async (id) => {
  providers.value = projects.value = null;
  if (!id) return;
  try {
    const [p, j] = await Promise.all([props.api(`/hosts/${encodeURIComponent(id)}/providers`), props.api(`/hosts/${encodeURIComponent(id)}/projects`)]);
    providers.value = p;
    projects.value = j;
    form.value.provider ||= p.find((x: ProviderOption) => x.status === "ready")?.id ?? p[0]?.id ?? "";
    form.value.cwd ||= j[0]?.rootPath ?? "";

  } catch (e) {
    error.value = (e as Error).message;
  }
});
/** An edited schedule may point at a directory the project list does not show. */
const projectChoices = computed(() => {
  const list = projects.value ?? [];
  const cwd = form.value.cwd;
  return cwd && !list.some((p) => p.rootPath === cwd)
    ? [{ key: cwd, name: cwd.split("/").pop() || cwd, rootPath: cwd, kind: "directory" }, ...list]
    : list;
});
const models = computed(() => providers.value?.find((p) => p.id === form.value.provider)?.models ?? []);
watch(models, (list) => {
  if (!list.some((m) => m.id === form.value.model)) form.value.model = list.find((m) => m.isDefault)?.id ?? list[0]?.id ?? "";
});
const cron = computed(() => {
  const [h, m] = form.value.time.split(":").map((x) => String(Number(x) || 0));
  if (form.value.preset === "daily") return `${m} ${h} * * *`;
  if (form.value.preset === "weekdays") return `${m} ${h} * * 1-5`;
  if (form.value.preset === "weekly") return `${m} ${h} * * ${form.value.day}`;
  if (form.value.preset === "hourly") return `${m} * * * *`;
  return form.value.cron.trim();
});
const editing = ref<{ hostId: string; id: string; newAgent: boolean } | null>(null);
function startCreate() {
  editing.value = null;
  creating.value = true;
  form.value.hostId ||= connected.value[0]?.id ?? "";
}
/** Reads a cron expression back into the simple repeat options when it fits one. */
function presetOf(expression: string) {
  const [min, hour, dom, mon, dow] = expression.trim().split(/\s+/);
  const time = (h: string, m: string) => `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  const simple = /^\d+$/.test(min) && dom === "*" && mon === "*";
  if (simple && /^\d+$/.test(hour) && dow === "*") return { preset: "daily", time: time(hour, min) };
  if (simple && /^\d+$/.test(hour) && dow === "1-5") return { preset: "weekdays", time: time(hour, min) };
  if (simple && /^\d+$/.test(hour) && /^\d$/.test(dow)) return { preset: "weekly", time: time(hour, min), day: String(Number(dow) % 7) };
  if (simple && hour === "*" && dow === "*") return { preset: "hourly", time: time("0", min) };
  return { preset: "cron", cron: expression };
}
function startEdit(hostId: string, s: Schedule) {
  const config = s.target.config ?? {};
  editing.value = { hostId, id: s.id, newAgent: s.target.type === "new-agent" };
  creating.value = true;
  form.value = {
    ...form.value,
    hostId,
    cwd: config.cwd ?? "",
    provider: config.provider ?? "",
    model: config.model ?? "",
    name: s.name ?? "",
    prompt: s.prompt,
    cron: s.cadence.expression,
    archive: (config as { archiveOnFinish?: boolean }).archiveOnFinish ?? true,
    runNow: false,
    ...presetOf(s.cadence.expression),
  };
  timezone.value = s.cadence.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  openLogs.value = null;
  void nextTick(() => document.querySelector(".schedule-form")?.scrollIntoView({ block: "nearest" }));
}
const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone);
function cancelForm() {
  creating.value = false;
  editing.value = null;
  timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
}
async function save() {
  if (!editing.value) return create();
  const { hostId, id, newAgent } = editing.value;
  busy.value = "create";
  try {
    await props.api(`/hosts/${encodeURIComponent(hostId)}/schedules/${encodeURIComponent(id)}`, "PATCH", {
      name: form.value.name || null,
      prompt: form.value.prompt,
      cron: cron.value,
      timezone: timezone.value,
      ...(newAgent
        ? { cwd: form.value.cwd, provider: form.value.provider, model: form.value.model || null, archiveOnFinish: form.value.archive }
        : {}),
    });
    cancelForm();
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}
async function create() {
  busy.value = "create";
  try {
    await props.api(`/hosts/${encodeURIComponent(form.value.hostId)}/schedules`, "POST", {
      name: form.value.name || undefined,
      prompt: form.value.prompt,
      cron: cron.value,
      timezone: timezone.value,
      cwd: form.value.cwd,
      provider: form.value.provider,
      ...(form.value.model ? { model: form.value.model } : {}),
      archiveOnFinish: form.value.archive,
      runOnCreate: form.value.runNow,
    });
    creating.value = false;
    form.value.prompt = form.value.name = "";
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <button class="icon-btn back" aria-label="Back" @click="emit('back')"><Icon name="back" :size="18" /></button>
      <div class="grow">
        <h1>Schedules</h1>
        <p class="subtle">Prompts that start an agent on a timetable, on each host.</p>
      </div>
      <button class="btn btn-primary" :disabled="!connected.length" @click="startCreate"><Icon name="plus" :size="15" />New schedule</button>
    </header>
    <div class="page-body">
      <p v-if="error" class="setting-note is-error">{{ error }}</p>
      <p v-for="f in failures" :key="f.hostId" class="setting-note">{{ label(f.hostId) }}: {{ f.error }}</p>

      <form v-if="creating" class="card form-card schedule-form" @submit.prevent="save">
        <div class="row-title">{{ editing ? "Edit schedule" : "New schedule" }}</div>
        <div v-if="!editing || editing.newAgent" class="field-grid">
          <label class="field"><span>Host</span>
            <select v-model="form.hostId" required :disabled="!!editing" :title="editing ? 'A schedule stays on its host' : undefined">
              <option v-for="h in connected" :key="h.id" :value="h.id">{{ h.label }}</option>
            </select>
          </label>
          <label class="field"><span>Project</span>
            <select v-model="form.cwd" required :disabled="!projects">
              <option v-for="p in projectChoices" :key="p.key" :value="p.rootPath">{{ p.name }}</option>
            </select>
          </label>
          <label class="field"><span>Agent</span>
            <select v-model="form.provider" required :disabled="!providers">
              <option v-for="p in providers ?? []" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </label>
          <label class="field"><span>Model</span>
            <select v-model="form.model" :disabled="!models.length">
              <option v-for="m in models" :key="m.id" :value="m.id">{{ m.label }}</option>
            </select>
          </label>
        </div>
        <label class="field"><span>Name</span><input v-model="form.name" placeholder="Daily check-in" maxlength="120" /></label>
        <label class="field"><span>Prompt</span><textarea v-model="form.prompt" rows="4" required placeholder="What should the agent do each time?"></textarea></label>
        <div class="field-grid">
          <label class="field"><span>Repeat</span>
            <select v-model="form.preset">
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Every week</option>
              <option value="hourly">Every hour</option>
              <option value="cron">Custom (cron)</option>
            </select>
          </label>
          <label v-if="form.preset === 'weekly'" class="field"><span>Day</span>
            <select v-model="form.day"><option v-for="(d, i) in DAYS" :key="d" :value="String(i)">{{ d }}</option></select>
          </label>
          <label v-if="form.preset !== 'cron'" class="field"><span>{{ form.preset === "hourly" ? "Minute" : "Time" }}</span><input v-model="form.time" type="time" required /></label>
          <label v-else class="field"><span>Cron</span><input v-model="form.cron" placeholder="0 9 * * 1-5" required /></label>
        </div>
        <p class="subtle small">{{ describe(cron) }} · {{ timezone }}</p>
        <label v-if="!editing || editing.newAgent" class="check-row"><input v-model="form.archive" type="checkbox" /> Archive the agent when the run finishes</label>
        <label v-if="!editing" class="check-row"><input v-model="form.runNow" type="checkbox" /> Run once now</label>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" @click="cancelForm">Cancel</button>
          <button class="btn btn-primary" :disabled="busy === 'create' || !form.prompt.trim() || ((!editing || editing.newAgent) && !form.cwd)">
            {{ editing ? "Save changes" : "Create schedule" }}
          </button>
        </div>
      </form>

      <div v-if="!groups" class="timeline-empty"><span class="spinner"></span>Loading schedules…</div>
      <div v-else-if="!rows.length && !creating" class="schedules-empty">
        <Icon name="clock" :size="22" />
        <p>No schedules yet.</p>
      </div>
      <div v-else class="card">
        <div v-for="{ hostId, s } in rows" :key="hostId + s.id" class="schedule">
          <div class="card-row">
            <span class="setting-icon" :class="{ paused: s.status !== 'active' }"><Icon name="clock" :size="16" /></span>
            <div class="grow">
              <div class="row-title">{{ s.name || s.target.config?.title || s.prompt.slice(0, 60) }}</div>
              <div class="row-sub">
                {{ describe(s.cadence.expression) }}
                <template v-if="s.cadence.timezone"> · {{ s.cadence.timezone }}</template>
                · {{ label(hostId) }}
                <template v-if="s.target.config?.cwd"> · {{ s.target.config.cwd.split("/").pop() }}</template>
              </div>
              <div class="row-sub">
                <template v-if="s.status === 'active'">Next {{ when(s.nextRunAt) }}</template>
                <span v-else class="schedule-status">{{ s.status }}</span>
                · Last {{ when(s.lastRunAt) }}
              </div>
            </div>
            <div class="schedule-actions">
              <button class="icon-btn" title="Run now" aria-label="Run now" :disabled="busy === s.id" @click="act(hostId, s, 'run')"><Icon name="play" :size="14" /></button>
              <button v-if="s.status === 'active'" class="icon-btn" title="Pause" aria-label="Pause" :disabled="busy === s.id" @click="act(hostId, s, 'pause')"><Icon name="pause" :size="14" /></button>
              <button v-else class="icon-btn" title="Resume" aria-label="Resume" :disabled="busy === s.id" @click="act(hostId, s, 'resume')"><Icon name="refresh" :size="14" /></button>
              <button class="icon-btn" title="Edit" aria-label="Edit schedule" :disabled="busy === s.id" @click="startEdit(hostId, s)"><Icon name="edit" :size="14" /></button>
              <button class="icon-btn" title="Run history" aria-label="Run history" :aria-expanded="openLogs === s.id" @click="toggleLogs(hostId, s)"><Icon name="list" :size="14" /></button>
              <button class="icon-btn" title="Delete" aria-label="Delete schedule" :disabled="busy === s.id" @click="act(hostId, s, 'delete')"><Icon name="trash" :size="14" /></button>
            </div>
          </div>
          <div v-if="openLogs === s.id" class="schedule-runs">
            <p class="schedule-prompt">{{ s.prompt }}</p>
            <p v-if="!runs.length" class="subtle small">No runs yet.</p>
            <div v-for="r in runs" :key="r.id" class="schedule-run" :class="'is-' + r.status">
              <span class="status-dot" :class="r.status === 'failed' ? 'is-error' : r.status === 'running' ? 'is-running' : 'is-idle-ok'"></span>
              <span class="run-when">{{ when(r.startedAt) }}</span>
              <span class="run-text">{{ r.error || r.output || r.status }}</span>
              <button v-if="r.agentId" class="btn btn-ghost btn-sm" @click="emit('openAgent', `${hostId}:${r.agentId}`)">Open</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.schedule + .schedule { border-top: 1px solid var(--border); }
.schedule-actions { display: flex; gap: 2px; }
.schedule-actions .icon-btn { width: 30px; height: 30px; }
.setting-icon.paused { opacity: 0.5; }
.schedule-status { text-transform: capitalize; color: var(--warn); }
.schedule-runs { padding: 0 16px 14px 60px; display: grid; gap: 6px; }
.schedule-prompt { margin: 0 0 4px; padding: 8px 10px; border-radius: 8px; background: var(--surface-2); font-size: 12.5px; white-space: pre-wrap; color: var(--fg-muted); }
.schedule-run { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.run-when { flex: none; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.run-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-muted); }
.schedule-run.is-failed .run-text { color: var(--danger); }
.schedules-empty { display: grid; justify-items: center; gap: 6px; padding: 48px 0; color: var(--fg-muted); }
.check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; justify-self: start; }
.check-row input { flex: none; width: auto; height: auto; margin: 0; }
.btn-sm { height: 26px; padding: 0 8px; font-size: 12px; }
</style>
