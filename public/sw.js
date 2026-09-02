self.addEventListener("push", (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.body,
    icon: data.icon || "/icon.svg",
    badge: "/icon.svg",
    tag: data.tag || "luigi-notification",
    renotify: Boolean(data.renotify),
    data: {
      url: data.url || "/",
    },
  };

  event.waitUntil(self.registration.showNotification(data.title || "Luigi", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const existingWindow = windows.find((windowClient) => windowClient.url === targetUrl);
      if (existingWindow) return existingWindow.focus();
      return clients.openWindow(targetUrl);
    }),
  );
});
