// Service worker de la app de la familia: recibe los avisos push aunque la app esté cerrada.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'Tata', body: e.data ? e.data.text() : '' }; }
  const urgent = d.kind === 'alert';
  e.waitUntil(self.registration.showNotification(d.title || 'Tata', {
    body: d.body || '', tag: d.tag, renotify: true, requireInteraction: urgent,
    vibrate: urgent ? [400, 150, 400, 150, 400] : [120], icon: '/shared/icon.svg', badge: '/shared/icon.svg',
    data: { url: d.url || '/familia/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/familia/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.includes('/familia/'));
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
