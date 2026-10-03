// Receives Web Push and shows it. Nothing else: no caching, no offline mode.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* a payload we cannot read still deserves a ping: iOS revokes a push that shows nothing */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "kohlab", {
      body: data.body || "",
      tag: data.tag || "kohlab",
      icon: "/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ("focus" in w) {
          w.focus();
          if ("navigate" in w) return w.navigate(url);
          return;
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
