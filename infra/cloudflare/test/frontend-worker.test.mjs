import assert from 'node:assert/strict'
import test from 'node:test'
import { createFrontendWorker } from '../src/frontend-worker.mjs'
import apexWorker from '../src/apex-redirect-worker.mjs'

const worker = createFrontendWorker()
const originalFetch = globalThis.fetch

function environment(overrides = {}) {
  return {
    API_ORIGIN: 'https://api.healthidentitydirectory.com',
    EXPECTED_HOST: 'ehr.healthidentitydirectory.com',
    APP_NAME: 'ehr',
    ASSETS: { fetch: async request => new Response(`<p>${new URL(request.url).pathname}</p>`, {
      status: 200, headers: { 'content-type': 'text/html' },
    }) },
    ...overrides,
  }
}

test.afterEach(() => { globalThis.fetch = originalFetch })

test('serves the application asset binding with security headers', async () => {
  const response = await worker.fetch(new Request('https://ehr.healthidentitydirectory.com/deep/link'), environment())
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '<p>/deep/link</p>')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()')
})

test('grants device capabilities only to the application host that needs them', async () => {
  const ocr = await worker.fetch(new Request('https://ocr.healthidentitydirectory.com/'),
    environment({ EXPECTED_HOST: 'ocr.healthidentitydirectory.com' }))
  assert.equal(ocr.headers.get('permissions-policy'), 'camera=(self), microphone=(), geolocation=()')
  const outreach = await worker.fetch(new Request('https://outreach.healthidentitydirectory.com/'),
    environment({ EXPECTED_HOST: 'outreach.healthidentitydirectory.com' }))
  assert.equal(outreach.headers.get('permissions-policy'), 'camera=(self), microphone=(), geolocation=(self)')
})

test('proxies only /api/v1 to the one fixed AWS origin without shared caching', async () => {
  let received
  globalThis.fetch = async (url, init) => {
    received = { url: String(url), init }
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
  }
  const request = new Request('https://ehr.healthidentitydirectory.com/api/v1/auth/session?view=safe', {
    headers: { origin: 'https://ehr.healthidentitydirectory.com', cookie: 'opaque=1', 'x-forwarded-host': 'attacker.example', 'x-correlation-id': 'safe-correlation-123' },
  })
  const response = await worker.fetch(request, environment())
  assert.equal(received.url, 'https://api.healthidentitydirectory.com/api/v1/auth/session?view=safe')
  assert.equal(received.init.headers.get('origin'), 'https://ehr.healthidentitydirectory.com')
  assert.equal(received.init.headers.get('cookie'), 'opaque=1')
  assert.equal(received.init.headers.get('x-forwarded-host'), 'ehr.healthidentitydirectory.com')
  assert.equal(received.init.headers.get('x-hid-edge-origin'), 'https://ehr.healthidentitydirectory.com')
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0')
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store')
})

test('preserves mutation bodies and methods', async () => {
  globalThis.fetch = async (_url, init) => new Response(await new Response(init.body).text(), { status: 202 })
  const response = await worker.fetch(new Request('https://ehr.healthidentitydirectory.com/api/v1/auth/login', {
    method: 'POST', body: '{"opaque":"body"}', headers: { 'content-type': 'application/json' },
  }), environment())
  assert.equal(response.status, 202)
  assert.equal(await response.text(), '{"opaque":"body"}')
})

test('rejects other API namespaces and misdirected hosts', async () => {
  assert.equal((await worker.fetch(new Request('https://ehr.healthidentitydirectory.com/api/open-proxy'), environment())).status, 404)
  assert.equal((await worker.fetch(new Request('https://attacker.example/api/v1/auth/session'), environment())).status, 421)
})

test('fails safely when the fixed origin configuration is changed', async () => {
  const response = await worker.fetch(new Request('https://ehr.healthidentitydirectory.com/api/v1/auth/session'),
    environment({ API_ORIGIN: 'https://attacker.example' }))
  assert.equal(response.status, 502)
  assert.equal((await response.json()).code, 'EDGE_CONFIGURATION_INVALID')
})

test('uses a safe correlation identifier when caller evidence is malformed', async () => {
  let value
  globalThis.fetch = async (_url, init) => { value = init.headers.get('x-correlation-id'); return new Response('{}') }
  await worker.fetch(new Request('https://ehr.healthidentitydirectory.com/api/v1/auth/session', {
    headers: { 'x-correlation-id': 'bad value with spaces' },
  }), environment())
  assert.match(value, /^[0-9a-f-]{36}$/)
})

test('redirects apex path and query to www without trusting a target parameter', async () => {
  const response = apexWorker.fetch(new Request('https://healthidentitydirectory.com/patient?next=https://evil.example'))
  assert.equal(response.status, 308)
  assert.equal(response.headers.get('location'), 'https://www.healthidentitydirectory.com/patient?next=https://evil.example')
})
