import { logEvent } from "./log-event.ts";

/**
 * Calls every listener with `args`. One that throws (or rejects) is logged and skipped: it can
 * neither stop delivery to the others nor surface as an unhandled rejection. The set is walked
 * live, as a plain `for…of` would, so listeners may unsubscribe themselves while being called.
 */
export function notifyListeners<A extends unknown[]>(listeners: Iterable<(...args: A) => unknown>, ...args: A) {
  for (const listener of listeners) {
    try {
      const result = listener(...args);
      if (result instanceof Promise) result.catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}

function failed(error: unknown) {
  logEvent("listener_failed", { message: String((error as Error)?.message ?? error).slice(0, 300) });
}
