/*
 * Dayson Depo service worker. Registered with scope /floor only.
 * It caches the floor app shell so scanning keeps working without network
 * (spec 5.7: at least 30 minutes offline). Data never comes from this cache:
 * commands wait in the IndexedDB outbox and replay when the network returns.
 */
const VERSION = 'v1';
// Raise VERSION when this file changes in a way that must drop old caches.
const PAGES = `dayson-floor-pages-${VERSION}`;
const STATIC = `dayson-floor-static-${VERSION}`;
const KEEP = [PAGES, STATIC];
const NAVIGATION_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('dayson-floor-') && !KEEP.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

function isFloorPath(pathname) {
  return pathname === '/floor' || pathname.startsWith('/floor/');
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest'
  );
}

/** Cache a page only when it is the real page: 200, not a redirect to /login. */
async function cachePage(pathname, response) {
  if (!response || !response.ok || response.redirected || response.type !== 'basic') return;
  const cache = await caches.open(PAGES);
  await cache.put(pathname, response.clone());
}

/** Cache the scripts, styles and fonts a page refers to, so it also starts offline. */
async function cachePageAssets(html) {
  const cache = await caches.open(STATIC);
  const assets = new Set(html.match(/\/_next\/static\/[A-Za-z0-9_\-./~%@]+/g) || []);
  await Promise.all(
    [...assets].map(async (path) => {
      try {
        if (await cache.match(path)) return;
        const response = await fetch(path);
        if (response.ok) await cache.put(path, response);
      } catch (err) {
        // Best effort.
      }
    }),
  );
}

async function warm(urls) {
  await Promise.all(
    urls.map(async (url) => {
      try {
        const pathname = new URL(url, self.location.origin).pathname;
        if (!isFloorPath(pathname)) return;
        const response = await fetch(pathname, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok || response.redirected) return;
        const html = await response.clone().text();
        await cachePage(pathname, response);
        await cachePageAssets(html);
      } catch (err) {
        // Offline during warm-up: pages are cached on the next visit instead.
      }
    }),
  );
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'WARM' && Array.isArray(data.urls)) event.waitUntil(warm(data.urls));
});

async function navigationResponse(request) {
  const url = new URL(request.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    await cachePage(url.pathname, response);
    return response;
  } catch (err) {
    clearTimeout(timer);
    const cache = await caches.open(PAGES);
    const cached = (await cache.match(url.pathname)) || (await cache.match('/floor'));
    if (cached) return cached;
    return new Response('<!doctype html><meta charset="utf-8"><title>Dayson Depo</title><p>Bağlantı yok.</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function staticResponse(request) {
  const cache = await caches.open(STATIC);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    if (isFloorPath(url.pathname)) event.respondWith(navigationResponse(request));
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith(staticResponse(request));
    return;
  }
  // Everything else (React Server Component payloads, API calls) goes to the
  // network. When an in-app navigation fails offline, Next.js falls back to a
  // full page load, which is answered from the page cache above.
});
