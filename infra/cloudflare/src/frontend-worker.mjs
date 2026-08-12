const API_PATH = /^\/api\/v1(?:\/|$)/
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const ORIGIN_AUTH_TOKEN = /^[A-Za-z0-9._~+/-]{32,256}$/

const DEPLOYMENT_PROFILES = Object.freeze({
  production: Object.freeze({
    apiOrigin: 'https://api.healthidentitydirectory.com',
    hosts: Object.freeze({
      web: 'www.healthidentitydirectory.com',
      ehr: 'ehr.healthidentitydirectory.com',
      lab: 'lab.healthidentitydirectory.com',
      pharmacy: 'pharmacy.healthidentitydirectory.com',
      ocr: 'ocr.healthidentitydirectory.com',
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
      ocr: 'ocr.staging.healthidentitydirectory.com',
      outreach: 'outreach.staging.healthidentitydirectory.com',
      admin: 'admin.staging.healthidentitydirectory.com',
    }),
  }),
})

const SECURITY_HEADERS = Object.freeze({
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
})

const PERMISSIONS_BY_APP = Object.freeze({
  web: 'camera=(self), microphone=(self), geolocation=()',
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
  return { application, expectedHost, origin: new URL(profile.apiOrigin), originAuthToken: environment.ORIGIN_AUTH_TOKEN }
}

function withSecurityHeaders(response, apiResponse = false, application) {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
  headers.set('permissions-policy', PERMISSIONS_BY_APP[application]
    ?? 'camera=(), microphone=(), geolocation=()')
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

async function proxyApi(request, deployment, requestUrl) {
  const requestCorrelationId = correlationId(request)
  const upstream = new URL(requestUrl.pathname + requestUrl.search, deployment.origin)
  const headers = new Headers(request.headers)
  for (const name of [
    'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'forwarded', 'host', 'x-forwarded-for',
    'x-forwarded-host', 'x-forwarded-proto', 'x-hid-edge-origin', 'x-real-ip',
  ]) headers.delete(name)
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
      const assetResponse = await environment.ASSETS.fetch(request)
      return withSecurityHeaders(assetResponse, false, deployment.application)
    },
  }
}

export default createFrontendWorker()
