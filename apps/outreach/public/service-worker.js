const CACHE_VERSION = 'hid-outreach-static-v2026-08-11-1'
const APP_SCOPE = new URL(self.registration.scope).pathname
const STATIC_CACHE_URLS = [
  APP_SCOPE,
  `${APP_SCOPE}manifest.webmanifest`,
  `${APP_SCOPE}hid-logo.png`,
  `${APP_SCOPE}favicon.ico`,
  `${APP_SCOPE}android-chrome-192x192.png`,
  `${APP_SCOPE}android-chrome-512x512.png`,
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION)
    .then((cache) => cache.addAll(STATIC_CACHE_URLS))
    .then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.map((key) => key === CACHE_VERSION || !key.startsWith('hid-outreach-')
      ? false
      : caches.delete(key))))
    .then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (!url.pathname.startsWith(APP_SCOPE)) return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) void caches.open(CACHE_VERSION).then((cache) => cache.put(APP_SCOPE, response.clone()))
      return response
    }).catch(() => caches.match(APP_SCOPE).then((cached) => cached ?? Response.error())))
    return
  }

  if (!url.pathname.startsWith(`${APP_SCOPE}assets/`) && !STATIC_CACHE_URLS.includes(url.pathname)) return
  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
    if (response.ok) void caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone()))
    return response
  })))
})
