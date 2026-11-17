// LitePaseo service worker: delivers push notifications and opens the right session on tap.
// It deliberately caches nothing: every screen is live data from the console server.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message;
  try {
    message = event.data ? event.data.json() : null;
  } catch {
    message = null;
  }
  if (!message) return;
  event.waitUntil(
    (async () => {
      if (typeof message.badge === "number" && self.navigator.setAppBadge) {
        await (message.badge > 0 ? self.navigator.setAppBadge(message.badge) : self.navigator.clearAppBadge()).catch(() => {});
      }
      // Notifications share a tag per project: fold this event into the one already showing.
      const shown =
        message.session && self.registration.getNotifications
          ? await self.registration.getNotifications({ tag: message.tag }).catch(() => [])
          : [];
      const { title, options } = mergeNotification(shown[0]?.data?.events ?? [], message);
      await self.registration.showNotification(title, options);
    })(),
  );
});

const MAX_LINES = 5;
const LABELS = { attention: "Needs input", "turn-done": "Finished", "turn-failed": "Failed" };

/**
 * One notification per project, holding the latest event of each conversation, newest first.
 * A single conversation keeps the plain title and body. The phone alerts again only for the
 * project's first event or one that needs the user; later turn ends update it silently.
 */
function mergeNotification(previous, message) {
  const base = { icon: "/icons/icon-192.png", badge: "/icons/badge-96.png", tag: message.tag };
  if (!message.session) {
    return {
      title: message.title,
      options: { ...base, body: message.body, renotify: true, data: { url: message.url }, requireInteraction: message.kind === "attention" },
    };
  }
  const event = {
    session: message.session,
    kind: message.kind,
    url: message.url,
    conversation: message.conversation || "",
    detail: message.detail || message.body,
  };
  const events = [event, ...previous.filter((e) => e && e.session !== event.session)].slice(0, 20);
  const alert = previous.length === 0 || message.kind === "attention";
  const waiting = events.filter((e) => e.kind === "attention");
  // Tapping opens the conversation that waits for the user, else the newest one.
  const data = { url: (waiting[0] ?? event).url, events };
  const options = { ...base, renotify: alert, silent: !alert, data, requireInteraction: waiting.length > 0 };
  if (events.length === 1) return { title: message.title, options: { ...options, body: message.body } };
  const lines = events
    .slice(0, MAX_LINES)
    .map((e) => `${LABELS[e.kind] ?? "Update"} · ${e.conversation ? `${e.conversation}: ` : ""}${e.detail}`);
  if (events.length > MAX_LINES) lines.push(`+${events.length - MAX_LINES} more`);
  const status = waiting.length ? `${waiting.length} need${waiting.length === 1 ? "s" : ""} input` : "updates";
  const title = `${message.project || "LitePaseo"} · ${events.length} conversations, ${status}`;
  const host = message.host ? `\n— ${message.host}` : "";
  return { title, options: { ...options, body: lines.join("\n") + host } };
}

self.mergeNotification = mergeNotification;

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin);
  const key = url.searchParams.get("session");
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== url.origin) continue;
        await client.focus();
        if (key) client.postMessage({ type: "open-session", key });
        return;
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
