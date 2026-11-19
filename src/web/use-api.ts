import { ref, type Ref } from "vue";

/** A JSON request to this server's `/api`; child components receive it as their `api` prop. */
export type Api = (path: string, method?: string, body?: unknown, timeoutMs?: number) => Promise<any>;

/** The `/api` path of an agent. */
export function agentPath(a: { hostId: string; id: string }) {
  return `/hosts/${encodeURIComponent(a.hostId)}/agents/${encodeURIComponent(a.id)}`;
}
/** The `/api` path of a thread (a Paseo workspace). */
export function threadPath(w: { hostId: string; id: string }) {
  return `/hosts/${encodeURIComponent(w.hostId)}/workspaces/${encodeURIComponent(w.id)}`;
}

/**
 * The app's requests: `api` fetches, `action` runs a user action with the shared busy flag and
 * error toast. A 401 while signed in ends the session (except for the sign-in request itself).
 */
export function useApi({ authenticated, onUnauthorized }: { authenticated: Ref<boolean>; onUnauthorized: () => void }) {
  const busy = ref(false);
  const error = ref("");
  const api: Api = async (path, method = "GET", body, timeoutMs = 20000) => {
    const response = await fetch("/api" + path, {
      method,
      // Cookie session; the custom header marks the request as same-origin script (CSRF guard).
      headers: { "Content-Type": "application/json", "x-litepaseo": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && authenticated.value && path !== "/login") onUnauthorized();
    if (!response.ok) throw Object.assign(new Error((data.error ?? "Request failed") + (data.requestId ? ` (reference ${data.requestId})` : "")), { status: response.status, delivery: data.delivery, code: data.code, scope: data.scope });
    return data;
  };
  async function action(fn: () => Promise<void>) {
    busy.value = true;
    error.value = "";
    try {
      await fn();
    } catch (e) {
      error.value = String((e as Error).message);
    } finally {
      busy.value = false;
    }
  }
  return { api, action, busy, error };
}
