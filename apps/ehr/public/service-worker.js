const CACHE = 'hid-ehr-shell-v2'
const APP_SCOPE = new URL(self.registration.scope).pathname
const SHELL = [APP_SCOPE, `${APP_SCOPE}manifest.webmanifest`, `${APP_SCOPE}hid-app-icon.svg`]

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith('hid-ehr-shell-') && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (!url.pathname.startsWith(APP_SCOPE)) return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) void caches.open(CACHE).then(cache => cache.put(APP_SCOPE, response.clone()))
      return response
    }).catch(() => caches.match(APP_SCOPE).then(response => response ?? Response.error())))
    return
  }

  if (!url.pathname.startsWith(`${APP_SCOPE}assets/`) && !SHELL.includes(url.pathname)) return
  event.respondWith(caches.match(request).then(cached => cached ?? fetch(request).then(response => {
    if (response.ok) void caches.open(CACHE).then(cache => cache.put(request, response.clone()))
    return response
  })))
})
