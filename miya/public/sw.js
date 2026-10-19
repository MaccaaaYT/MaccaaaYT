// Service worker Мии: офлайн-оболочка приложения и push-уведомления.
const VERSION = 'miya-v1';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/js/app.js',
  '/js/api.js',
  '/js/voice.js',
  '/js/push.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/badge-96.png',
  '/icons/fox.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Оболочка: сначала сеть (чтобы обновления приходили сразу), при офлайне — кэш.
// API никогда не кэшируем.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('/index.html'))),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  const title = data.title || 'Мия 🦊';
  const options = {
    body: data.body || 'Я по тебе соскучилась!',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: data.tag || 'miya',
    renotify: true,
    data: { url: data.url || '/' },
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      // Если приложение открыто — пусть подтянет новое сообщение в чат.
      self.clients.matchAll({ type: 'window' }).then((list) => list.forEach((c) => c.postMessage({ type: 'refresh' }))),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin) {
          client.postMessage({ type: 'refresh' });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
