// The API gateway's routing and trust-boundary contract, checked by
// scripts/verify-container-platform.mjs and scripts/tests/gateway-config.test.mjs
// against the nginx model in ./nginx-config-model.mjs (nginx itself is not run).

import assert from 'node:assert/strict'
import { GatewayModel, expandIncludes, parseConfig, renderTemplate, templateVariables } from './nginx-config-model.mjs'

/** Browser API prefixes and the upstream variable of the module that owns each. */
export const routeOwners = Object.freeze([
  ['/api/v1/auth', 'identity', 'IDENTITY_API_UPSTREAM'], ['/api/v1/identity', 'identity', 'IDENTITY_API_UPSTREAM'],
  ['/api/v1/audit', 'identity', 'IDENTITY_API_UPSTREAM'], ['/api/v1/admin', 'identity', 'IDENTITY_API_UPSTREAM'],
  ['/api/v1/commercial', 'identity', 'IDENTITY_API_UPSTREAM'], ['/api/v1/ehr', 'ehr', 'EHR_API_UPSTREAM'],
  ['/api/v1/lab', 'lab', 'LAB_API_UPSTREAM'], ['/api/v1/pharmacy', 'pharmacy', 'PHARMACY_API_UPSTREAM'],
  ['/api/v1/ocr', 'ocr', 'OCR_API_UPSTREAM'], ['/api/v1/outreach', 'outreach', 'OUTREACH_API_UPSTREAM'],
])

/** Service-to-service routes that the public gateway must never proxy. */
export const internalRoutes = Object.freeze([
  '/api/v1/auth/service-session',
  '/api/v1/identity/service/authorization/check',
  '/api/v1/identity/service/patient-self-authorization',
  '/api/v1/identity/service/workloads/document-scanner/authorize',
  '/api/v1/identity/outreach/authorize',
  '/api/v1/identity/outreach/patient-authorization',
  '/api/v1/ehr/internal/ocr/documents/0b9d2f9e-6b7c-4b55-9a39-1d3e0e7a1f11/source',
  '/api/v1/ehr/internal/ocr/patients/0b9d2f9e-6b7c-4b55-9a39-1d3e0e7a1f11/clinical-notes',
  '/api/v1/ehr/documents/scan-events',
  '/api/v1/lab/work-items/accept-ehr-order',
  '/api/v1/lab/imports/from-ocr',
  '/api/v1/pharmacy/work-items/accept-ehr-prescription',
  '/api/v1/pharmacy/imports/from-ocr',
])

const modules = ['identity', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach']
const vpcPeer = '10.40.1.10'
const client = '198.51.100.23'

function problemCode(outcome) {
  return outcome.action === 'return' && outcome.body ? JSON.parse(outcome.body).code : undefined
}

/** Variables the access log must never record (request line, query, cookies, credentials). */
export const forbiddenLogVariables = Object.freeze([
  /\$request(?![_a-z])/, /\$request_uri\b/, /\$request_body\b/, /\$args\b/, /\$arg_/, /\$query_string\b/, /\$is_args\b/,
  /\$http_referer\b/, /\$http_cookie\b/, /\$cookie_/, /\$http_authorization\b/, /\$http_x_csrf_token\b/,
  /\$http_x_hid_origin_authorization\b/, /\$sent_http_set_cookie\b/, /\$upstream_http_set_cookie\b/,
])

// The largest body any launch service accepts as JSON (ehr-api 512 KiB).
const maxBodyBytes = 512 * 1024

function sizeInBytes(value) {
  const match = /^(\d+)([kKmMgG]?)$/.exec(value ?? '')
  assert.ok(match, `unparseable client_max_body_size ${value}`)
  return Number(match[1]) * ({ '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 })[match[2].toLowerCase()]
}

/**
 * Asserts the contract for the gateway files as the image ships them.
 * `dockerfile` supplies the local ENV defaults; `includes` maps runtime paths
 * (as the template includes them) to file contents.
 */
export function assertGatewayContract({ template, dockerfile, includes }) {
  const defaults = Object.fromEntries([...dockerfile.matchAll(/^\s*(?:ENV\s+)?([A-Z][A-Z0-9_]*)=(\S+?)(?:\s*\\)?$/gm)]
    .map(([, name, value]) => [name, value]))
  for (const name of templateVariables(template)) {
    assert.ok(Object.hasOwn(defaults, name), `gateway image must define a default for ${name}`)
  }
  assert.equal(defaults.HID_REQUIRE_CLIENT_IP, 'false', 'local runs do not require the client address')
  assert.equal(defaults.HID_ENABLED_API_ROUTES, 'identity,ehr', 'the image routes only the launch modules by default')
  for (const [, argument] of template.matchAll(/proxy_pass\s+([^;]+);/g)) {
    assert.equal(argument.trim(), '$hid_upstream', 'every proxy_pass must use the per-request resolved upstream variable')
  }
  assert.match(template, /resolver \$\{GATEWAY_DNS_RESOLVER\} valid=10s ipv6=off;/, 'gateway must re-resolve upstream names')
  assert.match(template, /set_real_ip_from \$\{VPC_CIDR\};/, 'gateway must trust X-Real-IP only from the VPC')
  // X-Real-IP, which the Worker before this change deleted: behind a stale or
  // rolled-back Worker requests fail closed instead of carrying an address the
  // caller chose.
  assert.match(template, /real_ip_header X-Real-IP;/, 'gateway must take the client address from X-Real-IP')

  const upstreams = Object.fromEntries(routeOwners.map(([, module, variable]) =>
    [variable, `http://${module}-api.contract.invalid:3000`]))
  const environment = {
    ...upstreams, VPC_CIDR: '10.40.0.0/16', GATEWAY_DNS_RESOLVER: '10.40.0.2',
    HID_REQUIRE_CLIENT_IP: 'true', HID_ENABLED_API_ROUTES: modules.join(','),
  }
  const all = new GatewayModel(renderTemplate(template, environment), includes)
  for (const [prefix, module, variable] of routeOwners) {
    for (const uri of [prefix, `${prefix}/x/Y?z=%2F`]) {
      const outcome = all.route({ method: 'POST', uri, peer: vpcPeer, headers: { 'x-real-ip': client } })
      assert.equal(outcome.action, 'proxy', `${uri} must be proxied when ${module} is enabled`)
      assert.equal(outcome.upstream, upstreams[variable], `production gateway ownership mismatch for ${prefix}`)
      assert.equal(outcome.upstreamUri, uri, `${uri} must reach ${module} unchanged`)
      assert.equal(outcome.upstreamHeaders['x-forwarded-for'], client, `${uri} must forward the client address`)
      assert.equal(outcome.upstreamHeaders['x-real-ip'], '', `${uri} must not pass the raw client-address header on`)
    }
    for (const headers of [{}, { 'x-hid-client-ip': client }]) {
      const refused = all.route({ uri: `${prefix}/x`, peer: vpcPeer, headers })
      assert.equal(problemCode(refused), 'CLIENT_ADDRESS_REQUIRED', `${prefix} must refuse a request without a client address`)
      assert.equal(refused.status, 403)
    }
    for (const uri of [`${prefix}/x#y`, `${prefix}/x\\y`, `${prefix}/x?y#z`]) {
      const refused = all.route({ uri, peer: vpcPeer, headers: { 'x-real-ip': client } })
      assert.equal(problemCode(refused), 'INVALID_REQUEST_TARGET', `${uri} must be refused before proxying`)
      assert.equal(refused.status, 400)
    }
  }
  for (const route of internalRoutes) {
    for (const uri of [route, `${route}/`, route.replace(/\/([a-z-]+)$/, (_whole, last) => `/${last.toUpperCase()}`),
      route.replace(/^(\/api\/v1\/[a-z]+\/)(.)/, (_whole, prefix, first) => `${prefix}${first.toUpperCase()}`)]) {
      const outcome = all.route({ method: 'POST', uri, peer: vpcPeer, headers: { 'x-real-ip': client } })
      assert.equal(problemCode(outcome), 'API_ROUTE_NOT_FOUND', `internal route ${uri} must not be proxied`)
    }
    // Express (parseurl, then url.parse on a '#') reads a backslash before the
    // query as '/'; nginx does not, so these miss the location's deny.
    const backslashed = route.replace(/^(\/api\/v1\/[a-z]+\/[^/]+)\//, (_whole, head) => `${head}\\`)
    for (const uri of [`${backslashed}#x`, `${route}\\#`]) {
      const outcome = all.route({ method: 'POST', uri, peer: vpcPeer, headers: { 'x-real-ip': client } })
      assert.notEqual(outcome.action, 'proxy', `internal route ${uri} must not be proxied`)
    }
  }
  // A8: an upstream's own error answer reaches the client unchanged; only the
  // errors nginx produces itself get the bounded UPSTREAM_UNAVAILABLE answer.
  const expanded = JSON.stringify(expandIncludes(parseConfig(renderTemplate(template, environment)), includes))
  assert.doesNotMatch(expanded, /"name":"proxy_intercept_errors","args":\["on"\]/,
    'the gateway must not replace upstream error answers (proxy_intercept_errors on)')
  const pages = all.errorPages()
  for (const status of ['502', '503', '504']) {
    assert.equal(pages[status]?.target, '@upstream_unavailable', `nginx's own ${status} must answer UPSTREAM_UNAVAILABLE`)
  }
  assert.equal(problemCode(all.named('@upstream_unavailable')), 'UPSTREAM_UNAVAILABLE')
  // D7: the server's own access log, without the request line or query string.
  const format = all.logFormats.get('hid_api')
  assert.ok(format, 'the gateway must define log_format hid_api')
  assert.equal(format.escape, 'json', 'the access log must JSON-escape request values')
  for (const variable of ['$request_method', '$uri', '$status', '$request_time', '$request_id']) {
    assert.ok(format.format.includes(variable), `the access log must record ${variable}`)
  }
  for (const forbidden of forbiddenLogVariables) {
    assert.doesNotMatch(format.format, forbidden, `the access log must not record ${forbidden}`)
  }
  assert.deepEqual(all.directives('access_log').map(item => item.args), [['/var/log/nginx/access.log', 'hid_api']],
    'the server must replace the image\'s http-level access_log (format main logs the request line)')
  // WAF-CRS-BODY: bodies are bounded at the largest service limit, with Problem Details.
  assert.equal(pages['413']?.target, '@payload_too_large', 'an oversized body must answer Problem Details')
  assert.equal(problemCode(all.named('@payload_too_large')), 'PAYLOAD_TOO_LARGE')
  for (const [prefix] of routeOwners) {
    const outcome = all.route({ method: 'POST', uri: `${prefix}/x`, peer: vpcPeer, headers: { 'x-real-ip': client } })
    assert.deepEqual(outcome.accessLog, [['/var/log/nginx/access.log', 'hid_api']], `${prefix} must use the gateway access log`)
    assert.ok(sizeInBytes(outcome.clientMaxBodySize) <= maxBodyBytes,
      `${prefix} accepts bodies up to ${outcome.clientMaxBodySize}; the bound is 512k`)
  }
  assert.ok(all.directives('client_max_body_size').length === 1, 'the server must state the body bound explicitly')

  const launch = new GatewayModel(renderTemplate(template, { ...environment, HID_ENABLED_API_ROUTES: 'identity,ehr' }), includes)
  for (const [prefix, module] of routeOwners) {
    const outcome = launch.route({ uri: `${prefix}/x`, peer: vpcPeer, headers: { 'x-real-ip': client } })
    if (module === 'identity' || module === 'ehr') assert.equal(outcome.action, 'proxy', `${prefix} is a launch route`)
    else assert.equal(problemCode(outcome), 'API_ROUTE_NOT_FOUND', `${prefix} must be closed unless ${module} is enabled`)
  }
  return { routes: routeOwners.length, internalRoutes: internalRoutes.length }
}
