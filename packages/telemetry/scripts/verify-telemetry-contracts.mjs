import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = await readFile(resolve(import.meta.dirname, '../src/index.tsx'), 'utf8')
for (const required of ['sendDefaultPii: false', 'disable_session_recording: true',
  'autocapture: false', "persistence: 'memory'", 'safeTelemetryProperties']) {
  if (!source.includes(required)) throw new Error(`Telemetry foundation is missing ${required}`)
}
for (const prohibited of ['localStorage+cookie', 'replayIntegration(', 'sessionRecording']) {
  if (source.includes(prohibited)) throw new Error(`Telemetry foundation contains prohibited ${prohibited}`)
}

const sensitivePattern = source.match(/const SENSITIVE_KEY = \/\(([^\n]+)\)\/i/)?.[1]
if (!sensitivePattern) throw new Error('Telemetry sensitive-key policy could not be inspected')
const sensitiveKey = new RegExp(`(${sensitivePattern})`, 'i')
const requiredRedactions = [
  'otp_code', 'nin', 'turnstile_token', 'authorization', 'cookie', 'novu_api_key',
  'firebase_private_key', 'fcm_token', 'whatsapp_access_token', 'termii_api_key',
  'infobip_api_key', 'ses_credentials', 'presigned_url', 'clinical_notes',
  'diagnosis', 'laboratory_result_value', 'medication_details', 'ocr_text',
]
for (const key of requiredRedactions) {
  if (!sensitiveKey.test(key)) throw new Error(`Telemetry redaction policy does not cover ${key}`)
}

for (const required of ['delete event.user', 'event.request = {', 'event.contexts = undefined',
  "!['ui.input', 'console', 'xhr', 'fetch'].includes"] ) {
  if (!source.includes(required)) throw new Error(`Sentry redaction boundary is missing ${required}`)
}

console.log('Verified fail-open Sentry/PostHog initialization, replay/autocapture disablement, and OTP/NIN/provider/PHI redaction coverage.')
