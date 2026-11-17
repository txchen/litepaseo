import { watch, onUnmounted } from "vue";

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
  const tab = crypto.randomUUID();
  let seq = 0, lastKey: string | null = null, lastActive = false;
  let lastInput = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  function report(leaving = false) {
    const foreground = !leaving && !document.hidden && document.hasFocus();
    const current = foreground ? key() : null;
    const active = foreground && Date.now() - lastInput < IDLE_MS;
    clearInterval(timer);
    if (!signedIn()) { lastKey = null; lastActive = false; return; }
    if (current || lastKey || active || lastActive) {
      void fetch('/api/presence', {
        method: 'PUT', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json', 'x-litepaseo': '1' },
        body: JSON.stringify({ tab, seq: ++seq, key: current, active }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {}); // Lost connections expire on the server; never block reading.
    }
    lastKey = current;
    lastActive = active;
    if (current || active) timer = setInterval(report, HEARTBEAT_MS);
  }
  const changed = () => report();
  const leaving = () => report(true);
  // Input only refreshes the idle clock; it reports at once only when the page was idle.
  const input = () => {
    lastInput = Date.now();
    if (!lastActive) report();
  };
  watch(key, changed, { immediate: true, flush: 'post' });
  document.addEventListener('visibilitychange', changed);
  window.addEventListener('resize', changed);
  window.addEventListener('focus', changed);
  window.addEventListener('blur', changed);
  window.addEventListener('pagehide', leaving);
  window.addEventListener('pageshow', changed);
  for (const name of INPUT_EVENTS) window.addEventListener(name, input, { passive: true, capture: true });
  onUnmounted(() => {
    leaving(); clearInterval(timer);
    document.removeEventListener('visibilitychange', changed);
    window.removeEventListener('resize', changed);
    window.removeEventListener('focus', changed); window.removeEventListener('blur', changed);
    window.removeEventListener('pagehide', leaving); window.removeEventListener('pageshow', changed);
    for (const name of INPUT_EVENTS) window.removeEventListener(name, input, { capture: true });
  });
}
