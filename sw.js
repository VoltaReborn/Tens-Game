// sw.js — smart cache with instant activation + update-friendly fetch
const CACHE_VERSION   = 'v6';
const STATIC_CACHE    = `tens-static-${CACHE_VERSION}`;
const RUNTIME_CACHE   = `tens-runtime-${CACHE_VERSION}`;

// Anything you want reliably offline goes here
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'script.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // activate immediately
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const base  = self.registration.scope; // respects /tens-game/ on GH Pages
    for (const rel of ASSETS) {
      const url = new URL(rel, base).toString();
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
        await cache.put(url, res.clone());
      } catch (err) {
        console.error('[SW] precache skipped:', url, '→', err.message);
      }
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // purge old versions
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => ![STATIC_CACHE, RUNTIME_CACHE].includes(n))
        .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

// Helper: treat HTML navigations specially (SPA-friendly + fast updates)
function isHTMLRequest(request) {
  return request.mode === 'navigate' ||
         (request.headers.get('accept') || '').includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle same-origin GETs
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // HTML → network-first (so new index.html is seen immediately)
  if (isHTMLRequest(request)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request, { cache: 'no-cache' });
        // keep a copy of latest index.html in STATIC cache
        const staticCache = await caches.open(STATIC_CACHE);
        staticCache.put(new URL('index.html', self.registration.scope).toString(), fresh.clone());
        return fresh;
      } catch {
        // offline fallback: whatever we precached
        const staticCache = await caches.open(STATIC_CACHE);
        const fallback = await staticCache.match(new URL('index.html', self.registration.scope).toString());
        return fallback || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // Static assets (CSS/JS/icons) → stale-while-revalidate
  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(request);
    const fetchPromise = fetch(request).then(res => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    }).catch(() => null);

    // serve cached immediately if present, else wait for network, else fallback to runtime cache
    return cached || (await fetchPromise) || (await (await caches.open(RUNTIME_CACHE)).match(request)) || fetch(request);
  })());
});

// Optional: allow page to ask SW to skip waiting (not required; here for completeness)
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
