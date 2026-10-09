const CACHE_VERSION = 'hid-web-static-v2026-08-11-1'
const STATIC_CACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/hid-logo.png',
  '/favicon.ico',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  '/android-chrome-192x192.png',
]

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(STATIC_CACHE_URLS)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (key !== CACHE_VERSION) {
            return caches.delete(key)
          }
          return Promise.resolve(false)
        })
      )
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/functions/')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const responseClone = response.clone()
          caches.open(CACHE_VERSION).then(cache => cache.put('/', responseClone)).catch(() => undefined)
        }
        return response
      }).catch(() => caches.match('/').then(cached => cached ?? Response.error()))
    )
    return
  }

  const isStaticAsset = url.pathname.startsWith('/assets/') || STATIC_CACHE_URLS.includes(url.pathname)
  if (!isStaticAsset) return

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached
      return fetch(request).then(response => {
        if (response.ok) {
          const responseClone = response.clone()
          caches.open(CACHE_VERSION).then(cache => cache.put(request, responseClone)).catch(() => undefined)
        }
        return response
      })
    })
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const targetUrl = new URL('/patient/notifications', self.location.origin).href
      const existingClient = clients.find(client => client.url.startsWith(self.location.origin))

      if (existingClient) {
        existingClient.focus()
        existingClient.navigate(targetUrl)
        return
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl)
      }
    })
  )
})
