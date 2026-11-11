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
      await self.registration.showNotification(message.title, {
        body: message.body,
        tag: message.tag,
        renotify: true,
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
        data: { url: message.url },
        requireInteraction: message.kind === "attention",
      });
    })(),
  );
});

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
