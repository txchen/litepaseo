import { markRaw, shallowRef, type Component } from "vue";

/**
 * Markstream (~700 KB JS + its CSS) loads on demand instead of with the first page. Until it
 * arrives, messages render with the small built-in safe renderer, so nothing flashes raw.
 */
export const markstream = shallowRef<Component | null>(null);
let loading: Promise<void> | null = null;

export function loadMarkstream() {
  loading ??= import("./MarkdownMessage.vue")
    .then((module) => {
      markstream.value = markRaw(module.default);
    })
    .catch(() => {
      loading = null; // a failed chunk load retries on the next request; the fallback keeps working
    });
  return loading;
}

/** Warm the chunk once the app is idle after sign-in, before any message needs it. */
export function preloadMarkstream() {
  const idle = (window as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(() => void loadMarkstream(), { timeout: 3000 });
  else setTimeout(() => void loadMarkstream(), 1500);
}
