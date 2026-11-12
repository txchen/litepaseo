import { ref, shallowRef } from "vue";
import { explainPushError, isBrave } from "./push-errors.ts";

type Request = (path: string, method?: string, body?: unknown) => Promise<any>;
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** Chromium's install prompt, captured so Settings can offer an Install button. */
export const installPrompt = shallowRef<InstallPromptEvent | null>(null);
export const installed = ref(isStandalone());
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt.value = event as InstallPromptEvent;
});
window.addEventListener("appinstalled", () => {
  installPrompt.value = null;
  installed.value = true;
});

export async function install() {
  const prompt = installPrompt.value;
  if (!prompt) return false;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  installPrompt.value = null;
  return outcome === "accepted";
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null;
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  registration ??= navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => null);
  return registration;
}

/**
 * Push availability on this device. iOS only offers Web Push to a site added to the Home
 * Screen, so a Safari tab reports "needs-install" rather than "unsupported".
 */
export function pushSupport(): "supported" | "needs-install" | "unsupported" | "insecure" {
  if (!window.isSecureContext) return "insecure";
  const capable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (capable) return "supported";
  return isIOS && !isStandalone() ? "needs-install" : "unsupported";
}

export async function currentSubscription() {
  const reg = await registerServiceWorker();
  return reg ? reg.pushManager.getSubscription() : null;
}

function keyBytes(base64url: string) {
  const padded = (base64url + "===".slice((base64url.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export interface PushPrefs {
  attention: boolean;
  turns: boolean;
}

/** Asks for permission (must run in a user gesture on iOS) and registers this device. */
export async function enablePush(request: Request, prefs: PushPrefs) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked for this site in your browser settings." : "Permission was not granted.");
  const reg = await registerServiceWorker();
  if (!reg) throw new Error("Service worker unavailable.");
  const { publicKey } = await request("/push/key");
  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    try {
      subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    } catch (error) {
      throw explainPushError(error, await isBrave());
    }
  }
  await request("/push/subscribe", "POST", { subscription: subscription.toJSON(), prefs });
  return subscription;
}

export async function updatePushPrefs(request: Request, subscription: PushSubscription, prefs: PushPrefs) {
  await request("/push/subscribe", "POST", { subscription: subscription.toJSON(), prefs });
}

export async function disablePush(request: Request) {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await request("/push/unsubscribe", "POST", { endpoint: subscription.endpoint }).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}

/** App icon badge (installed PWAs on iOS 16.4+, Chromium desktop/Android). */
export function setBadge(count: number) {
  const nav = navigator as { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (!nav.setAppBadge) return;
  void (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.())?.catch(() => {});
}

/** Swaps the tab icon for one with a status dot; one attribute write per state change. */
export function setFavicon(state: "" | "running" | "attention" | "unread") {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-status]');
  if (!link) {
    document.querySelectorAll('link[rel="icon"]').forEach((old) => old.remove());
    link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/png";
    link.dataset.status = "";
    document.head.appendChild(link);
  }
  const href = `/icons/favicon${state ? "-" + state : ""}-64.png`;
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
}
