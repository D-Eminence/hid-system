import { classifyTufPath } from './tuf-path-policy.mjs'

const DEPLOYMENT_PROFILES = Object.freeze({
  staging: Object.freeze({ host: 'updates.staging.healthidentitydirectory.com', worker: 'hid-tuf-staging' }),
  production: Object.freeze({ host: 'updates.healthidentitydirectory.com', worker: 'hid-tuf-production' }),
})

const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
})

const CACHE_HEADERS = Object.freeze({
  immutable: 'public, max-age=31536000, immutable',
  'no-store': 'no-store',
})

function deploymentFor(environment) {
  const deployment = typeof environment?.DEPLOYMENT_ENV === 'string'
    ? DEPLOYMENT_PROFILES[environment.DEPLOYMENT_ENV]
    : undefined
  if (!deployment
    || environment.EXPECTED_HOST !== deployment.host
    || environment.WORKER_NAME !== deployment.worker
    || typeof environment.ASSETS?.fetch !== 'function') {
    throw new Error('Invalid TUF repository Worker configuration')
  }
  return { name: environment.DEPLOYMENT_ENV, ...deployment }
}

function allowedHost(host, deployment) {
  if (host === deployment.host) return true
  const escapedWorker = deployment.worker.replaceAll('-', '\\-')
  return new RegExp(`^[a-f0-9]{8}-${escapedWorker}\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\\.workers\\.dev$`).test(host)
}

function securedHeaders(initialHeaders, cachePolicy, contentType) {
  const headers = new Headers(initialHeaders)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
  const cacheControl = CACHE_HEADERS[cachePolicy]
  headers.set('cache-control', cacheControl)
  headers.set('cdn-cache-control', cacheControl)
  headers.set('cloudflare-cdn-cache-control', cacheControl)
  headers.set('content-type', contentType)
  headers.delete('set-cookie')
  if (cachePolicy === 'no-store') {
    headers.delete('age')
    headers.delete('cf-cache-status')
  }
  return headers
}

function problem(request, status, code, allow) {
  const payload = JSON.stringify({
    type: 'about:blank',
    title: status >= 500 ? 'Repository unavailable' : 'Request rejected',
    status,
    code,
  })
  const headers = securedHeaders(undefined, 'no-store', 'application/problem+json; charset=utf-8')
  if (allow) headers.set('allow', allow)
  return new Response(request.method === 'HEAD' ? null : payload, { status, headers })
}

function logRepositoryError(environment, code, status) {
  const deployment = Object.hasOwn(DEPLOYMENT_PROFILES, environment?.DEPLOYMENT_ENV)
    ? environment.DEPLOYMENT_ENV
    : 'unknown'
  console.error(JSON.stringify({
    event: 'tuf_repository_error',
    component: 'tuf_repository_worker',
    deployment,
    code,
    status,
  }))
}

function assetResponse(request, response, pathPolicy) {
  const headers = securedHeaders(
    response.headers,
    pathPolicy.cachePolicy,
    pathPolicy.kind === 'metadata' ? 'application/json; charset=utf-8' : 'application/octet-stream',
  )
  const body = request.method === 'HEAD' || response.status === 304 ? null : response.body
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function createTufRepositoryWorker() {
  return {
    async fetch(request, environment) {
      let deployment
      try {
        deployment = deploymentFor(environment)
      } catch {
        logRepositoryError(environment, 'CONFIGURATION_INVALID', 503)
        return problem(request, 503, 'REPOSITORY_UNAVAILABLE')
      }

      const url = new URL(request.url)
      if (url.protocol !== 'https:') return problem(request, 400, 'HTTPS_REQUIRED')
      if (url.host !== url.hostname || !allowedHost(url.hostname, deployment)) {
        return problem(request, 421, 'HOST_DENIED')
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return problem(request, 405, 'METHOD_NOT_ALLOWED', 'GET, HEAD')
      }
      if (url.search !== '') return problem(request, 404, 'PATH_NOT_FOUND')
      if (request.headers.has('range')) return problem(request, 400, 'RANGE_UNSUPPORTED')

      const pathPolicy = classifyTufPath(url.pathname)
      if (!pathPolicy) return problem(request, 404, 'PATH_NOT_FOUND')
      if (pathPolicy.kind === 'target'
        && !pathPolicy.logicalName.startsWith(`environments/${deployment.name}/`)) {
        return problem(request, 404, 'PATH_NOT_FOUND')
      }

      let response
      try {
        response = await environment.ASSETS.fetch(request)
      } catch {
        logRepositoryError(environment, 'ASSET_BINDING_FAILURE', 503)
        return problem(request, 503, 'REPOSITORY_UNAVAILABLE')
      }

      if ([200, 304].includes(response.status)) {
        return assetResponse(request, response, pathPolicy)
      }
      if (response.status >= 500) {
        logRepositoryError(environment, 'ASSET_BINDING_FAILURE', 503)
        return problem(request, 503, 'REPOSITORY_UNAVAILABLE')
      }
      return problem(request, 404, 'PATH_NOT_FOUND')
    },
  }
}

export default createTufRepositoryWorker()
