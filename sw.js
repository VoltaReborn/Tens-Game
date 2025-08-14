// sw.js — app shell + basic runtime caching
const SCOPE = '/tens-game/';
const CACHE = 'tens-game-v1.0.0'; // bump this to bust old caches

// App shell to precache for instant/offline boot
const ASSETS = [
  '/',                // if your app is served at the domain root
  '/index.html',
  '/styles.css',
  '/script.js',
  '/manifest.webmanifest',
  // icons (add whatever you actually have)
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS.filter(Boolean)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k === CACHE ? null : caches.delete(k))))
    ).then(() => self.clients.claim())
  );
});

// Navigation requests -> App Shell (index.html), so the app works offline
// Static assets -> cache-first
// Images/other -> stale-while-revalidate
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin
  if (url.origin !== location.origin) return;

  // 1) App Shell for navigations
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // try network first to get the latest HTML
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put('/index.html', fresh.clone());
          return fresh;
        } catch {
          // offline: serve cached shell
          const cache = await caches.open(CACHE);
          return (await cache.match('/index.html')) || Response.error();
        }
      })()
    );
    return;
  }

  // 2) Cache-first for our known static assets
  if (ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req))
    );
    return;
  }

  // 3) Stale-while-revalidate for everything else (e.g., images)
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const net = fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          cache.put(req, res.clone());
        }
        return res;
      }).catch(() => null);
      return cached || net || new Response('', {status: 504});
    })()
  );
});
