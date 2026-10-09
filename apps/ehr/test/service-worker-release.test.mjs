import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import {
  bindServiceWorkerRelease,
  normalizeShellAssetPaths,
  resolveBuildReleaseSha,
  SERVICE_WORKER_ASSET_TOKEN,
  SERVICE_WORKER_RELEASE_TOKEN,
} from '../scripts/service-worker-release.mjs'

const registrationSource = await readFile(new URL('../src/release-service-worker.ts', import.meta.url), 'utf8')
const registrationModule = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(
  registrationSource,
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText).toString('base64')}`)
const { registerReleaseBoundServiceWorker } = registrationModule

const RELEASE_SHA = '0123456789abcdef0123456789abcdef01234567'
const ORIGIN = 'https://ehr.healthidentitydirectory.com'
const SCOPE = `${ORIGIN}/ehr/`
const RELEASE_ASSETS = [
  'assets/app-01234567.js',
  'assets/canonical-platform-runtime.js',
  'assets/ehr-01234567.css',
]

test('build binding creates an exact release cache generation', async () => {
  const template = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8')
  const worker = bindServiceWorkerRelease(template, RELEASE_SHA, RELEASE_ASSETS)
  assert.equal(worker.includes(SERVICE_WORKER_RELEASE_TOKEN), false)
  assert.equal(worker.includes(SERVICE_WORKER_ASSET_TOKEN), false)
  assert.match(worker, /const CACHE = `\$\{CACHE_PREFIX\}\$\{RELEASE_SHA\}`/)
  assert.match(worker, /const RELEASE_SHA = '0123456789abcdef0123456789abcdef01234567'/)
  assert.match(worker, /const RELEASE_ASSETS = \["assets\/app-01234567.js","assets\/canonical-platform-runtime.js","assets\/ehr-01234567.css"\]/)
  assert.throws(() => bindServiceWorkerRelease(template, 'not-a-sha', RELEASE_ASSETS), /40 lowercase hexadecimal/)
  assert.throws(() => bindServiceWorkerRelease(
    template.replace(SERVICE_WORKER_RELEASE_TOKEN, ''), RELEASE_SHA, RELEASE_ASSETS,
  ), /release token; found 0/)
  assert.throws(() => bindServiceWorkerRelease(template, RELEASE_SHA, ['assets/app.js']), /canonical platform runtime/)
  assert.throws(() => normalizeShellAssetPaths(['assets/../secret']), /Unsafe EHR shell asset path/)
  assert.throws(() => resolveBuildReleaseSha({
    configuredSha: '0000000000000000000000000000000000000000',
  }), /does not match checked-out Git SHA/)
})

test('registration binds the worker request to the release and refreshes once on activation', async () => {
  let controllerChange
  let reloads = 0
  let updates = 0
  let registeredOptions
  const registration = { update: async () => { updates += 1 } }

  const result = await registerReleaseBoundServiceWorker({
    scriptUrl: `/ehr/service-worker.js?release=${RELEASE_SHA}`,
    scope: '/ehr/',
    releaseSha: RELEASE_SHA,
    enabled: true,
    serviceWorker: {
      addEventListener(type, listener) {
        assert.equal(type, 'controllerchange')
        controllerChange = listener
      },
    },
    reload: () => { reloads += 1 },
    register: async options => {
      registeredOptions = options
      return registration
    },
  })

  assert.equal(result, registration)
  assert.deepEqual(registeredOptions, {
    scriptUrl: `/ehr/service-worker.js?release=${RELEASE_SHA}`,
    scope: '/ehr/',
    enabled: true,
  })
  assert.equal(updates, 1)
  controllerChange()
  controllerChange()
  assert.equal(reloads, 1)

  await assert.rejects(registerReleaseBoundServiceWorker({
    scriptUrl: '/ehr/service-worker.js',
    scope: '/ehr/',
    releaseSha: RELEASE_SHA,
    enabled: true,
    serviceWorker: undefined,
    reload: () => undefined,
    register: async () => null,
  }), /not bound to the release SHA/)
})

function createWorkerHarness(source) {
  const listeners = new Map()
  const stores = new Map()
  const fetched = []
  const navigated = []
  let failNetwork = false
  let claimed = 0
  let skippedWaiting = 0

  const keyFor = value => typeof value === 'string' ? new URL(value, ORIGIN).href : value.url
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map())
      const entries = stores.get(name)
      return {
        async put(request, response) { entries.set(keyFor(request), response.clone()) },
        async match(request) { return entries.get(keyFor(request))?.clone() },
      }
    },
    async keys() { return [...stores.keys()] },
    async delete(name) { return stores.delete(name) },
  }
  const client = {
    url: `${SCOPE}patients`,
    async navigate(url) { navigated.push(url) },
  }
  const self = {
    registration: { scope: SCOPE },
    location: { origin: ORIGIN },
    clients: {
      async claim() { claimed += 1 },
      async matchAll() { return [client, { ...client, url: `${ORIGIN}/admin/` }] },
    },
    async skipWaiting() { skippedWaiting += 1 },
    addEventListener(type, listener) { listeners.set(type, listener) },
  }
  const fetch = async request => {
    fetched.push(request)
    if (failNetwork) throw new Error('offline')
    return new Response(`fresh:${keyFor(request)}`, { status: 200 })
  }
  vm.runInNewContext(source, { self, caches, fetch, Request, Response, URL, Error })

  return {
    listeners,
    stores,
    fetched,
    navigated,
    get claimed() { return claimed },
    get skippedWaiting() { return skippedWaiting },
    setOffline(value) { failNetwork = value },
  }
}

async function dispatchExtendable(listener, event = {}) {
  let operation
  listener({ ...event, waitUntil(value) { operation = value } })
  await operation
}

test('activation atomically replaces the legacy cache and refreshes only EHR clients', async () => {
  const template = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8')
  const harness = createWorkerHarness(bindServiceWorkerRelease(template, RELEASE_SHA, RELEASE_ASSETS))
  harness.stores.set('hid-ehr-shell-v2', new Map())
  harness.stores.set('unrelated-cache', new Map())

  await dispatchExtendable(harness.listeners.get('install'))
  assert.equal(harness.skippedWaiting, 1)
  assert.equal(harness.fetched.length, 3 + RELEASE_ASSETS.length)
  assert.ok(harness.fetched.every(request => request.cache === 'reload'))
  assert.ok(harness.stores.has(`hid-ehr-shell-${RELEASE_SHA}`))

  await dispatchExtendable(harness.listeners.get('activate'))
  assert.equal(harness.claimed, 1)
  assert.equal(harness.stores.has('hid-ehr-shell-v2'), false)
  assert.equal(harness.stores.has('unrelated-cache'), true)
  assert.deepEqual(harness.navigated, [`${SCOPE}patients`])
})

test('a failed shell install leaves the prior verified cache active', async () => {
  const template = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8')
  const harness = createWorkerHarness(bindServiceWorkerRelease(template, RELEASE_SHA, RELEASE_ASSETS))
  harness.stores.set('hid-ehr-shell-v2', new Map())
  harness.setOffline(true)

  await assert.rejects(dispatchExtendable(harness.listeners.get('install')), /offline/)
  assert.equal(harness.skippedWaiting, 0)
  assert.equal(harness.stores.has(`hid-ehr-shell-${RELEASE_SHA}`), false)
  assert.equal(harness.stores.has('hid-ehr-shell-v2'), true)
})

test('the stable canonical runtime is network-first with verified offline fallback and APIs are ignored', async () => {
  const template = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8')
  const harness = createWorkerHarness(bindServiceWorkerRelease(template, RELEASE_SHA, RELEASE_ASSETS))
  await dispatchExtendable(harness.listeners.get('install'))

  const runtimeRequest = new Request(`${SCOPE}assets/canonical-platform-runtime.js`)
  let responsePromise
  harness.listeners.get('fetch')({ request: runtimeRequest, respondWith(value) { responsePromise = value } })
  const online = await responsePromise
  assert.match(await online.text(), /^fresh:/)

  harness.setOffline(true)
  responsePromise = undefined
  harness.listeners.get('fetch')({ request: runtimeRequest, respondWith(value) { responsePromise = value } })
  const offline = await responsePromise
  assert.match(await offline.text(), /^fresh:/)

  responsePromise = undefined
  harness.listeners.get('fetch')({
    request: new Request(`${ORIGIN}/api/v1/patients`),
    respondWith(value) { responsePromise = value },
  })
  assert.equal(responsePromise, undefined)
})
