import { migrateRedirectUrl } from './migrate-route-redirects.mjs'

const DEPLOYMENTS = Object.freeze({
  production: Object.freeze({
    sourceHost: 'ocr.healthidentitydirectory.com',
    destinationOrigin: 'https://migrate.healthidentitydirectory.com',
  }),
  staging: Object.freeze({
    sourceHost: 'ocr.staging.healthidentitydirectory.com',
    destinationOrigin: 'https://migrate.staging.healthidentitydirectory.com',
  }),
})

function configuredDeployment(environment) {
  const deployment = DEPLOYMENTS[environment.DEPLOYMENT_ENV]
  if (!deployment || environment.EXPECTED_HOST !== deployment.sourceHost
    || environment.TARGET_ORIGIN !== deployment.destinationOrigin) return null
  return deployment
}

export function createLegacyOcrDomainRedirectWorker() {
  return {
    fetch(request, environment) {
      const incoming = new URL(request.url)
      const deployment = configuredDeployment(environment)
      if (!deployment) return new Response('Redirect unavailable', { status: 502 })
      if (incoming.hostname !== deployment.sourceHost) return new Response('Misdirected request', { status: 421 })
      const target = migrateRedirectUrl(
        deployment.destinationOrigin,
        incoming.pathname,
        incoming.search,
      )
      return new Response(null, {
        status: 308,
        headers: {
          location: target.toString(),
          'cache-control': 'public, max-age=300',
          'referrer-policy': 'strict-origin-when-cross-origin',
          'x-content-type-options': 'nosniff',
        },
      })
    },
  }
}

export default createLegacyOcrDomainRedirectWorker()
