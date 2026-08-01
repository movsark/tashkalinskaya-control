const CACHE_NAME = "tashkalinskaya-shell-v1";
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return cache.match(OFFLINE_URL);
    }),
  );
});

self.addEventListener("push", (event) => {
  let message = {
    body: "Откройте приложение для просмотра события.",
    notificationId: "unknown",
    severity: "NORMAL",
    title: "Ташкалинская",
    url: "/notifications",
  };
  try {
    if (event.data) message = { ...message, ...event.data.json() };
  } catch {
    // Поврежденный payload заменяется безопасным текстом без производственных деталей.
  }
  event.waitUntil(
    self.registration.showNotification(message.title, {
      badge: "/icon.svg",
      body: message.body,
      data: { notificationId: message.notificationId, url: message.url },
      icon: "/icon.svg",
      renotify: message.severity !== "NORMAL",
      requireInteraction: message.severity === "CRITICAL",
      tag: `factory-${message.notificationId}`,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.url || "/notifications";
  const target = `${self.location.origin}${path.startsWith("/") ? path : "/notifications"}`;
  event.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then((clients) => {
      const existing = clients.find((client) => client.url.startsWith(self.location.origin));
      if (existing) return existing.navigate(target).then(() => existing.focus());
      return self.clients.openWindow(target);
    }),
  );
});
