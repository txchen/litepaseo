import { watch, onUnmounted } from "vue";
/** Only the rendered foreground conversation grants a short cross-device quiet lease. */
export function trackViewingPresence(key: () => string | null, signedIn: () => boolean) {
  const tab = crypto.randomUUID();
  let seq = 0, lastKey: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  function report(leaving = false) {
    const current = !leaving && !document.hidden && document.hasFocus() ? key() : null;
    clearInterval(timer);
    if (!signedIn()) { lastKey = null; return; }
    if (current || lastKey) {
      void fetch('/api/presence', {
        method: 'PUT', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json', 'x-litepaseo': '1' },
        body: JSON.stringify({ tab, seq: ++seq, key: current }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {}); // Lost connections expire on the server; never block reading.
    }
    lastKey = current;
    if (current) timer = setInterval(report, 15000);
  }
  const changed = () => report();
  const leaving = () => report(true);
  watch(key, changed, { immediate: true, flush: 'post' });
  document.addEventListener('visibilitychange', changed);
  window.addEventListener('resize', changed);
  window.addEventListener('focus', changed);
  window.addEventListener('blur', changed);
  window.addEventListener('pagehide', leaving);
  window.addEventListener('pageshow', changed);
  onUnmounted(() => {
    leaving(); clearInterval(timer);
    document.removeEventListener('visibilitychange', changed);
    window.removeEventListener('resize', changed);
    window.removeEventListener('focus', changed); window.removeEventListener('blur', changed);
    window.removeEventListener('pagehide', leaving); window.removeEventListener('pageshow', changed);
  });
}
