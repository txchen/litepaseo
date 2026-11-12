/**
 * Turns the browser's push subscription failure into something a person can act on. Chromium
 * reports every failure to reach its push service with the same AbortError, "Registration
 * failed - push service error"; the usual cause depends on the browser.
 */
export const BRAVE_PUSH_HINT =
  "Brave turns push off by default. Open brave://settings/privacy, turn on " +
  "“Use Google services for push messaging”, restart Brave, and try again.";
export const PUSH_SERVICE_HINT =
  "This browser could not reach its push service. A proxy, VPN or firewall may block it, " +
  "or this browser build has no push service; Chrome, Edge or Firefox work.";

export function isPushServiceError(error: unknown) {
  const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
  return name === "AbortError" || /push service/i.test(String(message ?? ""));
}

export function explainPushError(error: unknown, brave: boolean): Error {
  if (!isPushServiceError(error)) return error instanceof Error ? error : new Error(String(error));
  return new Error(brave ? BRAVE_PUSH_HINT : PUSH_SERVICE_HINT, { cause: error });
}

/** Brave hides its name from the user agent but exposes `navigator.brave.isBrave()`. */
export async function isBrave(nav: unknown = globalThis.navigator) {
  const brave = (nav as { brave?: { isBrave?: () => Promise<boolean> } } | undefined)?.brave;
  try {
    return typeof brave?.isBrave === "function" && (await brave.isBrave()) === true;
  } catch {
    return false;
  }
}
