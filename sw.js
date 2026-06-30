/* ================================================================
   RELATIONSHIP OS — Service Worker (sw.js) v3.0
   Offline-first PWA with intelligent caching + auto-update
================================================================ */
'use strict';

const CACHE_NAME  = 'ros-shell-v10';
const DATA_CACHE  = 'ros-data-v3';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './image.png',
  './favicon.ico',
  './favicon-16.png',
  './favicon-32.png',
  './icon-192.png',
  './icon-512.png'
];

// External CDN resources to cache after first fetch
const CDN_PATTERNS = [
  'unpkg.com/leaflet',
  'www.gstatic.com/firebasejs'
];

// Never cache these — always go to network
const NEVER_CACHE = [
  'firebaseio.com',
  'googleapis.com',
  'nominatim.openstreetmap.org',
  'googletagmanager.com'
];

// ── Install: pre-cache app shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Install cache failed:', err))
  );
});

// ── Activate: purge old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(k => k !== CACHE_NAME && k !== DATA_CACHE)
            .map(k => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch: routing strategy ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Never-cache list → always network
  if (NEVER_CACHE.some(p => url.hostname.includes(p))) return;

  // OpenStreetMap tiles → stale-while-revalidate
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }

  // CDN resources → cache-first (they're versioned)
  if (CDN_PATTERNS.some(p => url.href.includes(p))) {
    event.respondWith(cacheFirst(request, CACHE_NAME));
    return;
  }

  // App shell → cache-first with network fallback
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirstWithFallback(request));
    return;
  }
});

/* ── Strategy: Cache-first, update in background ── */
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('Network error', { status: 503 });
  }
}

/* ── Strategy: Stale-while-revalidate ── */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || fetchPromise || new Response('', { status: 503 });
}

/* ── Strategy: Cache-first with index.html fallback ── */
async function cacheFirstWithFallback(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    // Return index.html for navigation requests (SPA offline fallback)
    const fallback = await cache.match('./index.html');
    return fallback || new Response('App is offline. Please reconnect.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// ── Push notifications ──
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  const title = data.title || 'Relationship OS';
  const body  = data.body  || 'You have a new notification';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:  './icon-192.png',
      badge: './icon-192.png',
      tag:   data.tag || 'ros-notification',
      data:  data
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {
        if (windowClients.length > 0) {
          windowClients[0].focus();
        } else {
          clients.openWindow('./');
        }
      })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: tag || 'ros-notification'
      })
    );
  }
});
