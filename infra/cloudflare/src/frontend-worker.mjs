import {
  isLegacyMigratePath,
  migrateRedirectUrl,
} from './migrate-route-redirects.mjs'

const API_PATH = /^\/api\/v1(?:\/|$)/
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const ORIGIN_AUTH_TOKEN = /^[A-Za-z0-9._~+/-]{32,256}$/
const IPV4_ADDRESS = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

const DEPLOYMENT_PROFILES = Object.freeze({
  production: Object.freeze({
    apiOrigin: 'https://api.healthidentitydirectory.com',
    hosts: Object.freeze({
      web: 'www.healthidentitydirectory.com',
      ehr: 'ehr.healthidentitydirectory.com',
      lab: 'lab.healthidentitydirectory.com',
      pharmacy: 'pharmacy.healthidentitydirectory.com',
      ocr: 'migrate.healthidentitydirectory.com',
      outreach: 'outreach.healthidentitydirectory.com',
      admin: 'admin.healthidentitydirectory.com',
    }),
  }),
  staging: Object.freeze({
    apiOrigin: 'https://api.staging.healthidentitydirectory.com',
    hosts: Object.freeze({
      web: 'staging.healthidentitydirectory.com',
      ehr: 'ehr.staging.healthidentitydirectory.com',
      lab: 'lab.staging.healthidentitydirectory.com',
      pharmacy: 'pharmacy.staging.healthidentitydirectory.com',
      ocr: 'migrate.staging.healthidentitydirectory.com',
      outreach: 'outreach.staging.healthidentitydirectory.com',
      admin: 'admin.staging.healthidentitydirectory.com',
    }),
  }),
})

// On every response. HSTS without includeSubDomains: each host states its own
// (D6); add includeSubDomains or preload only once every subdomain of the zone
// is confirmed HTTPS-only.
const SECURITY_HEADERS = Object.freeze({
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
})

// API and edge answers are JSON: a policy under which a browser renders
// nothing from them, even when one is opened as a document.
const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'"

// The Health-id portal (apps/patient-web, ADR-052) served on www, the staging
// host and admin.*. Its build loads code only from its own /assets/ (the
// artefact verifier refuses inline script and any other script source) and
// Cloudflare Turnstile from https://challenges.cloudflare.com: api.js redirects
// within that origin, replaces its own script tag there, renders the widget in
// a frame from it and posts failure feedback to it with sendBeacon or fetch.
// Styles are its own stylesheets plus CSSOM changes (React style props,
// Turnstile), which style-src does not govern; Vite may inline a small image
// as a data: URL. No Sentry DSN or Google sign-in is deployable at launch.
const HEALTH_ID_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://challenges.cloudflare.com",
  'frame-src https://challenges.cloudflare.com',
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ')

// The hosts that serve the Health-id build. The other product hosts serve
// hid-system's legacy builds, are not deployed at launch, and need their own
// reviewed policy before they are.
const PAGE_POLICY_BY_APP = Object.freeze({
  web: HEALTH_ID_CONTENT_SECURITY_POLICY,
  admin: HEALTH_ID_CONTENT_SECURITY_POLICY,
})

const PERMISSIONS_BY_APP = Object.freeze({
  // Health-id uses no camera, microphone or location; uploads are off at launch.
  web: 'camera=(), microphone=(), geolocation=()',
  ehr: 'camera=(), microphone=(), geolocation=()',
  lab: 'camera=(), microphone=(), geolocation=()',
  pharmacy: 'camera=(), microphone=(), geolocation=()',
  ocr: 'camera=(self), microphone=(), geolocation=()',
  outreach: 'camera=(self), microphone=(), geolocation=(self)',
  admin: 'camera=(), microphone=(), geolocation=()',
})

function problem(status, code, detail, correlationId) {
  return new Response(JSON.stringify({
    type: 'about:blank',
    title: status === 502 ? 'Service unavailable' : 'Request rejected',
    status,
    detail,
    code,
    correlationId,
  }), {
    status,
    headers: {
      'content-type': 'application/problem+json; charset=utf-8',
      'cache-control': 'private, no-store, max-age=0',
      'cloudflare-cdn-cache-control': 'no-store',
      'x-correlation-id': correlationId,
      'content-security-policy': API_CONTENT_SECURITY_POLICY,
      ...SECURITY_HEADERS,
    },
  })
}

function correlationId(request) {
  const supplied = request.headers.get('x-correlation-id')?.trim()
  return supplied && CORRELATION_ID.test(supplied) ? supplied : crypto.randomUUID()
}

function configuredDeployment(environment) {
  const profile = DEPLOYMENT_PROFILES[environment.DEPLOYMENT_ENV]
  const application = typeof environment.APP_NAME === 'string' ? environment.APP_NAME : ''
  const expectedHost = profile?.hosts[application]
  if (!profile || !expectedHost
    || environment.API_ORIGIN !== profile.apiOrigin
    || environment.EXPECTED_HOST !== expectedHost
    || !ORIGIN_AUTH_TOKEN.test(environment.ORIGIN_AUTH_TOKEN ?? '')) {
    throw new Error('Worker deployment configuration is incomplete or inconsistent')
  }
  return {
    application,
    expectedHost,
    migrateOrigin: `https://${profile.hosts.ocr}`,
    origin: new URL(profile.apiOrigin),
    originAuthToken: environment.ORIGIN_AUTH_TOKEN,
  }
}

function withSecurityHeaders(response, apiResponse = false, application) {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
  headers.set('permissions-policy', PERMISSIONS_BY_APP[application]
    ?? 'camera=(), microphone=(), geolocation=()')
  // Replace whatever the origin or the asset binding sent.
  headers.delete('content-security-policy')
  headers.delete('content-security-policy-report-only')
  if (apiResponse) headers.set('content-security-policy', API_CONTENT_SECURITY_POLICY)
  else if (PAGE_POLICY_BY_APP[application]) headers.set('content-security-policy', PAGE_POLICY_BY_APP[application])
  if (apiResponse) {
    headers.set('cache-control', 'private, no-store, max-age=0')
    headers.set('cloudflare-cdn-cache-control', 'no-store')
    headers.set('pragma', 'no-cache')
    headers.delete('age')
    headers.delete('cf-cache-status')
  } else if (new URL(response.url || 'https://static.invalid/').pathname.endsWith('/service-worker.js')) {
    headers.set('cache-control', 'no-cache, no-store, must-revalidate')
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function applicationRouteRedirect(request, requestUrl, deployment) {
  if (!['GET', 'HEAD'].includes(request.method) || !isLegacyMigratePath(requestUrl.pathname)) return null
  if (deployment.application !== 'ocr' && deployment.application !== 'web') return null

  const destinationOrigin = deployment.application === 'ocr'
    ? requestUrl.origin
    : deployment.migrateOrigin
  return Response.redirect(
    migrateRedirectUrl(destinationOrigin, requestUrl.pathname, requestUrl.search),
    308,
  )
}

// The client address Cloudflare observed, as one canonical IPv4 or IPv6
// address, or null. IPv4 must be four plain decimal octets; IPv6 is parsed by
// the URL host parser (no zone identifier) and serialized in its canonical
// form. A list, a port, brackets or anything else is not an address.
function clientAddress(value) {
  if (typeof value !== 'string') return null
  if (IPV4_ADDRESS.test(value)) return value
  if (!/^[0-9A-Fa-f:.]{2,45}$/.test(value) || !value.includes(':')) return null
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1)
  } catch {
    return null
  }
}

// The client network the AWS WAF's per-client rate limit counts (A7): an IPv4
// address, or the /64 network address of an IPv6 address (one subscriber
// allocation, as Identity's own limits count it), so that rotating addresses
// inside a /64 does not escape the limit. An IPv4-mapped IPv6 address counts as
// its IPv4 address. Takes the canonical address clientAddress returns.
function clientNetwork(address) {
  if (!address.includes(':')) return address
  const [head, tail = ''] = address.split('::')
  const leading = head ? head.split(':') : []
  const trailing = tail ? tail.split(':') : []
  const groups = [...leading, ...Array(8 - leading.length - trailing.length).fill('0'), ...trailing]
    .map(group => Number.parseInt(group, 16))
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
  }
  return new URL(`http://[${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::]/`).hostname.slice(1, -1)
}

async function proxyApi(request, deployment, requestUrl) {
  const requestCorrelationId = correlationId(request)
  const upstream = new URL(requestUrl.pathname + requestUrl.search, deployment.origin)
  const headers = new Headers(request.headers)
  // Read before the forwarding headers are discarded. Cloudflare sets
  // CF-Connecting-IP on every inbound request, so a client cannot choose it.
  const client = clientAddress(request.headers.get('cf-connecting-ip'))
  for (const name of [
    'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'forwarded', 'host', 'x-forwarded-for',
    'x-forwarded-host', 'x-forwarded-proto', 'x-hid-client-network', 'x-hid-edge-origin', 'x-real-ip',
  ]) headers.delete(name)
  // The only client address the AWS gateway trusts, and only from the VPC;
  // without it the gateway refuses the request in staging and production.
  // Workers built before this change delete X-Real-IP, so a stale Worker
  // leaves the gateway without an address instead of passing a caller's on.
  // X-HID-Client-Network is the WAF's per-client rate-limit key; the gateway
  // drops it before any backend.
  if (client) {
    headers.set('x-real-ip', client)
    headers.set('x-hid-client-network', clientNetwork(client))
  }
  headers.set('x-correlation-id', requestCorrelationId)
  headers.set('x-forwarded-host', requestUrl.host)
  headers.set('x-forwarded-proto', 'https')
  headers.set('x-hid-edge-origin', requestUrl.origin)
  headers.set('x-hid-origin-authorization', deployment.originAuthToken)

  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
    signal: request.signal,
    cf: { cacheEverything: false, cacheTtl: 0 },
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body

  try {
    const response = await fetch(upstream, init)
    const secured = withSecurityHeaders(response, true, deployment.application)
    secured.headers.set('x-correlation-id', response.headers.get('x-correlation-id') ?? requestCorrelationId)
    return secured
  } catch {
    return problem(502, 'API_ORIGIN_UNAVAILABLE', 'A required platform service is temporarily unavailable.', requestCorrelationId)
  }
}

export function createFrontendWorker() {
  return {
    async fetch(request, environment) {
      const url = new URL(request.url)
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
        return problem(400, 'HTTPS_REQUIRED', 'HTTPS is required.', correlationId(request))
      }
      let deployment
      try {
        deployment = configuredDeployment(environment)
      } catch {
        return problem(502, 'EDGE_CONFIGURATION_INVALID', 'The API edge route is unavailable.', correlationId(request))
      }
      if (url.hostname !== deployment.expectedHost) {
        return problem(421, 'HOST_DENIED', 'This host is not configured for the requested application.', correlationId(request))
      }
      if (API_PATH.test(url.pathname)) return proxyApi(request, deployment, url)
      if (url.pathname.startsWith('/api/')) {
        return problem(404, 'API_ROUTE_NOT_FOUND', 'The requested API route is not available.', correlationId(request))
      }
      const redirect = applicationRouteRedirect(request, url, deployment)
      if (redirect) return withSecurityHeaders(redirect, false, deployment.application)
      const assetResponse = await environment.ASSETS.fetch(request)
      return withSecurityHeaders(assetResponse, false, deployment.application)
    },
  }
}

export default createFrontendWorker()
