// The API gateway's nginx configuration, rendered the way the image renders it
// and routed through scripts/lib/nginx-config-model.mjs. No nginx binary or
// container engine runs here: these tests check the configuration against a
// model of nginx's location selection, realip, geo, map and rewrite phases.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { assertGatewayContract } from '../lib/gateway-contract.mjs'
import {
  GatewayModel, parseConfig, renderTemplate, templateVariables,
} from '../lib/nginx-config-model.mjs'

const repository = resolve(import.meta.dirname, '..', '..')
const template = await readFile(join(repository, 'gateway/nginx.conf.template'), 'utf8')
const dockerfile = await readFile(join(repository, 'gateway/Dockerfile'), 'utf8')

// The files the runtime image ships, by their runtime path, from the
// Dockerfile's two COPY steps (configuration stage, then runtime stage).
async function imageFiles() {
  const staged = new Map()
  for (const [, source, target] of dockerfile.matchAll(/^COPY (gateway\/\S+) (\/tmp\/\S+)$/gm)) staged.set(target, source)
  const files = {}
  for (const [, source, target] of dockerfile.matchAll(/^COPY --from=configuration (\/tmp\/\S+) (\/etc\/nginx\/\S+)$/gm)) {
    assert.ok(staged.has(source), `${source} is not staged from the repository`)
    files[target] = await readFile(join(repository, staged.get(source)), 'utf8')
  }
  return files
}
const files = await imageFiles()
const includes = Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith('/etc/nginx/templates/')))

// The image's ENV defaults, which envsubst uses when the task sets nothing.
const imageDefaults = Object.fromEntries([...dockerfile.matchAll(/^\s*(?:ENV\s+)?([A-Z][A-Z0-9_]*)=(\S+?)(?:\s*\\)?$/gm)]
  .map(([, name, value]) => [name, value]))

const upstreams = Object.freeze({
  IDENTITY_API_UPSTREAM: 'http://identity-api.services.production.hid:3001',
  EHR_API_UPSTREAM: 'http://ehr-api.services.production.hid:3002',
  LAB_API_UPSTREAM: 'http://lab-api.services.production.hid:3003',
  PHARMACY_API_UPSTREAM: 'http://pharmacy-api.services.production.hid:3004',
  OCR_API_UPSTREAM: 'http://ocr-api.services.production.hid:3005',
  OUTREACH_API_UPSTREAM: 'http://outreach-api.services.production.hid:3006',
})
// What the CDK passes in production (infra/aws/src/hid-regional-stack.ts).
const production = Object.freeze({
  ...upstreams, VPC_CIDR: '10.40.0.0/16', GATEWAY_DNS_RESOLVER: '10.40.0.2',
  HID_REQUIRE_CLIENT_IP: 'true', HID_ENABLED_API_ROUTES: 'identity,ehr',
})
const allModules = 'identity,ehr,lab,pharmacy,ocr,outreach'

function gateway(environment) {
  return new GatewayModel(renderTemplate(template, environment), includes)
}

const alb = '10.40.1.10'
const client = '198.51.100.23'
const viaEdge = (extra = {}) => ({ 'x-real-ip': client, ...extra })

function expectProblem(outcome, status, code, message) {
  assert.equal(outcome.action, 'return', `${message}: expected a gateway answer, got ${outcome.action} to ${outcome.upstream}`)
  assert.equal(outcome.status, status, message)
  assert.equal(JSON.parse(outcome.body).code, code, message)
  assert.equal(outcome.contentType, 'application/problem+json', message)
  assert.equal(outcome.addHeaders?.['Cache-Control'], 'no-store', message)
}

test('the image defines a default for every variable the template uses', () => {
  for (const name of templateVariables(template)) {
    assert.ok(Object.hasOwn(imageDefaults, name), `gateway/Dockerfile must define ${name}; envsubst leaves undefined names in the configuration`)
  }
  for (const name of ['VPC_CIDR', 'GATEWAY_DNS_RESOLVER', 'HID_REQUIRE_CLIENT_IP', 'HID_ENABLED_API_ROUTES']) {
    assert.ok(templateVariables(template).includes(name), `the template must use ${name}`)
  }
  // Local runs: Docker's embedded DNS, no trusted client-address hop, the
  // header not required, and only the launch modules routed.
  assert.equal(imageDefaults.GATEWAY_DNS_RESOLVER, '127.0.0.11')
  assert.equal(imageDefaults.VPC_CIDR, '127.0.0.1/32')
  assert.equal(imageDefaults.HID_REQUIRE_CLIENT_IP, 'false')
  assert.equal(imageDefaults.HID_ENABLED_API_ROUTES, 'identity,ehr')
})

test('upstream names are resolved per request through the configured resolver', () => {
  const model = gateway(production)
  const resolvers = model.directives('resolver')
  assert.equal(resolvers.length, 1, 'exactly one resolver directive')
  assert.deepEqual(resolvers[0].args, ['10.40.0.2', 'valid=10s', 'ipv6=off'])
  // A literal proxy_pass host is resolved once when nginx loads the
  // configuration, and nginx refuses to start if it does not resolve.
  for (const [, argument] of template.matchAll(/proxy_pass\s+([^;]+);/g)) {
    assert.equal(argument.trim(), '$hid_upstream', `proxy_pass ${argument} must be the per-location upstream variable`)
  }
})

test('each API prefix is proxied to its owner with the client URI unchanged', () => {
  const model = gateway({ ...production, HID_ENABLED_API_ROUTES: allModules })
  for (const [prefix, upstream] of [
    ['/api/v1/auth', 'IDENTITY_API_UPSTREAM'], ['/api/v1/identity', 'IDENTITY_API_UPSTREAM'],
    ['/api/v1/audit', 'IDENTITY_API_UPSTREAM'], ['/api/v1/admin', 'IDENTITY_API_UPSTREAM'],
    ['/api/v1/commercial', 'IDENTITY_API_UPSTREAM'], ['/api/v1/ehr', 'EHR_API_UPSTREAM'],
    ['/api/v1/lab', 'LAB_API_UPSTREAM'], ['/api/v1/pharmacy', 'PHARMACY_API_UPSTREAM'],
    ['/api/v1/ocr', 'OCR_API_UPSTREAM'], ['/api/v1/outreach', 'OUTREACH_API_UPSTREAM'],
  ]) {
    for (const uri of [prefix, `${prefix}/`, `${prefix}/a/b?x=1&y=%2F`, `${prefix}//a/./b%20c`]) {
      const outcome = model.route({ method: 'POST', uri, peer: alb, headers: viaEdge() })
      assert.equal(outcome.action, 'proxy', `${uri} must be proxied`)
      assert.equal(outcome.upstream, upstreams[upstream], `${uri} belongs to ${upstream}`)
      assert.equal(outcome.upstreamUri, uri, `${uri} must reach the backend exactly as the client sent it`)
    }
  }
})

test('the client address comes from X-Real-IP only on connections from the VPC', () => {
  const model = gateway(production)
  const forwarded = model.route({ uri: '/api/v1/auth/session', peer: alb, headers: viaEdge() })
  assert.equal(forwarded.action, 'proxy')
  assert.equal(forwarded.upstreamHeaders['x-forwarded-for'], client,
    'the backends trust X-Forwarded-For from the gateway, so it must carry the client, not the load balancer')
  const ipv6 = model.route({ uri: '/api/v1/auth/session', peer: alb, headers: { 'x-real-ip': '2001:db8:4:5::9' } })
  assert.equal(ipv6.upstreamHeaders['x-forwarded-for'], '2001:db8:4:5::9')
  assert.equal(forwarded.upstreamHeaders['x-real-ip'], '', 'the raw header is not passed on')
  // A connection that does not come from the VPC is not a trusted hop.
  const direct = gateway({ ...production, HID_REQUIRE_CLIENT_IP: 'false' })
    .route({ uri: '/api/v1/auth/session', peer: '203.0.113.50', headers: viaEdge() })
  assert.equal(direct.upstreamHeaders['x-forwarded-for'], '203.0.113.50')
})

test('with the switch on, an API request without a usable client address is refused before proxying', () => {
  const model = gateway(production)
  // The Worker before this change deleted X-Real-IP and passed a caller's
  // X-HID-Client-IP through. Behind a stale or rolled-back Worker the request
  // must fail closed, never carry an address the caller chose.
  for (const headers of [{}, { 'x-real-ip': 'not-an-address' }, { 'x-real-ip': '10.40.7.7' },
    { 'x-real-ip': '' }, { 'x-hid-client-ip': client }, { 'x-forwarded-for': client }, { 'cf-connecting-ip': client }]) {
    for (const uri of ['/api/v1/auth/otp/start', '/api/v1/identity/patient-enrollments', '/api/v1/ehr/patients/x/encounters']) {
      expectProblem(model.route({ method: 'POST', uri, peer: alb, headers }), 403, 'CLIENT_ADDRESS_REQUIRED',
        `${uri} with ${JSON.stringify(headers)}`)
    }
  }
  // Health checks come from the load balancer itself and carry no client address.
  assert.equal(model.route({ uri: '/gateway-health/ready', peer: alb }).status, 200)
  assert.equal(model.route({ uri: '/gateway-health/live', peer: alb }).status, 200)
  // Only the exact value "false" turns the requirement off.
  for (const value of ['TRUE', 'yes', '1', 'False', '']) {
    expectProblem(gateway({ ...production, HID_REQUIRE_CLIENT_IP: value })
      .route({ uri: '/api/v1/auth/session', peer: alb }), 403, 'CLIENT_ADDRESS_REQUIRED', `HID_REQUIRE_CLIENT_IP=${value}`)
  }
})

test('local runs (the image defaults) proxy without the header and forward the peer', () => {
  const model = gateway({ ...imageDefaults })
  const outcome = model.route({ uri: '/api/v1/auth/session', peer: '172.18.0.4' })
  assert.equal(outcome.action, 'proxy')
  assert.equal(outcome.upstream, 'http://identity-api:3001')
  assert.equal(outcome.upstreamHeaders['x-forwarded-for'], '172.18.0.4')
  const spoofed = model.route({ uri: '/api/v1/auth/session', peer: '172.18.0.4', headers: { 'x-real-ip': '198.51.100.1' } })
  assert.equal(spoofed.upstreamHeaders['x-forwarded-for'], '172.18.0.4', 'a local peer is not a trusted hop')
})

test('modules outside HID_ENABLED_API_ROUTES answer 404 API_ROUTE_NOT_FOUND before proxying', () => {
  const launch = gateway(production)
  for (const uri of ['/api/v1/lab', '/api/v1/lab/', '/api/v1/lab/work-items', '/api/v1/pharmacy/work-items',
    '/api/v1/ocr/jobs', '/api/v1/ocr', '/api/v1/outreach/registration-cases', '/api/v1/outreach']) {
    expectProblem(launch.route({ uri, peer: alb, headers: viaEdge() }), 404, 'API_ROUTE_NOT_FOUND', uri)
  }
  for (const uri of ['/api/v1/auth/session', '/api/v1/identity/me', '/api/v1/audit/events', '/api/v1/admin/controls',
    '/api/v1/commercial/pricing', '/api/v1/ehr/patients/x/encounters']) {
    assert.equal(launch.route({ uri, peer: alb, headers: viaEdge() }).action, 'proxy', uri)
  }
  // Only exact module names count; anything else stays closed.
  for (const list of ['identity,EHR', 'identity, ehr ,labx', 'identity;ehr', '', 'all']) {
    const model = gateway({ ...production, HID_ENABLED_API_ROUTES: list })
    expectProblem(model.route({ uri: '/api/v1/lab/work-items', peer: alb, headers: viaEdge() }), 404,
      'API_ROUTE_NOT_FOUND', `lab with ${JSON.stringify(list)}`)
  }
  assert.equal(gateway({ ...production, HID_ENABLED_API_ROUTES: 'identity, ehr' })
    .route({ uri: '/api/v1/ehr/patients/x/encounters', peer: alb, headers: viaEdge() }).action, 'proxy')
  expectProblem(gateway({ ...production, HID_ENABLED_API_ROUTES: 'ehr' })
    .route({ uri: '/api/v1/auth/session', peer: alb, headers: viaEdge() }), 404, 'API_ROUTE_NOT_FOUND', 'identity off')
  const staging = gateway({ ...production, HID_ENABLED_API_ROUTES: 'identity,ehr,lab' })
  assert.equal(staging.route({ uri: '/api/v1/lab/work-items', peer: alb, headers: viaEdge() }).upstream,
    upstreams.LAB_API_UPSTREAM)
  expectProblem(staging.route({ uri: '/api/v1/pharmacy/work-items', peer: alb, headers: viaEdge() }), 404,
    'API_ROUTE_NOT_FOUND', 'pharmacy stays off')
})

// Service-to-service routes are called on the private service names, never
// through the public edge. Express routes without regard to case or a
// trailing slash, so the denial must too. nginx matches the decoded,
// normalized URI, so dot segments, repeated slashes and percent-encodings are
// denied by the same expressions.
const internalRoutes = [
  '/api/v1/auth/service-session',
  '/api/v1/identity/service/authorization/check',
  '/api/v1/identity/service/patient-self-authorization',
  '/api/v1/identity/service/workloads/document-scanner/authorize',
  '/api/v1/identity/outreach/authorize',
  '/api/v1/identity/outreach/patient-authorization',
  '/api/v1/ehr/internal/ocr/documents/0b9d2f9e-6b7c-4b55-9a39-1d3e0e7a1f11/source',
  '/api/v1/ehr/internal/ocr/patients/0b9d2f9e-6b7c-4b55-9a39-1d3e0e7a1f11/clinical-notes',
  '/api/v1/lab/work-items/accept-ehr-order',
  '/api/v1/lab/imports/from-ocr',
  '/api/v1/pharmacy/work-items/accept-ehr-prescription',
  '/api/v1/pharmacy/imports/from-ocr',
]

function variants(uri) {
  const [, prefix, rest] = /^(\/api\/v1\/[a-z]+\/)(.*)$/.exec(uri)
  return [uri, `${uri}/`, `${uri}?x=1`, `${prefix}${rest.toUpperCase()}`,
    `${prefix}${rest.replace(/^./, character => character.toUpperCase())}`,
    `${prefix}${rest.replace(/[aeiou]/g, character => character.toUpperCase())}/`,
    `${prefix}./${rest}`, `${prefix}x/../${rest}`, `${prefix.slice(0, -1)}//${rest}`,
    `${prefix}${rest.replace(/e/, '%65')}`, `${prefix}${rest.replace(/\//, '%2F')}`]
}

test('internal service routes answer 404 at the public gateway in case, slash, dot-segment and percent-encoded spellings', () => {
  for (const model of [gateway(production), gateway({ ...production, HID_ENABLED_API_ROUTES: allModules })]) {
    for (const route of internalRoutes) {
      for (const uri of variants(route)) {
        for (const method of ['GET', 'POST']) {
          expectProblem(model.route({ method, uri, peer: alb, headers: viaEdge() }), 404, 'API_ROUTE_NOT_FOUND', `${method} ${uri}`)
        }
      }
    }
    // The prefixes themselves (no browser route lives under them).
    for (const uri of ['/api/v1/identity/service', '/api/v1/identity/outreach', '/api/v1/ehr/internal', '/api/v1/ehr/INTERNAL/x']) {
      expectProblem(model.route({ uri, peer: alb, headers: viaEdge() }), 404, 'API_ROUTE_NOT_FOUND', uri)
    }
  }
})

// Express's URL parsing (parseurl) falls back to Node's url.parse when the
// request target holds a '#', and url.parse turns backslashes before the query
// into slashes. nginx keeps a backslash literally and ends its URI at '#', so
// "/api/v1/identity/service\authorization/check#x" missed the deny expression
// and reached the internal handler. Neither character can come from a browser
// through the Worker (the URL parser turns a path backslash into '/', drops the
// fragment and percent-encodes '#' in a query), so the gateway refuses both.
function backslashSpellings(uri) {
  const [, prefix, rest] = /^(\/api\/v1\/[a-z]+\/)(.*)$/.exec(uri)
  const backslashed = rest.includes('/') ? `${prefix}${rest.replace('/', '\\')}` : `${prefix.slice(0, -1)}\\${rest}`
  return [`${backslashed}#x`, `${backslashed}#`, `${uri}\\#`, `${backslashed}`, `${prefix.slice(0, -1)}\\${rest}#`,
    `${backslashed}?a=1#x`, `${prefix}${backslashed.slice(prefix.length).toUpperCase()}#`]
}

test('internal service routes with a backslash or "#" in the request target are never proxied', () => {
  for (const model of [gateway(production), gateway({ ...production, HID_ENABLED_API_ROUTES: allModules })]) {
    for (const route of internalRoutes) {
      for (const uri of backslashSpellings(route)) {
        for (const method of ['GET', 'POST']) {
          const outcome = model.route({ method, uri, peer: alb, headers: viaEdge() })
          assert.equal(outcome.action, 'return', `${method} ${uri} must not be proxied`)
          assert.ok([400, 404].includes(outcome.status), `${method} ${uri}: ${outcome.status}`)
        }
      }
    }
  }
  // The reviewer's spellings, on a gateway routing every module, answer 400.
  const all = gateway({ ...production, HID_ENABLED_API_ROUTES: allModules })
  for (const uri of ['/api/v1/identity/service\\authorization/check#x', '/api/v1/auth/service-session\\#',
    '/api/v1/ehr/internal\\ocr/documents/abc/source#', '/api/v1/lab/work-items\\accept-ehr-order#',
    '/api/v1/pharmacy/imports\\from-ocr#', '/api/v1/identity/outreach\\authorize#']) {
    expectProblem(all.route({ method: 'POST', uri, peer: alb, headers: viaEdge() }), 400, 'INVALID_REQUEST_TARGET', uri)
  }
})

test('a request target with a backslash in its path or a "#" anywhere is refused 400 before proxying', () => {
  const model = gateway(production)
  for (const uri of ['/api/v1/auth/session#x', '/api/v1/auth/session#', '/api/v1/auth/x\\session', '/api/v1/auth/session\\',
    '/api/v1/auth/session?q=a#b', '/api/v1/auth#x', '/api/v1/identity/me\\?x=1', '/api/v1/ehr/patients/x\\encounters']) {
    expectProblem(model.route({ method: 'POST', uri, peer: alb, headers: viaEdge() }), 400, 'INVALID_REQUEST_TARGET', uri)
    // Refused before the client-address check, so the answer does not depend on the edge.
    expectProblem(model.route({ method: 'POST', uri, peer: alb }), 400, 'INVALID_REQUEST_TARGET', `${uri} without a client address`)
  }
  // A backslash right after a module prefix matches no module location.
  expectProblem(model.route({ uri: '/api/v1/auth\\session#x', peer: alb, headers: viaEdge() }), 404, 'API_ROUTE_NOT_FOUND',
    'a backslash after the prefix')
  // A browser may send a raw backslash in a query string (the URL parser does
  // not encode it there); url.parse leaves the query alone, so it is proxied.
  for (const uri of ['/api/v1/auth/session?q=a\\b', '/api/v1/auth/session?q=%5C%23', '/api/v1/ehr/patients/x/encounters?q=%23']) {
    const outcome = model.route({ uri, peer: alb, headers: viaEdge() })
    assert.equal(outcome.action, 'proxy', uri)
    assert.equal(outcome.upstreamUri, uri, uri)
  }
  // Health checks and the non-API answers are unchanged.
  assert.equal(model.route({ uri: '/gateway-health/ready', peer: alb }).status, 200)
  expectProblem(model.route({ uri: '/ehr\\x#y', peer: alb }), 404, 'API_ONLY_ORIGIN', 'non-API path')
})

test('routes that only resemble internal ones are still proxied', () => {
  const model = gateway({ ...production, HID_ENABLED_API_ROUTES: allModules })
  for (const [uri, upstream] of [
    ['/api/v1/identity/services', 'IDENTITY_API_UPSTREAM'], ['/api/v1/identity/outreach-x', 'IDENTITY_API_UPSTREAM'],
    ['/api/v1/identity/authorization/check', 'IDENTITY_API_UPSTREAM'], ['/api/v1/identity/patient-lookup', 'IDENTITY_API_UPSTREAM'],
    ['/api/v1/auth/service-sessions', 'IDENTITY_API_UPSTREAM'], ['/api/v1/auth/session', 'IDENTITY_API_UPSTREAM'],
    ['/api/v1/ehr/internals', 'EHR_API_UPSTREAM'], ['/api/v1/ehr/documents/scan-events', 'EHR_API_UPSTREAM'],
    ['/api/v1/lab/work-items', 'LAB_API_UPSTREAM'], ['/api/v1/lab/imports', 'LAB_API_UPSTREAM'],
    ['/api/v1/lab/work-items/0b9d2f9e-6b7c-4b55-9a39-1d3e0e7a1f11', 'LAB_API_UPSTREAM'],
    ['/api/v1/pharmacy/work-items', 'PHARMACY_API_UPSTREAM'], ['/api/v1/pharmacy/imports/0b9d2f9e', 'PHARMACY_API_UPSTREAM'],
    ['/api/v1/outreach/registration-cases', 'OUTREACH_API_UPSTREAM'],
  ]) {
    const outcome = model.route({ uri, peer: alb, headers: viaEdge() })
    assert.equal(outcome.action, 'proxy', uri)
    assert.equal(outcome.upstream, upstreams[upstream], uri)
  }
})

test('non-API paths and unknown API namespaces keep their bounded answers', () => {
  const model = gateway(production)
  expectProblem(model.route({ uri: '/api/v2/anything', peer: alb, headers: viaEdge() }), 404, 'API_ROUTE_NOT_FOUND', '/api/v2')
  expectProblem(model.route({ uri: '/API/v1/auth/session', peer: alb, headers: viaEdge() }), 404, 'API_ONLY_ORIGIN', '/API')
  expectProblem(model.route({ uri: '/ehr/', peer: alb, headers: viaEdge() }), 404, 'API_ONLY_ORIGIN', '/ehr/')
  assert.ok(parseConfig(renderTemplate(template, production)).length > 0)
})

// scripts/verify-container-platform.mjs runs this contract; it must accept the
// shipped files and catch each regression this change closes.
test('the container verifier contract accepts the shipped gateway and rejects each regression', () => {
  const shipped = { template, dockerfile, includes }
  assert.deepEqual(assertGatewayContract(shipped), { routes: 10, internalRoutes: 12 })
  const proxyHeaders = includes['/etc/nginx/hid-proxy-headers.conf']
  for (const [label, mutated] of [
    ['a literal proxy_pass', { ...shipped, template: template.replace('proxy_pass $hid_upstream;', 'proxy_pass ${LAB_API_UPSTREAM};') }],
    ['no resolver', { ...shipped, template: template.replace(/resolver \$\{GATEWAY_DNS_RESOLVER\}[^;]*;/, '') }],
    ['no realip', { ...shipped, template: template.replace(/set_real_ip_from[^;]*;/, '') }],
    ['the pre-change header trusted', { ...shipped, template: template.replace('real_ip_header X-Real-IP;', 'real_ip_header X-HID-Client-IP;') }],
    ['no request-target refusal', { ...shipped, includes: { '/etc/nginx/hid-proxy-headers.conf':
      proxyHeaders.replace(/if \(\$hid_request_target_invalid\) \{[\s\S]*?\n\}\n/, '') } }],
    ['a backslash in the path allowed', { ...shipped, template: template.replace('"~^[^?]*\\\\\\\\" 1;', '') }],
    ['an internal route proxied', { ...shipped, template: template.replace('(?:service|outreach)', '(?:service)') }],
    ['a case-sensitive internal-route denial', { ...shipped, template: template.replace('location ~* ^/api/v1/auth/service-session', 'location ~ ^/api/v1/auth/service-session') }],
    ['a module routed by default', { ...shipped, template: template.replace(/(\$hid_lab_routes \{\n\s*default) off;/, '$1 on;') }],
    ['an owner swapped', { ...shipped, template: template.replace('set $hid_upstream ${OUTREACH_API_UPSTREAM};', 'set $hid_upstream ${OCR_API_UPSTREAM};') }],
    ['no client-address refusal', { ...shipped, includes: { '/etc/nginx/hid-proxy-headers.conf':
      proxyHeaders.replace(/if \(\$hid_client_address_missing\) \{[\s\S]*?\n\}\n/, '') } }],
    ['the load balancer forwarded', { ...shipped, includes: { '/etc/nginx/hid-proxy-headers.conf':
      proxyHeaders.replace('X-Forwarded-For $remote_addr', 'X-Forwarded-For $realip_remote_addr') } }],
    ['every module routed by the image', { ...shipped, dockerfile: dockerfile.replace('HID_ENABLED_API_ROUTES=identity,ehr', `HID_ENABLED_API_ROUTES=${allModules}`) }],
    ['a missing image default', { ...shipped, dockerfile: dockerfile.replace(/\n\s*VPC_CIDR=\S+ \\/, '') }],
  ]) {
    assert.notEqual(JSON.stringify(mutated), JSON.stringify(shipped), `${label}: the mutation must apply`)
    assert.throws(() => assertGatewayContract(mutated), undefined, `the contract must reject ${label}`)
  }
})
