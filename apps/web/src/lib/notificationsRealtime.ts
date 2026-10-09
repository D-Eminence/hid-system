type Listener = () => void

const listeners = new Set<Listener>()
let pollTimer: number | null = null
const POLL_INTERVAL_MS = 30_000

function pollApiView() {
  if (document.visibilityState !== 'visible') return
  listeners.forEach(listener => {
    listener()
  })
}

function ensurePolling() {
  if (pollTimer !== null) return
  pollTimer = window.setInterval(pollApiView, POLL_INTERVAL_MS)
}

function teardownPollingIfIdle() {
  if (listeners.size > 0 || pollTimer === null) return
  window.clearInterval(pollTimer)
  pollTimer = null
}

export function subscribeToNotifications(onChange: Listener) {
  listeners.add(onChange)
  ensurePolling()

  return () => {
    listeners.delete(onChange)
    teardownPollingIfIdle()
  }
}
