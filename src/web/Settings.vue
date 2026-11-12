<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import {
  currentSubscription,
  disablePush,
  enablePush,
  install,
  installed,
  installPrompt,
  isIOS,
  pushSupport,
  updatePushPrefs,
  type PushPrefs,
} from "./pwa.ts";

const props = defineProps<{
  request: (path: string, method?: string, body?: unknown) => Promise<any>;
  totpEnabled: boolean;
}>();
const emit = defineEmits<{ back: []; signedOut: []; totpChanged: [enabled: boolean] }>();

// ---- notifications ---------------------------------------------------------------------------
const support = pushSupport();
const subscription = ref<PushSubscription | null>(null);
const prefs = ref<PushPrefs>({ attention: true, turns: true });
const permission = ref(typeof Notification === "undefined" ? "default" : Notification.permission);
const pushBusy = ref(false);
const pushMessage = ref("");
const pushError = ref("");

async function refreshPush() {
  if (support !== "supported") return;
  subscription.value = await currentSubscription();
  if (!subscription.value) return;
  const status = await props.request("/push/status", "POST", { endpoint: subscription.value.endpoint });
  if (status.subscribed) prefs.value = status.prefs;
  else subscription.value = null; // registered in the browser but unknown to this server
}
async function pushAction(fn: () => Promise<void>) {
  pushBusy.value = true;
  pushError.value = pushMessage.value = "";
  try {
    await fn();
  } catch (e) {
    pushError.value = (e as Error).message;
  } finally {
    pushBusy.value = false;
    permission.value = typeof Notification === "undefined" ? "default" : Notification.permission;
  }
}
const turnOn = () =>
  pushAction(async () => {
    subscription.value = await enablePush(props.request, prefs.value);
    pushMessage.value = "Notifications are on for this device.";
  });
const turnOff = () =>
  pushAction(async () => {
    await disablePush(props.request);
    subscription.value = null;
  });
const savePrefs = () =>
  pushAction(async () => {
    if (subscription.value) await updatePushPrefs(props.request, subscription.value, prefs.value);
  });
const test = () =>
  pushAction(async () => {
    const { sent } = await props.request("/push/test", "POST", {});
    pushMessage.value = sent ? "Test sent. It should arrive in a few seconds." : "This device is not registered.";
  });

// ---- install ---------------------------------------------------------------------------------
const installing = ref(false);
async function installNow() {
  installing.value = true;
  try {
    await install();
  } finally {
    installing.value = false;
  }
}

// ---- security --------------------------------------------------------------------------------
type Device = { id: string; label: string; created: number; lastSeen: number; current: boolean };
const devices = ref<Device[]>([]);
const setup = ref<{ secret: string; qr: string } | null>(null);
const code = ref("");
const securityError = ref("");
const securityBusy = ref(false);

async function loadDevices() {
  devices.value = await props.request("/sessions");
}
async function securityAction(fn: () => Promise<void>) {
  securityBusy.value = true;
  securityError.value = "";
  try {
    await fn();
  } catch (e) {
    securityError.value = (e as Error).message;
  } finally {
    securityBusy.value = false;
  }
}
const beginTotp = () =>
  securityAction(async () => {
    setup.value = await props.request("/totp/setup", "POST", {});
    code.value = "";
  });
const confirmTotp = () =>
  securityAction(async () => {
    await props.request("/totp/confirm", "POST", { code: code.value.trim() });
    setup.value = null;
    code.value = "";
    emit("totpChanged", true);
  });
const disableTotp = () =>
  securityAction(async () => {
    await props.request("/totp/disable", "POST", { code: code.value.trim() });
    code.value = "";
    emit("totpChanged", false);
  });
const revoke = (device: Device) =>
  securityAction(async () => {
    await props.request("/sessions/" + device.id, "DELETE");
    if (device.current) emit("signedOut");
    else await loadDevices();
  });
const signOutEverywhere = () =>
  securityAction(async () => {
    if (!confirm("Sign out every device, including this one? Their notifications stop too.")) return;
    await props.request("/sessions/revoke-all", "POST", {});
    emit("signedOut");
  });

const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const permissionBlocked = computed(() => permission.value === "denied");

onMounted(() => {
  void refreshPush().catch(() => {});
  void loadDevices().catch(() => {});
});
</script>

<template>
  <section class="page">
    <header class="page-head">
      <button class="icon-btn back" aria-label="Back" @click="emit('back')"><Icon name="back" :size="18" /></button>
      <div>
        <h1>Settings</h1>
        <p class="subtle">Notifications, the app on your phone, and who can sign in.</p>
      </div>
    </header>
    <div class="page-body">
      <h2 class="section-label">Notifications</h2>
      <div class="card">
        <div class="card-row">
          <span class="setting-icon"><Icon name="bell" :size="16" /></span>
          <div class="grow">
            <div class="row-title">Push notifications</div>
            <div class="row-sub">
              <template v-if="support === 'insecure'">Needs HTTPS. Open the console through your tunnel's https:// address.</template>
              <template v-else-if="support === 'needs-install'">On iPhone and iPad, add LitePaseo to your Home Screen first, then open it from there.</template>
              <template v-else-if="support === 'unsupported'">This browser cannot receive push notifications.</template>
              <template v-else-if="permissionBlocked">Blocked in this browser's site settings. Allow notifications there, then return.</template>
              <template v-else-if="subscription">On for this device. Arrives even when the app is closed.</template>
              <template v-else>Get told when an agent needs you or a turn finishes, even with the app closed.</template>
            </div>
          </div>
          <button v-if="support === 'supported' && !subscription && !permissionBlocked" class="btn btn-primary" :disabled="pushBusy" @click="turnOn">
            Turn on
          </button>
          <button v-else-if="subscription" class="btn btn-outline" :disabled="pushBusy" @click="turnOff">Turn off</button>
        </div>
        <template v-if="subscription">
          <label class="card-row switch-row">
            <div class="grow">
              <div class="row-title">When an agent needs your input</div>
              <div class="row-sub">Permission requests and questions</div>
            </div>
            <input v-model="prefs.attention" class="switch" type="checkbox" :disabled="pushBusy" @change="savePrefs" />
          </label>
          <label class="card-row switch-row">
            <div class="grow">
              <div class="row-title">When a turn finishes</div>
              <div class="row-sub">Including failed turns</div>
            </div>
            <input v-model="prefs.turns" class="switch" type="checkbox" :disabled="pushBusy" @change="savePrefs" />
          </label>
          <div class="card-row">
            <div class="grow row-sub">Not sent while you are viewing that conversation.</div>
            <button class="btn btn-outline" :disabled="pushBusy" @click="test">Send a test</button>
          </div>
        </template>
      </div>
      <p v-if="pushMessage" class="setting-note">{{ pushMessage }}</p>
      <p v-if="pushError" class="setting-note is-error">{{ pushError }}</p>

      <h2 class="section-label">App</h2>
      <div class="card">
        <div class="card-row">
          <span class="setting-icon"><Icon name="phone" :size="16" /></span>
          <div class="grow">
            <div class="row-title">Install LitePaseo</div>
            <div class="row-sub">
              <template v-if="installed">Installed. You are using the app.</template>
              <template v-else-if="installPrompt">Full screen, its own icon, and notifications.</template>
              <template v-else-if="isIOS">In Safari, tap Share, then “Add to Home Screen”.</template>
              <template v-else>Use your browser's menu: “Install app” or “Add to Home screen”.</template>
            </div>
          </div>
          <button v-if="installPrompt && !installed" class="btn btn-primary" :disabled="installing" @click="installNow">Install</button>
        </div>
      </div>

      <h2 class="section-label">Sign-in</h2>
      <div class="card">
        <div class="card-row">
          <span class="setting-icon"><Icon name="shield" :size="16" /></span>
          <div class="grow">
            <div class="row-title">Authenticator code</div>
            <div class="row-sub">
              {{ totpEnabled ? "On. Sign in with your access token and a 6-digit authenticator code." : "Require an authenticator code in addition to your access token. Other browsers will need to sign in again." }}
            </div>
          </div>
          <button v-if="!totpEnabled && !setup" class="btn btn-outline" :disabled="securityBusy" @click="beginTotp">Set up</button>
        </div>
        <div v-if="setup" class="card-row totp-setup">
          <img :src="setup.qr" alt="Authenticator QR code" width="164" height="164" />
          <div class="grow">
            <p class="row-sub">Scan with Google Authenticator, 1Password, Authy or similar. Or enter this key:</p>
            <code class="secret">{{ setup.secret.match(/.{1,4}/g)?.join(" ") }}</code>
            <form class="code-form" @submit.prevent="confirmTotp">
              <input v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" aria-label="Code from your app" />
              <button class="btn btn-primary" :disabled="securityBusy || code.trim().length !== 6">Turn on</button>
              <button type="button" class="btn btn-ghost" @click="setup = null">Cancel</button>
            </form>
          </div>
        </div>
        <div v-if="totpEnabled" class="card-row">
          <form class="code-form grow" @submit.prevent="disableTotp">
            <input v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="Current code" aria-label="Current code" />
            <button class="btn btn-outline" :disabled="securityBusy || code.trim().length !== 6">Turn off</button>
          </form>
        </div>
      </div>
      <p v-if="securityError" class="setting-note is-error">{{ securityError }}</p>

      <h2 class="section-label">Signed-in devices</h2>
      <div class="card">
        <div v-for="d in devices" :key="d.id" class="card-row">
          <span class="setting-icon"><Icon :name="/iOS|Android/.test(d.label) ? 'phone' : 'monitor'" :size="16" /></span>
          <div class="grow">
            <div class="row-title">{{ d.label }}<span v-if="d.current" class="pill pill-current">This device</span></div>
            <div class="row-sub">Active {{ ago(d.lastSeen) }} · signed in {{ new Date(d.created).toLocaleDateString() }}</div>
          </div>
          <button class="btn btn-outline" :disabled="securityBusy" @click="revoke(d)">{{ d.current ? "Sign out" : "Revoke" }}</button>
        </div>
        <div v-if="!devices.length" class="card-row row-sub">Signed in with the access token only.</div>
      </div>
      <div class="form-actions spaced">
        <button class="btn btn-ghost" :disabled="securityBusy" @click="signOutEverywhere">Sign out everywhere</button>
      </div>
    </div>
  </section>
</template>
