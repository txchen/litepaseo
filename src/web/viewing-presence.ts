import { watch, onUnmounted } from "vue";
import { newId } from "./id.ts";

/** Input within this long counts as someone using the page (a focused window alone does not). */
const IDLE_MS = 2 * 60_000;
const HEARTBEAT_MS = 15_000;
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * Reports to the server, on short leases: the rendered foreground conversation (a cross-device
 * quiet lease for its pushes) and whether someone is using this page (foreground, focused, with
 * input in the last 2 minutes), so pushes to other devices wait briefly while you are here.
 */
export function trackViewingPresence(key: () => string | null, signedIn: () => boolean) {
  const tab = newId();
  let seq = 0, lastKey: string | null = null, lastActive = false;
  let lastInput = Date.now();
  // One pending heartbeat at most: each report replaces it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  function report(leaving = false, forceRenew = false) {
    const foreground = !leaving && !document.hidden && document.hasFocus();
    const current = foreground ? key() : null;
    const active = foreground && Date.now() - lastInput < IDLE_MS;
    if (!signedIn()) {
      clearTimeout(timer);
      timer = undefined;
      lastKey = null;
      lastActive = false;
      return;
    }
    const stateChanged = current !== lastKey || active !== lastActive;
    // Unchanged state (e.g. window resize): keep the existing heartbeat deadline intact.
    if (!stateChanged && !forceRenew) {
      if ((current || active) && !timer) timer = setTimeout(() => report(false, true), HEARTBEAT_MS);
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    if ((stateChanged && (current || lastKey || active || lastActive)) || (forceRenew && (current || active))) {
      void fetch('/api/presence', {
        method: 'PUT', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json', 'x-litepaseo': '1' },
        body: JSON.stringify({ tab, seq: ++seq, key: current, active }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {}); // Lost connections expire on the server; never block reading.
    }
    lastKey = current;
    lastActive = active;
    if (current || active) timer = setTimeout(() => report(false, true), HEARTBEAT_MS);
  }
  const changed = () => report();
  const leaving = () => report(true);
  // Input only refreshes the idle clock; it reports at once only when the page was idle.
  const input = () => {
    lastInput = Date.now();
    if (!lastActive) report();
  };
  // Signing in reports at once: the page may be in use before any conversation is open.
  watch([key, signedIn], changed, { immediate: true, flush: 'post' });
  document.addEventListener('visibilitychange', changed);
  window.addEventListener('resize', changed);
  window.addEventListener('focus', changed);
  window.addEventListener('blur', changed);
  window.addEventListener('pagehide', leaving);
  window.addEventListener('pageshow', changed);
  for (const name of INPUT_EVENTS) window.addEventListener(name, input, { passive: true, capture: true });
  onUnmounted(() => {
    leaving(); clearTimeout(timer);
    document.removeEventListener('visibilitychange', changed);
    window.removeEventListener('resize', changed);
    window.removeEventListener('focus', changed); window.removeEventListener('blur', changed);
    window.removeEventListener('pagehide', leaving); window.removeEventListener('pageshow', changed);
    for (const name of INPUT_EVENTS) window.removeEventListener(name, input, { capture: true });
  });
}
