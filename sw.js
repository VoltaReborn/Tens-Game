// sw.js — drop-in replacement
const CACHE = 'tens-v1';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'script.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', (evt) => {
  self.skipWaiting();
  evt.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      const base = self.registration.scope;
      for (const rel of ASSETS) {
        const url = new URL(rel, base).toString();
        try {
          const res = await fetch(url, { cache: 'no-cache' });
          if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
          await cache.put(url, res.clone());
        } catch (err) {
          // ← this will tell you which path is bad
          console.error('[SW] precache skipped:', url, '→', err.message);
        }
      }
    })
  );
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (evt) => {
  const { request } = evt;
  if (new URL(request.url).origin !== self.location.origin) return;
  evt.respondWith(
    caches.match(request).then((cached) =>
      cached ||
      fetch(request).then((res) => {
        caches.open(CACHE).then((c) => c.put(request, res.clone())).catch(()=>{});
        return res;
      })
    )
  );
});
