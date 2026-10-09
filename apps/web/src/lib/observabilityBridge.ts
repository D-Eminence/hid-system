type ObservabilityModule = typeof import('./observability')
type IdentifyParams = {
  appRole: string
  id: string
  staffRole?: string | null
}

type PendingEvent = {
  event: string
  properties?: Record<string, unknown>
}

type PendingException = {
  context?: Record<string, unknown>
  error: unknown
}

const MAX_PENDING_EVENTS = 50
const MAX_PENDING_EXCEPTIONS = 20

let modulePromise: Promise<ObservabilityModule> | null = null
let initStarted = false
let initialized = false
let pendingRoutePath: string | null = null
let pendingIdentity: IdentifyParams | null = null
let shouldClearIdentity = false
let isCapturingException = false

const pendingEvents: PendingEvent[] = []
const pendingExceptions: PendingException[] = []

function captureExceptionSafely(module: ObservabilityModule, error: unknown, context?: Record<string, unknown>) {
  // Reporting must never recursively report an error raised by the reporting SDK itself.
  if (isCapturingException) return

  isCapturingException = true
  try {
    module.captureException(error, context)
  } finally {
    isCapturingException = false
  }
}

function loadObservabilityModule() {
  if (!modulePromise) {
    modulePromise = import('./observability')
  }
  return modulePromise
}

function pushBounded<T>(queue: T[], value: T, maxSize: number) {
  if (queue.length >= maxSize) {
    queue.shift()
  }
  queue.push(value)
}

async function flushPending(module: ObservabilityModule) {
  if (shouldClearIdentity) {
    module.clearObservabilityIdentity()
    shouldClearIdentity = false
  }

  if (pendingIdentity) {
    module.identifyObservabilityUser(pendingIdentity)
  }

  if (pendingRoutePath) {
    module.updateObservabilityForRoute(pendingRoutePath)
  }

  while (pendingEvents.length > 0) {
    const next = pendingEvents.shift()
    if (!next) break
    module.trackEvent(next.event, next.properties)
  }

  while (pendingExceptions.length > 0) {
    const next = pendingExceptions.shift()
    if (!next) break
    captureExceptionSafely(module, next.error, next.context)
  }
}

async function ensureObservabilityInitialized() {
  const module = await loadObservabilityModule()

  if (!initialized) {
    await module.initObservability()
    initialized = true
  }

  await flushPending(module)
  return module
}

function runIfInitialized(callback: (module: ObservabilityModule) => void) {
  if (!initialized) return

  void loadObservabilityModule()
    .then(module => callback(module))
    .catch(() => undefined)
}

export function initObservability() {
  if (initStarted) {
    void ensureObservabilityInitialized().catch(() => undefined)
    return
  }

  initStarted = true
  void ensureObservabilityInitialized().catch(() => undefined)
}

export function updateObservabilityForRoute(pathname: string) {
  pendingRoutePath = pathname
  runIfInitialized(module => {
    module.updateObservabilityForRoute(pathname)
  })
}

export function identifyObservabilityUser(params: IdentifyParams) {
  shouldClearIdentity = false
  pendingIdentity = params
  runIfInitialized(module => {
    module.identifyObservabilityUser(params)
  })
}

export function clearObservabilityIdentity() {
  pendingIdentity = null
  shouldClearIdentity = true
  pendingEvents.length = 0
  runIfInitialized(module => {
    module.clearObservabilityIdentity()
  })
}

export function trackEvent(event: string, properties?: Record<string, unknown>) {
  if (!initialized) {
    pushBounded(pendingEvents, { event, properties }, MAX_PENDING_EVENTS)
    return
  }

  runIfInitialized(module => {
    module.trackEvent(event, properties)
  })
}

export function captureException(error: unknown, context?: Record<string, unknown>) {
  if (!initialized) {
    pushBounded(pendingExceptions, { context, error }, MAX_PENDING_EXCEPTIONS)
    return
  }

  runIfInitialized(module => {
    captureExceptionSafely(module, error, context)
  })
}
