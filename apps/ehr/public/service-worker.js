const RELEASE_SHA = '__HID_EHR_RELEASE_SHA__'
const CACHE_PREFIX = 'hid-ehr-shell-'
const CACHE = `${CACHE_PREFIX}${RELEASE_SHA}`
const LEGACY_CACHE = `${CACHE_PREFIX}v2`
const APP_SCOPE = new URL(self.registration.scope).pathname
const CANONICAL_RUNTIME = `${APP_SCOPE}assets/canonical-platform-runtime.js`
const RELEASE_ASSETS = __HID_EHR_SHELL_ASSETS__
const SHELL = [
  APP_SCOPE,
  `${APP_SCOPE}manifest.webmanifest`,
  `${APP_SCOPE}hid-app-icon.svg`,
  ...RELEASE_ASSETS.map(path => `${APP_SCOPE}${path}`),
]

function scopedUrl(path) {
  return new URL(path, self.location.origin).href
}

async function fetchFresh(request) {
  return fetch(new Request(request, { cache: 'reload', credentials: 'same-origin' }))
}

async function installReleaseShell() {
  const cache = await caches.open(CACHE)
  try {
    for (const path of SHELL) {
      const request = new Request(scopedUrl(path), { cache: 'reload', credentials: 'same-origin' })
      const response = await fetch(request)
      if (!response.ok) throw new Error(`Unable to install EHR shell asset: ${path}`)
      await cache.put(request, response)
    }
  } catch (error) {
    await caches.delete(CACHE)
    throw error
  }
  await self.skipWaiting()
}

self.addEventListener('install', event => {
  event.waitUntil(installReleaseShell())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    const migratedFromLegacyCache = keys.includes(LEGACY_CACHE)
    await Promise.all(keys
      .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
      .map(key => caches.delete(key)))
    await self.clients.claim()

    if (migratedFromLegacyCache) {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      await Promise.all(clients.map(client => {
        const url = new URL(client.url)
        return url.origin === self.location.origin && url.pathname.startsWith(APP_SCOPE)
          ? client.navigate(client.url)
          : undefined
      }))
    }
  })())
})

async function networkFirst(request, fallbackPath) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetchFresh(request)
    if (response.ok) await cache.put(request, response.clone())
    return response
  } catch {
    return (await cache.match(fallbackPath ?? request)) ?? Response.error()
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (!url.pathname.startsWith(APP_SCOPE)) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, scopedUrl(APP_SCOPE)))
    return
  }

  if (url.search || (!url.pathname.startsWith(`${APP_SCOPE}assets/`) && !SHELL.includes(url.pathname))) return
  event.respondWith(url.pathname === CANONICAL_RUNTIME ? networkFirst(request) : cacheFirst(request))
})
