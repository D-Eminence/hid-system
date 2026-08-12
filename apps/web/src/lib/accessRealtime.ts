type AccessRealtimeTable =
  | 'hid_access_requests'
  | 'hid_access_grants'
  | 'hid_audit_events'
  | 'hid_medical_records'
  | 'hid_medical_record_versions'
  | 'hid_medical_record_files'

type AccessRealtimeChange = {
  table: AccessRealtimeTable
}

type Listener = (change: AccessRealtimeChange) => void

const listeners = new Set<Listener>()
let pollTimer: number | null = null
const POLL_INTERVAL_MS = 30_000

function notify(table: AccessRealtimeTable) {
  listeners.forEach(listener => {
    listener({ table })
  })
}

function pollApiViews() {
  if (document.visibilityState !== 'visible') return
  notify('hid_medical_records')
}

function ensurePolling() {
  if (pollTimer !== null) return
  pollTimer = window.setInterval(pollApiViews, POLL_INTERVAL_MS)
}

function teardownPollingIfIdle() {
  if (listeners.size > 0 || pollTimer === null) return
  window.clearInterval(pollTimer)
  pollTimer = null
}

export function subscribeToAccessChanges(onChange: Listener) {
  listeners.add(onChange)
  ensurePolling()

  return () => {
    listeners.delete(onChange)
    teardownPollingIfIdle()
  }
}
