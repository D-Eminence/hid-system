#!/usr/bin/env node
// Runs the gateway configuration the image ships (gateway/nginx.conf.template
// and gateway/proxy-headers.conf) under a real nginx binary, against stub
// upstreams on 127.0.0.1, and checks what scripts/tests/gateway-config.test.mjs
// can only check against a model of nginx:
//
//   A8          an upstream 502/503/504 reaches the client with its own status,
//               Problem Details body, Set-Cookie, Retry-After and
//               X-Correlation-ID; only an upstream that refuses the connection
//               or closes without answering gets 503 UPSTREAM_UNAVAILABLE.
//   D7          the access log is one JSON object per request, with the path but
//               never the query string, and the image's http-level "main" format
//               (which logs the request line) records nothing.
//   SCAN-EDGE   POST /api/v1/ehr/documents/scan-events (any spelling) answers
//               404 API_ROUTE_NOT_FOUND and never reaches ehr-api.
//   WAF-CRS-BODY  a 300 KiB clinical note body reaches ehr-api; a body over
//               512 KiB answers 413 PAYLOAD_TOO_LARGE before any upstream sees it.
//
// Usage: HID_NGINX_BINARY=/path/to/nginx node scripts/verify-gateway-runtime.mjs
// The binary should be the nginx release the pinned image runs (1.29.x). No
// container engine, network or credential is used; everything listens on
// 127.0.0.1 ports the operating system assigns, and the temporary directory is
// removed afterwards.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { renderTemplate } from './lib/nginx-config-model.mjs'

const repository = resolve(import.meta.dirname, '..')
const nginxBinary = process.env.HID_NGINX_BINARY
if (!nginxBinary) {
  process.stderr.write('verify-gateway-runtime: set HID_NGINX_BINARY to an nginx 1.29 binary; nothing was verified.\n')
  process.exit(2)
}
await access(nginxBinary)

const client = '198.51.100.23'
const correlationId = 'gateway-runtime-check-0001'
const secretTerm = 'ada-obi-search-term'

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createTcpServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen(server.address().port))
  })
}

// The stub application: answers that the gateway must pass through, and an
// echo that records what reached the upstream.
const reached = []
const application = createHttpServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = Buffer.concat(chunks)
    reached.push({ method: request.method, url: request.url, bytes: body.length,
      originSecret: request.headers['x-hid-origin-authorization'] ?? null })
    const problem = (status, code, extra = {}) => {
      response.writeHead(status, {
        'content-type': 'application/problem+json',
        'x-correlation-id': request.headers['x-correlation-id'] ?? 'missing',
        ...extra,
      })
      response.end(JSON.stringify({ type: 'about:blank', title: 'Upstream answer', status, code,
        detail: 'The service could not complete the request.' }))
    }
    const path = request.url.split('?')[0]
    if (path.endsWith('/probe/503')) {
      problem(503, 'EMERGENCY_CONTACT_DELIVERY_UNAVAILABLE', {
        'set-cookie': ['hid_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'],
        'retry-after': '30',
      })
    } else if (path.endsWith('/probe/502')) {
      problem(502, 'LAB_HANDOFF_UNCONFIRMED')
    } else if (path.endsWith('/probe/504')) {
      problem(504, 'DEPENDENCY_TIMEOUT')
    } else {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ method: request.method, url: request.url, bytes: body.length }))
    }
  })
})
// An upstream that accepts the connection and closes it without answering.
const silent = createTcpServer(socket => socket.destroy())

const temporary = await mkdtemp(join(tmpdir(), 'hid-gateway-runtime-'))
let nginx
let stderr = ''
try {
  const applicationPort = await listen(application)
  const silentPort = await listen(silent)
  const closedPort = await freePort()
  const gatewayPort = await freePort()

  const template = await readFile(join(repository, 'gateway/nginx.conf.template'), 'utf8')
  const proxyHeaders = await readFile(join(repository, 'gateway/proxy-headers.conf'), 'utf8')
  const applicationUpstream = `http://127.0.0.1:${applicationPort}`
  const rendered = renderTemplate(template, {
    IDENTITY_API_UPSTREAM: applicationUpstream,
    EHR_API_UPSTREAM: applicationUpstream,
    LAB_API_UPSTREAM: `http://127.0.0.1:${closedPort}`,
    PHARMACY_API_UPSTREAM: `http://127.0.0.1:${silentPort}`,
    OCR_API_UPSTREAM: applicationUpstream,
    OUTREACH_API_UPSTREAM: applicationUpstream,
    // Upstreams are address literals, so the resolver is never queried.
    GATEWAY_DNS_RESOLVER: '127.0.0.1',
    VPC_CIDR: '127.0.0.1/32',
    HID_REQUIRE_CLIENT_IP: 'true',
    HID_ENABLED_API_ROUTES: 'identity,ehr,lab,pharmacy',
  })
  assert.match(rendered, /listen 3000;/)
  const server = rendered
    .replace('listen 3000;', `listen 127.0.0.1:${gatewayPort};`)
    .replaceAll('/etc/nginx/hid-proxy-headers.conf', join(temporary, 'hid-proxy-headers.conf'))
    // The image links /var/log/nginx/access.log to the container's stdout.
    .replaceAll('/var/log/nginx/access.log', join(temporary, 'access.log'))
  for (const directory of ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi']) {
    await mkdir(join(temporary, directory), { recursive: true })
  }
  await writeFile(join(temporary, 'hid-proxy-headers.conf'), proxyHeaders)
  await writeFile(join(temporary, 'default.conf'), server)
  // The http block of the image's /etc/nginx/nginx.conf: the stock "main"
  // format, which logs "$request", as the http-level access log.
  await writeFile(join(temporary, 'nginx.conf'), [
    process.getuid?.() === 0 ? 'user root;' : '',
    'worker_processes 1;',
    `pid ${join(temporary, 'nginx.pid')};`,
    `error_log ${join(temporary, 'error.log')} notice;`,
    'daemon off;',
    'events { worker_connections 64; }',
    'http {',
    '  default_type application/octet-stream;',
    '  log_format main \'$remote_addr - $remote_user [$time_local] "$request" \'',
    '                  \'$status $body_bytes_sent "$http_referer" \'',
    '                  \'"$http_user_agent" "$http_x_forwarded_for"\';',
    `  access_log ${join(temporary, 'image-access.log')} main;`,
    `  client_body_temp_path ${join(temporary, 'client_body')};`,
    `  proxy_temp_path ${join(temporary, 'proxy')};`,
    `  fastcgi_temp_path ${join(temporary, 'fastcgi')};`,
    `  uwsgi_temp_path ${join(temporary, 'uwsgi')};`,
    `  scgi_temp_path ${join(temporary, 'scgi')};`,
    `  include ${join(temporary, 'default.conf')};`,
    '}',
    '',
  ].join('\n'))
  await writeFile(join(temporary, 'image-access.log'), '')
  await writeFile(join(temporary, 'access.log'), '')

  nginx = spawn(nginxBinary, ['-p', temporary, '-e', join(temporary, 'error.log'), '-c', join(temporary, 'nginx.conf')],
    { stdio: ['ignore', 'ignore', 'pipe'] })
  nginx.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(resolveExit => nginx.once('exit', code => resolveExit(code)))
  const deadline = Date.now() + 10_000
  for (;;) {
    const ready = await new Promise(resolveReady => {
      const socket = connect(gatewayPort, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); resolveReady(true) })
      socket.once('error', () => resolveReady(false))
    })
    if (ready) break
    if (nginx.exitCode !== null || Date.now() > deadline) {
      await Promise.race([exited, new Promise(done => setTimeout(done, 200))])
      throw new Error(`nginx did not start: ${stderr}${await readFile(join(temporary, 'error.log'), 'utf8').catch(() => '')}`)
    }
    await new Promise(done => setTimeout(done, 50))
  }

  const base = `http://127.0.0.1:${gatewayPort}`
  async function send(method, path, { body, headers = {} } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-real-ip': client, 'x-correlation-id': correlationId, ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body,
    })
    const text = await response.text()
    return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) }
  }
  const checks = []
  const check = (name, run) => checks.push([name, run])

  check('A8: an upstream 503 keeps its status, Problem Details, Set-Cookie, Retry-After and X-Correlation-ID', async () => {
    const answer = await send('POST', `/api/v1/identity/probe/503?query=${secretTerm}`, { body: '{}' })
    assert.equal(answer.status, 503)
    assert.match(answer.headers.get('content-type'), /^application\/problem\+json/)
    assert.equal(answer.json().code, 'EMERGENCY_CONTACT_DELIVERY_UNAVAILABLE')
    assert.match(answer.headers.get('set-cookie') ?? '', /^hid_session=;/)
    assert.equal(answer.headers.get('retry-after'), '30')
    assert.equal(answer.headers.get('x-correlation-id'), correlationId)
  })
  check('A8: an upstream 502 and 504 keep their status and code', async () => {
    const badGateway = await send('POST', '/api/v1/ehr/probe/502', { body: '{}' })
    assert.equal(badGateway.status, 502)
    assert.equal(badGateway.json().code, 'LAB_HANDOFF_UNCONFIRMED')
    const timeout = await send('GET', '/api/v1/ehr/probe/504')
    assert.equal(timeout.status, 504)
    assert.equal(timeout.json().code, 'DEPENDENCY_TIMEOUT')
  })
  check('A8: an upstream that refuses or closes without answering gets 503 UPSTREAM_UNAVAILABLE', async () => {
    for (const path of ['/api/v1/lab/work-items', '/api/v1/pharmacy/work-items']) {
      const answer = await send('GET', path)
      assert.equal(answer.status, 503, path)
      assert.match(answer.headers.get('content-type'), /^application\/problem\+json/, path)
      assert.equal(answer.json().code, 'UPSTREAM_UNAVAILABLE', path)
      assert.equal(answer.headers.get('cache-control'), 'no-store', path)
      assert.equal(answer.headers.get('set-cookie'), null, path)
    }
  })
  check('SCAN-EDGE: the scanner callback answers 404 in every spelling and never reaches ehr-api', async () => {
    const before = reached.length
    for (const path of ['/api/v1/ehr/documents/scan-events', '/api/v1/ehr/Documents/SCAN-EVENTS/',
      '/api/v1/ehr/documents/%73can-events', '/api/v1/ehr/x/../documents/scan-events', '/api/v1/ehr//documents/scan-events?x=1']) {
      const answer = await send('POST', path, { body: '{"documentId":"x"}', headers: { authorization: 'Bearer not-a-token' } })
      assert.equal(answer.status, 404, path)
      assert.equal(answer.json().code, 'API_ROUTE_NOT_FOUND', path)
    }
    assert.equal(reached.length, before, 'no scanner callback reached the upstream')
    const uploadIntent = await send('POST', '/api/v1/ehr/documents/upload-intents', { body: '{}' })
    assert.equal(uploadIntent.status, 200, 'other document routes are still proxied (the service gates uploads)')
  })
  check('WAF-CRS-BODY: a 300 KiB note reaches ehr-api; a body over 512 KiB answers 413 PAYLOAD_TOO_LARGE', async () => {
    const note = JSON.stringify({ noteType: 'Discharge', title: 'Summary', status: 'draft', content: 'x'.repeat(300 * 1024) })
    const path = '/api/v1/ehr/patients/0b9d2f9e-6b7c-4b55-9a39-1d3e0e7a1f11/encounters/'
      + '1c8e3f0a-2b4d-4e6f-8a9b-0c1d2e3f4a5b/clinical-notes'
    const accepted = await send('POST', path, { body: note })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.json().bytes, Buffer.byteLength(note))
    const before = reached.length
    const refused = await send('POST', path, { body: JSON.stringify({ content: 'x'.repeat(513 * 1024) }) })
    assert.equal(refused.status, 413)
    assert.match(refused.headers.get('content-type'), /^application\/problem\+json/)
    assert.equal(refused.json().code, 'PAYLOAD_TOO_LARGE')
    assert.equal(reached.length, before, 'an oversized body never reaches the upstream')
  })
  check('A7: the Worker\'s origin secret stops at the gateway', async () => {
    const answer = await send('POST', '/api/v1/identity/x', { body: '{}', headers: { 'x-hid-origin-authorization': 'edge-secret-value' } })
    assert.equal(answer.status, 200)
    assert.equal(reached.at(-1).url, '/api/v1/identity/x')
    assert.equal(reached.at(-1).originSecret, null, 'no backend receives X-HID-Origin-Authorization')
  })
  check('D7: each request is logged as JSON with its path and no query string; the image log receives nothing', async () => {
    await send('GET', `/api/v1/admin/principals?query=${secretTerm}&page=2`)
    await send('GET', '/gateway-health/ready')
    await new Promise(done => setTimeout(done, 300))
    const lines = (await readFile(join(temporary, 'access.log'), 'utf8')).split('\n').filter(Boolean)
    assert.ok(lines.length >= 10, `expected gateway access log lines, got ${lines.length}`)
    for (const line of lines) {
      const entry = JSON.parse(line)
      assert.doesNotMatch(line, new RegExp(secretTerm), 'no query string is logged')
      assert.equal(typeof entry.path, 'string')
      assert.doesNotMatch(entry.path, /\?/)
      assert.match(entry.method, /^[A-Z]+$/)
      assert.equal(typeof entry.status, 'number')
      assert.equal(typeof entry.request_time, 'number')
      assert.match(entry.request_id, /^[0-9a-f]{32}$/)
      assert.notEqual(entry.path, '/gateway-health/ready', 'health checks are not logged')
    }
    const search = lines.map(line => JSON.parse(line)).find(entry => entry.path === '/api/v1/admin/principals')
    assert.ok(search, 'the admin search request is logged by its path')
    assert.equal(search.correlation_id, correlationId)
    assert.equal(search.client, client)
    assert.equal(await readFile(join(temporary, 'image-access.log'), 'utf8'), '', 'the image\'s "main" access log is not used')
  })

  const results = []
  for (const [name, run] of checks) {
    try {
      await run()
      results.push({ check: name, result: 'passed' })
    } catch (error) {
      const values = 'actual' in error ? ` (actual ${JSON.stringify(error.actual)}, expected ${JSON.stringify(error.expected)})` : ''
      const message = error.generatedMessage ? '' : `${error.message.split('\n')[0]} `
      results.push({ check: name, result: 'failed', reason: `${message}${values}`.trim() || error.message.split('\n')[0] })
    }
  }
  const nginxVersion = await new Promise(resolveVersion => {
    const version = spawn(nginxBinary, ['-v'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let text = ''
    version.stderr.on('data', chunk => { text += chunk })
    version.once('exit', () => resolveVersion(text.trim()))
  })
  const failed = results.filter(result => result.result !== 'passed')
  process.stdout.write(`${JSON.stringify({ status: failed.length ? 'failed' : 'passed', nginx: nginxVersion, results }, null, 2)}\n`)
  process.exitCode = failed.length ? 1 : 0
} finally {
  if (nginx && nginx.exitCode === null) {
    const stopped = new Promise(done => nginx.once('exit', done))
    nginx.kill('SIGQUIT')
    await Promise.race([stopped, new Promise(done => setTimeout(done, 3000))])
    if (nginx.exitCode === null) nginx.kill('SIGKILL')
  }
  application.close()
  silent.close()
  await rm(temporary, { recursive: true, force: true })
}
