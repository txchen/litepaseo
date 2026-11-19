<script setup lang="ts">
import { ref } from "vue";
import type { HostState } from "../shared/wire.ts";
import { confirmAction } from "./confirm.ts";
import Icon from "./Icon.vue";
import type { Api } from "./use-api.ts";

/** The Paseo daemons this console connects to: their state, settings, removal, and adding one. */
const props = defineProps<{
  hosts: HostState[];
  api: Api;
  /** Runs a request with the app's busy flag and error toast. */
  action: (fn: () => Promise<void>) => Promise<void>;
  busy: boolean;
}>();
const emit = defineEmits<{ back: []; settings: [host: HostState] }>();

const label = ref("");
const connection = ref("");
async function addHost() {
  await props.action(async () => {
    await props.api("/hosts", "POST", { label: label.value, connection: connection.value });
    label.value = "";
    connection.value = "";
  });
}
async function removeHost(host: HostState) {
  if (!(await confirmAction({ title: `Disconnect and remove ${host.label}?`, message: "Its agents keep running on the host.", confirmLabel: "Remove host", danger: true }))) return;
  await props.action(async () => void (await props.api("/hosts/" + encodeURIComponent(host.id), "DELETE")));
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <button class="icon-btn back" aria-label="Back" @click="emit('back')">
        <Icon name="back" :size="18" />
      </button>
      <div>
        <h1>Hosts</h1>
        <p class="subtle">Paseo daemons this console connects to. Secrets stay on this server.</p>
      </div>
    </header>
    <div class="page-body">
      <div class="card">
        <div v-for="h in hosts" :key="h.id" class="card-row">
          <span class="status-dot" :class="h.state === 'connected' ? 'is-idle-ok' : 'is-offline'"></span>
          <div class="grow">
            <div class="row-title">{{ h.label }}</div>
            <div class="row-sub">{{ h.state }}</div>
            <p v-if="h.diagnostic?.error" class="row-sub is-error" role="status">{{ h.diagnostic.error.message }}</p>
            <div v-if="h.diagnostic?.lastConnectedAt" class="row-sub">Last connected: {{ new Date(h.diagnostic.lastConnectedAt).toLocaleString() }}</div>
            <div v-if="h.diagnostic?.attempt" class="row-sub">Connection attempt {{ h.diagnostic.attempt }}</div>
            <div v-if="h.diagnostic?.nextRetryAt" class="row-sub">Next retry: {{ new Date(h.diagnostic.nextRetryAt).toLocaleString() }}</div>
          </div>
          <button class="btn btn-outline" :disabled="h.state !== 'connected'" @click="emit('settings', h)">Settings</button>
          <button class="btn btn-outline" :disabled="busy" @click="removeHost(h)">Remove</button>
        </div>
        <div v-if="!hosts.length" class="card-row muted-text">No hosts yet.</div>
      </div>
      <h2 class="section-label">Add a host</h2>
      <form class="card form-card" @submit.prevent="addHost">
        <label class="field">
          <span>Name</span>
          <input v-model="label" placeholder="Build server" required />
        </label>
        <label class="field">
          <span>Connection</span>
          <input
            v-model="connection"
            type="password"
            placeholder="ws://host:port/ws, pairing offer or SSH target"
            required
            autocomplete="off"
            aria-describedby="host-connection-help"
          />
        </label>
        <div id="host-connection-help" class="field-help">
          <p>
            The LitePaseo server connects to the daemon, so the address must be reachable from the
            server, not from this browser. The default daemon port is <code>6767</code>.
          </p>
          <details>
            <summary>Connection formats</summary>
            <dl>
              <dt>Same machine</dt>
              <dd><code>6767</code> or <code>127.0.0.1:6767</code></dd>
              <dt>Network address</dt>
              <dd><code>192.168.1.10:6767</code>, <code>tcp://host:6767</code>, <code>ws://host:6767/ws</code> or <code>wss://host/ws</code></dd>
              <dt>Daemon password</dt>
              <dd><code>ws://host:6767/ws?password=…</code></dd>
              <dt>SSH tunnel</dt>
              <dd>
                <code>ssh://user@host</code> or <code>ssh://user@host:2222?daemonPort=6767</code>. Key-based login
                only: the server's user must be able to run <code>ssh user@host</code> without a prompt.
              </dd>
              <dt>Pairing / relay</dt>
              <dd>Paste a pairing link from Paseo (containing <code>#connect=</code>) or a <code>relay://</code> URL.</dd>
              <dt>Local socket</dt>
              <dd><code>unix:///path/to/socket</code></dd>
            </dl>
          </details>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" :disabled="busy">Add host</button>
        </div>
      </form>
    </div>
  </section>
</template>
