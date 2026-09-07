import assert from 'node:assert/strict'
import test from 'node:test'
import { createTufRepositoryWorker } from '../src/tuf-repository-worker.mjs'

const worker = createTufRepositoryWorker()
const digest = 'a'.repeat(64)

function environment(deployment = 'production', assetFetch) {
  const host = deployment === 'production'
    ? 'updates.healthidentitydirectory.com'
    : 'updates.staging.healthidentitydirectory.com'
  return {
    DEPLOYMENT_ENV: deployment,
    EXPECTED_HOST: host,
    WORKER_NAME: `hid-tuf-${deployment}`,
    ASSETS: {
      fetch: assetFetch ?? (async () => new Response('{}', {
        headers: { 'content-type': 'text/plain', 'set-cookie': 'forbidden=1' },
      })),
    },
  }
}

test('serves only timestamp.json without caching it', async () => {
  let received
  const request = new Request('https://updates.healthidentitydirectory.com/metadata/timestamp.json')
  const response = await worker.fetch(request, environment('production', async value => {
    received = value
    return new Response('{"signed":{}}', { headers: { age: '120', 'cf-cache-status': 'HIT' } })
  }))

  assert.equal(received, request)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store')
  assert.equal(response.headers.get('age'), null)
  assert.equal(response.headers.get('cf-cache-status'), null)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
})

test('serves versioned metadata and nested hash-prefixed targets as immutable', async () => {
  const metadata = await worker.fetch(
    new Request('https://updates.staging.healthidentitydirectory.com/metadata/42.snapshot.json'),
    environment('staging'),
  )
  assert.equal(metadata.status, 200)
  assert.equal(metadata.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(metadata.headers.get('content-type'), 'application/json; charset=utf-8')

  const target = await worker.fetch(
    new Request(`https://updates.healthidentitydirectory.com/targets/environments/production/releases/r1/${digest}.release-bundle.json`),
    environment(),
  )
  assert.equal(target.status, 200)
  assert.equal(target.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(target.headers.get('content-type'), 'application/octet-stream')
})

test('serves the exact uploaded version on its versioned preview host', async () => {
  const response = await worker.fetch(
    new Request('https://1234abcd-hid-tuf-staging.account-name.workers.dev/metadata/timestamp.json'),
    environment('staging'),
  )
  assert.equal(response.status, 200)

  for (const host of [
    'attacker-hid-tuf-staging.account-name.workers.dev',
    '1234abcd-hid-tuf-production.account-name.workers.dev',
    '1234abcd-hid-tuf-staging.workers.dev',
  ]) {
    const denied = await worker.fetch(
      new Request(`https://${host}/metadata/timestamp.json`),
      environment('staging'),
    )
    assert.equal(denied.status, 421, host)
  }
})

test('HEAD preserves exact asset lookup but never returns a body', async () => {
  let method
  const response = await worker.fetch(
    new Request('https://updates.healthidentitydirectory.com/metadata/1.root.json', { method: 'HEAD' }),
    environment('production', async request => {
      method = request.method
      return new Response(null, { headers: { 'content-length': '123' } })
    }),
  )
  assert.equal(method, 'HEAD')
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '')
  assert.equal(response.headers.get('content-length'), '123')
})

test('rejects methods, hosts, queries, unversioned roles, directories, and unhashed targets before ASSETS', async () => {
  let calls = 0
  const env = environment('production', async () => { calls += 1; return new Response('unexpected') })
  const cases = [
    ['https://updates.healthidentitydirectory.com/metadata/timestamp.json', { method: 'POST' }, 405],
    ['https://attacker.example/metadata/timestamp.json', {}, 421],
    ['http://updates.healthidentitydirectory.com/metadata/timestamp.json', {}, 400],
    ['https://updates.healthidentitydirectory.com/metadata/timestamp.json?cache=false', {}, 404],
    ['https://updates.healthidentitydirectory.com/metadata/timestamp.json', { headers: { range: 'bytes=0-10' } }, 400],
    ['https://updates.healthidentitydirectory.com/metadata/', {}, 404],
    ['https://updates.healthidentitydirectory.com/metadata/root.json', {}, 404],
    ['https://updates.healthidentitydirectory.com/metadata/01.root.json', {}, 404],
    ['https://updates.healthidentitydirectory.com/targets/environments/production/current.json', {}, 404],
    [`https://updates.healthidentitydirectory.com/targets/environments/production/${digest}.file%2Fname`, {}, 404],
  ]

  for (const [url, init, status] of cases) {
    const response = await worker.fetch(new Request(url, init), env)
    assert.equal(response.status, status, url)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.equal(calls, 0)

  const method = await worker.fetch(new Request(cases[0][0], cases[0][1]), env)
  assert.equal(method.headers.get('allow'), 'GET, HEAD')
})

test('rejects the other environment target namespace before ASSETS lookup', async () => {
  let calls = 0
  const response = await worker.fetch(
    new Request(`https://updates.healthidentitydirectory.com/targets/environments/staging/releases/r1/${digest}.bundle.json`),
    environment('production', async () => { calls += 1; return new Response('{}') }),
  )
  assert.equal(response.status, 404)
  assert.equal(calls, 0)
})

test('maps asset misses and redirects to a non-cacheable 404 without fallback', async () => {
  for (const status of [301, 404]) {
    const response = await worker.fetch(
      new Request('https://updates.healthidentitydirectory.com/metadata/2.targets.json'),
      environment('production', async () => new Response(null, {
        status,
        headers: status === 301 ? { location: '/metadata/timestamp.json' } : undefined,
      })),
    )
    assert.equal(response.status, 404)
    assert.equal(response.headers.get('location'), null)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await response.json()).code, 'PATH_NOT_FOUND')
  }
})

test('uses PHI-free structured logs for binding failures', async () => {
  const originalError = console.error
  const logs = []
  console.error = value => logs.push(value)
  try {
    const sensitivePath = `secret-patient-name-${digest}.json`
    const response = await worker.fetch(
      new Request(`https://updates.healthidentitydirectory.com/targets/environments/production/${digest}.${sensitivePath}`),
      environment('production', async () => { throw new Error(`do not log ${sensitivePath}`) }),
    )
    assert.equal(response.status, 503)
    assert.equal(logs.length, 1)
    assert.deepEqual(JSON.parse(logs[0]), {
      event: 'tuf_repository_error',
      component: 'tuf_repository_worker',
      deployment: 'production',
      code: 'ASSET_BINDING_FAILURE',
      status: 503,
    })
    assert.doesNotMatch(logs[0], /patient|secret|healthidentitydirectory/)
  } finally {
    console.error = originalError
  }
})
