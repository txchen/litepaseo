<script setup lang="ts">
import { ref } from "vue";

/** Sign-in: the server's access token, plus an authenticator code when TOTP is on. */
defineProps<{
  /** null until the server says how this browser may sign in. */
  authInfo: { totp: boolean } | null;
  instanceLabel: string;
  busy: boolean;
  error: string;
}>();
const emit = defineEmits<{ login: [token: string, code: string] }>();
const token = ref(""),
  code = ref("");
function onCodeInput() {
  code.value = code.value.replace(/\D/g, "").slice(0, 6);
}
</script>

<template>
  <div class="login">
    <form v-if="authInfo" class="login-card" @submit.prevent="emit('login', token.trim(), code.trim())">
      <div class="brand brand-large"><img class="brand-mark" src="/icons/mark.svg" alt="" width="22" height="22" />{{ instanceLabel }}</div>
      <p class="login-lede">All your Paseo hosts, one fast console.</p>
      <label class="field">
        <span>Server access token</span>
        <input v-model="token" type="password" autocomplete="off" required autofocus />
      </label>
      <p class="hint">Run <code>litepaseo token</code> on the server to print it.</p>
      <template v-if="authInfo.totp">
        <label class="field">
          <span>Authenticator code</span>
          <input v-model="code" class="code-input" inputmode="numeric"
            autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}"
            placeholder="••••••" required @input="onCodeInput" />
        </label>
        <p class="hint">Both your access token and a code from your authenticator app are required.</p>
      </template>
      <button class="btn btn-primary btn-block" :disabled="busy">{{ busy ? "Signing in…" : "Connect" }}</button>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </form>
  </div>
</template>
