#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDevelopmentPorts } from './ports.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ports = resolveDevelopmentPorts(process.env)
const applications = [
  { name: 'web', port: ports.webUi, route: '/patient', scope: '/' },
  { name: 'ehr', port: ports.ehrUi, route: '/ehr/acceptance-refresh', scope: '/ehr/' },
  { name: 'lab', port: ports.labUi, route: '/lab/acceptance-refresh', scope: '/lab/' },
  { name: 'pharmacy', port: ports.pharmacyUi, route: '/pharmacy/prescriptions', scope: '/pharmacy/' },
  { name: 'ocr', port: ports.ocrUi, route: '/ocr/jobs', scope: '/ocr/' },
  { name: 'outreach', port: ports.outreachUi, route: '/outreach/login', scope: '/outreach/' },
  { name: 'admin', port: ports.adminUi, route: '/admin/facilities', scope: '/admin/' },
]

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hid-browser-acceptance.'))
const children = []

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }),
  ])
}

async function cleanup() {
  await Promise.allSettled(children.map(stopChild))
  // Chrome may briefly flush profile journals after its parent process exits.
  await delay(500)
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)) })
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)) })

class CdpSession {
  constructor(url) {
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.socket = new WebSocket(url)
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        return
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  waitFor(method, timeoutMilliseconds = 15_000) {
    return new Promise((resolve, reject) => {
      const listeners = this.listeners.get(method) ?? []
      const timeout = setTimeout(() => {
        const index = listeners.indexOf(onEvent)
        if (index >= 0) listeners.splice(index, 1)
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMilliseconds)
      const onEvent = value => {
        clearTimeout(timeout)
        const index = listeners.indexOf(onEvent)
        if (index >= 0) listeners.splice(index, 1)
        resolve(value)
      }
      listeners.push(onEvent)
      this.listeners.set(method, listeners)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

async function waitForHttp(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.status === 200) return
    } catch {
      // The production preview is still starting.
    }
    await delay(200)
  }
  throw new Error(`Production preview did not become reachable: ${url}`)
}

async function waitForBrowser(debugPort) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      if (response.ok) return
    } catch {
      // Chrome is still starting.
    }
    await delay(100)
  }
  throw new Error('Headless Chrome DevTools endpoint did not become reachable')
}

async function openPage(debugPort, url) {
  const response = await fetch(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  )
  assert.equal(response.status, 200)
  const target = await response.json()
  const session = new CdpSession(target.webSocketDebuggerUrl)
  await session.connect()
  await Promise.all([session.send('Page.enable'), session.send('Runtime.enable'), session.send('Network.enable')])
  return session
}

async function navigate(session, url) {
  const loaded = session.waitFor('Page.loadEventFired')
  const result = await session.send('Page.navigate', { url })
  assert.equal(result.errorText, undefined, `Navigation failed for ${url}: ${result.errorText}`)
  await loaded
}

async function reload(session) {
  const loaded = session.waitFor('Page.loadEventFired')
  await session.send('Page.reload', { ignoreCache: false })
  await loaded
}

async function waitForWorker(session, expectedScope) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await session.evaluate(`(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations()
      return registrations.map(registration => ({
        scope: registration.scope,
        active: Boolean(registration.active),
      }))
    })()`)
    if (result.some(registration => registration.active && new URL(registration.scope).pathname === expectedScope)) {
      return result
    }
    await delay(100)
  }
  throw new Error(`No active service worker appeared for scope ${expectedScope}`)
}

async function waitForRenderedShell(session, applicationName) {
  let result
  for (let attempt = 0; attempt < 150; attempt += 1) {
    result = await session.evaluate(`({
      shellChildren: document.body.childElementCount,
      bodyLength: document.body.innerText.trim().length,
      bundlerError: Boolean(document.querySelector('#__bundler_err')),
    })`)
    assert.equal(result.bundlerError, false, `${applicationName} reported a production bundle error`)
    if (result.shellChildren > 0 && result.bodyLength > 20) return result
    await delay(100)
  }
  return result
}

try {
  for (const application of applications) {
    const viteBinary = path.join(repository, 'apps', application.name, 'node_modules', 'vite', 'bin', 'vite.js')
    const child = spawn(process.execPath, [viteBinary, 'preview'], {
      cwd: path.join(repository, 'apps', application.name),
      env: {
        ...process.env,
        ...(application.name === 'web' ? { HID_WEB_DIRECT: 'true' } : {}),
      },
      stdio: 'ignore',
    })
    children.push(child)
  }

  await Promise.all(applications.map(application => waitForHttp(
    `http://127.0.0.1:${application.port}${application.route}`,
  )))

  const debugPort = await freePort()
  const chrome = spawn('google-chrome', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${path.join(temporaryRoot, 'chrome-profile')}`,
    'about:blank',
  ], { stdio: 'ignore' })
  children.push(chrome)
  await waitForBrowser(debugPort)

  const results = []
  for (const application of applications) {
    const url = `http://127.0.0.1:${application.port}${application.route}`
    const session = await openPage(debugPort, 'about:blank')
    await navigate(session, url)
    const initial = await waitForRenderedShell(session, application.name)
    assert.ok(initial.shellChildren > 0, `${application.name} did not render its application shell`)
    assert.ok(initial.bodyLength > 20, `${application.name} rendered no meaningful shell text`)

    const registrations = await waitForWorker(session, application.scope)
    await reload(session)
    const online = await session.evaluate(`(async () => {
      const cacheNames = await caches.keys()
      const cacheUrls = []
      for (const name of cacheNames) {
        for (const request of await (await caches.open(name)).keys()) cacheUrls.push(request.url)
      }
      return {
        controlled: Boolean(navigator.serviceWorker.controller),
        cacheNames,
        cacheUrls,
        shellChildren: document.body.childElementCount,
      }
    })()`)
    assert.equal(online.controlled, true, `${application.name} is not controlled after refresh`)
    assert.ok(online.cacheNames.length > 0, `${application.name} created no static shell cache`)
    assert.equal(online.cacheUrls.some(cachedUrl => new URL(cachedUrl).pathname.startsWith('/api/')), false,
      `${application.name} cached an API response`)

    await session.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
      connectionType: 'none',
    })
    await session.send('Network.overrideNetworkState', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
      connectionType: 'none',
    })
    // Headless Chrome reports the host adapter through navigator.onLine even
    // while CDP blocks all page transport. Set the browser-visible state at
    // document start as well, so the same genuinely offline reload exercises
    // the application's connectivity UI branch.
    const navigatorOverride = await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `Object.defineProperty(Navigator.prototype, 'onLine', {
        configurable: true,
        get: () => false,
      })`,
    })
    await reload(session)
    await delay(250)
    const offline = await session.evaluate(`({
      shellChildren: document.body.childElementCount,
      bodyLength: document.body.innerText.trim().length,
      visibleOfflineState: /offline|connection unavailable|saved locally/i.test(document.body.innerText),
      navigatorOnline: navigator.onLine,
    })`)
    assert.ok(offline.shellChildren > 0 && offline.bodyLength > 20,
      `${application.name} did not render its cached shell offline`)
    assert.equal(offline.navigatorOnline, false, `${application.name} did not observe browser offline state`)
    assert.equal(offline.visibleOfflineState, true, `${application.name} did not show an honest offline state`)
    await session.send('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: navigatorOverride.identifier,
    })
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: 'wifi',
    })
    await session.send('Network.overrideNetworkState', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: 'wifi',
    })

    results.push({
      app: application.name,
      route: application.route,
      scope: registrations.find(registration => new URL(registration.scope).pathname === application.scope).scope,
      controlled: online.controlled,
      staticCacheEntries: online.cacheUrls.length,
      apiCacheEntries: 0,
      offlineShell: true,
      visibleOfflineState: true,
    })
    session.close()
  }

  console.log(JSON.stringify({
    status: 'passed',
    browser: 'Google Chrome',
    profile: 'clean temporary profile',
    applications: results,
  }))
} finally {
  await cleanup()
}
