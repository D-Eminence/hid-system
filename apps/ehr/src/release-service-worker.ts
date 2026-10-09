export type ScopedServiceWorkerRegister = (options: {
  scriptUrl: string
  scope: string
  enabled?: boolean
}) => Promise<ServiceWorkerRegistration | null>

interface ReleaseServiceWorkerOptions {
  scriptUrl: string
  scope: string
  releaseSha: string
  enabled: boolean
  serviceWorker?: ServiceWorkerContainer
  reload: () => void
  register: ScopedServiceWorkerRegister
}

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/

function assertReleaseRegistration(scriptUrl: string, scope: string, releaseSha: string): void {
  if (!GIT_SHA_PATTERN.test(releaseSha)) throw new Error('EHR release SHA is invalid')
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(scope)) throw new Error('EHR service-worker scope is invalid')
  const expectedUrl = `${scope}service-worker.js?release=${releaseSha}`
  if (scriptUrl !== expectedUrl) throw new Error('EHR service-worker URL is not bound to the release SHA')
}

export async function registerReleaseBoundServiceWorker(
  options: ReleaseServiceWorkerOptions,
): Promise<ServiceWorkerRegistration | null> {
  assertReleaseRegistration(options.scriptUrl, options.scope, options.releaseSha)
  if (!options.enabled || options.serviceWorker === undefined) return null

  let refreshed = false
  options.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshed) return
    refreshed = true
    options.reload()
  })

  const registration = await options.register({
    scriptUrl: options.scriptUrl,
    scope: options.scope,
    enabled: true,
  })
  if (registration === null) return null
  try {
    await registration.update()
  } catch {
    // Keep the currently verified offline shell available when an update check
    // cannot reach the network. A later page load retries registration.
  }
  return registration
}
