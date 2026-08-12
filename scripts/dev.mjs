import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { randomBytes } from 'node:crypto'
import { environmentWithLocalFiles } from './local-environment.mjs'
import { resolveDevelopmentPorts } from './ports.mjs'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const children = []
let shuttingDown = false
const ports = resolveDevelopmentPorts()
const requestedFrontends = new Set(
  (process.env.HID_FRONTEND_APPS ?? 'web,ehr,lab,pharmacy,ocr,outreach,admin')
    .split(',').map(value => value.trim()).filter(Boolean),
)
const platformEnvironment = environmentWithLocalFiles([
  resolve(process.cwd(), '.env.local'),
])
const ehrApiEnvironment = environmentWithLocalFiles([
  resolve(process.cwd(), '.env.local'),
  resolve(process.cwd(), 'services/ehr-api/.env.local'),
])
const ocrWorkerEnvironment = environmentWithLocalFiles([
  resolve(process.cwd(), '.env.local'),
  resolve(process.cwd(), 'services/ocr-worker/.env.local'),
])
const eventDispatcherEnvironment = environmentWithLocalFiles([
  resolve(process.cwd(), '.env.local'),
  resolve(process.cwd(), 'services/event-dispatcher/.env.local'),
])
const notificationApiEnvironment = environmentWithLocalFiles([
  resolve(process.cwd(), '.env.local'),
  resolve(process.cwd(), 'services/notification-api/.env.local'),
])
const notificationWorkerEnvironment = environmentWithLocalFiles([
  resolve(process.cwd(), '.env.local'),
  resolve(process.cwd(), 'services/notification-worker/.env.local'),
])
const labInternalServiceToken = platformEnvironment.LAB_INTERNAL_SERVICE_TOKEN ?? randomBytes(32).toString('base64url')
const pharmacyInternalServiceToken = platformEnvironment.PHARMACY_INTERNAL_SERVICE_TOKEN ?? randomBytes(32).toString('base64url')
const outreachIdentityInternalServiceToken = platformEnvironment.OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN ?? randomBytes(32).toString('base64url')
const identityEhrInternalServiceToken = platformEnvironment.IDENTITY_EHR_INTERNAL_SERVICE_TOKEN ?? randomBytes(32).toString('base64url')
const identityLabInternalServiceToken = platformEnvironment.IDENTITY_LAB_INTERNAL_SERVICE_TOKEN ?? randomBytes(32).toString('base64url')
const identityPharmacyInternalServiceToken = platformEnvironment.IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN ?? randomBytes(32).toString('base64url')
const identityOcrInternalServiceToken = platformEnvironment.IDENTITY_OCR_INTERNAL_SERVICE_TOKEN ?? randomBytes(32).toString('base64url')
const ehrInternalServiceToken = platformEnvironment.EHR_INTERNAL_SERVICE_TOKEN ?? randomBytes(32).toString('base64url')
const notificationIdentityInternalServiceToken = platformEnvironment.NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN ?? randomBytes(32).toString('base64url')
const otpHmacKey = platformEnvironment.OTP_HMAC_KEY_B64 ?? randomBytes(32).toString('base64')
const localCorsOrigins = platformEnvironment.CORS_ORIGINS ?? `http://localhost:${ports.gateway}`
const identityAuthSigningSecret = platformEnvironment.AUTH_SIGNING_SECRET ?? randomBytes(32).toString('base64url')
const identityAuthLoginPepper = platformEnvironment.AUTH_LOGIN_PEPPER ?? randomBytes(32).toString('base64url')
const sharedLocalDatabaseUrl = ehrApiEnvironment.DATABASE_URL ?? platformEnvironment.DATABASE_URL

function start(label, prefix, script, envOverrides = {}, baseEnvironment = process.env) {
  const child = spawn(npmCommand, ['--prefix', prefix, 'run', script], {
    cwd: process.cwd(),
    env: { ...baseEnvironment, ...envOverrides },
    stdio: 'inherit',
  })

  child.once('error', (error) => {
    console.error(`[${label}] failed to start: ${error.message}`)
    if (!shuttingDown) shutdown(1)
  })

  child.once('exit', (code, signal) => {
    if (shuttingDown) return
    if (code !== 0) {
      console.error(`[${label}] stopped with ${signal ?? `exit code ${code}`}`)
      shutdown(code ?? 1)
    }
  })

  children.push(child)
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 250)
}

process.once('SIGINT', () => shutdown(0))
process.once('SIGTERM', () => shutdown(0))

console.log(`[hid-system] one-origin development gateway: http://localhost:${ports.gateway}`)
console.log(`[hid-system] Identity: http://localhost:${ports.gateway}/`)
console.log(`[hid-system] EHR:      http://localhost:${ports.gateway}/ehr/`)
console.log(`[hid-system] Lab:      http://localhost:${ports.gateway}/lab/`)
console.log(`[hid-system] Pharmacy: http://localhost:${ports.gateway}/pharmacy/`)
console.log(`[hid-system] OCR:      http://localhost:${ports.gateway}/ocr/`)
console.log(`[hid-system] Outreach: http://localhost:${ports.gateway}/outreach/`)
console.log(`[hid-system] Admin:    http://localhost:${ports.gateway}/admin/`)
console.log(`[hid-system] API:      http://localhost:${ports.gateway}/api/v1/ (when configured)`)
console.log(`[hid-system] internal EHR UI:  http://127.0.0.1:${ports.ehrUi}/ehr/`)
console.log(`[hid-system] internal Lab UI:  http://127.0.0.1:${ports.labUi}/lab/`)
console.log(`[hid-system] internal Pharmacy UI: http://127.0.0.1:${ports.pharmacyUi}/pharmacy/`)
console.log(`[hid-system] internal OCR UI: http://127.0.0.1:${ports.ocrUi}/ocr/`)
console.log(`[hid-system] internal Outreach UI: http://127.0.0.1:${ports.outreachUi}/outreach/`)
console.log(`[hid-system] internal EHR API: http://127.0.0.1:${ports.ehrApi}/api/v1/`)
console.log(`[hid-system] internal Identity API: http://127.0.0.1:${ports.identityApi}/api/v1/`)
console.log(`[hid-system] internal Lab API: http://127.0.0.1:${ports.labApi}/api/v1/lab/`)
console.log(`[hid-system] internal Pharmacy API: http://127.0.0.1:${ports.pharmacyApi}/api/v1/pharmacy/`)
console.log(`[hid-system] internal OCR API: http://127.0.0.1:${ports.ocrApi}/api/v1/ocr/`)
console.log(`[hid-system] internal Outreach API: http://127.0.0.1:${ports.outreachApi}/api/v1/outreach/`)
console.log(`[hid-system] internal Notification API: http://127.0.0.1:${ports.notificationApi}/api/v1/`)
console.log(`[hid-system] internal Notification Worker status: http://127.0.0.1:${ports.notificationWorkerStatus}/api/v1/health/ready`)
console.log(`[hid-system] internal Event Dispatcher status: http://127.0.0.1:${ports.eventDispatcherStatus}/api/v1/health/ready`)

if (requestedFrontends.has('admin')) start('admin', 'apps/admin', 'dev', { HID_ADMIN_PORT: String(ports.adminUi) })

if (requestedFrontends.has('web')) start('web', 'apps/web', 'dev', {
  HID_GATEWAY_PORT: String(ports.gateway),
  HID_EHR_PORT: String(ports.ehrUi),
  HID_EHR_API_PORT: String(ports.ehrApi),
  HID_OUTREACH_API_PORT: String(ports.outreachApi),
  HID_OCR_API_PORT: String(ports.ocrApi),
})

if (requestedFrontends.has('ehr')) start('ehr', 'apps/ehr', 'dev', {
  VITE_HID_DEMO_MODE: process.env.VITE_HID_DEMO_MODE ?? 'true',
  HID_EHR_PORT: String(ports.ehrUi),
})

if (requestedFrontends.has('lab')) start('lab', 'apps/lab', 'dev', {
  HID_LAB_PORT: String(ports.labUi),
})

if (requestedFrontends.has('pharmacy')) start('pharmacy', 'apps/pharmacy', 'dev', {
  HID_PHARMACY_PORT: String(ports.pharmacyUi),
})

if (requestedFrontends.has('ocr')) start('ocr', 'apps/ocr', 'dev', {
  HID_OCR_PORT: String(ports.ocrUi),
})

if (requestedFrontends.has('outreach')) start('outreach', 'apps/outreach', 'dev', {
  HID_OUTREACH_PORT: String(ports.outreachUi),
})

const apiConfigured = Boolean(sharedLocalDatabaseUrl) && process.env.HID_BACKENDS_DISABLED !== 'true'
if (apiConfigured) {
  start('identity-api', 'services/identity-api', 'start:local', {
    PORT: String(ports.identityApi),
    DATABASE_URL: platformEnvironment.IDENTITY_DATABASE_URL ?? sharedLocalDatabaseUrl,
    CORS_ORIGINS: localCorsOrigins,
    AUTH_MODE: platformEnvironment.AUTH_MODE ?? 'local',
    AUTH_SIGNING_SECRET: identityAuthSigningSecret,
    AUTH_LOGIN_PEPPER: identityAuthLoginPepper,
    IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
    IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: identityEhrInternalServiceToken,
    IDENTITY_LAB_INTERNAL_SERVICE_TOKEN: identityLabInternalServiceToken,
    IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: identityPharmacyInternalServiceToken,
    IDENTITY_OCR_INTERNAL_SERVICE_TOKEN: identityOcrInternalServiceToken,
    OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: outreachIdentityInternalServiceToken,
    OTP_HMAC_KEY_B64: otpHmacKey,
    NOTIFICATION_API_URL: `http://127.0.0.1:${ports.notificationApi}`,
    NOTIFICATION_SERVICE_IDENTITY_MODE: 'local-secret',
    NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: notificationIdentityInternalServiceToken,
    ADMIN_IDENTITY_STATUS_URL: `http://127.0.0.1:${ports.identityApi}`,
    ADMIN_EHR_STATUS_URL: `http://127.0.0.1:${ports.ehrApi}`,
    ADMIN_LAB_STATUS_URL: `http://127.0.0.1:${ports.labApi}`,
    ADMIN_PHARMACY_STATUS_URL: `http://127.0.0.1:${ports.pharmacyApi}`,
    ADMIN_OCR_STATUS_URL: `http://127.0.0.1:${ports.ocrApi}`,
    ADMIN_OUTREACH_STATUS_URL: `http://127.0.0.1:${ports.outreachApi}`,
    ADMIN_EVENT_DISPATCHER_STATUS_URL: `http://127.0.0.1:${ports.eventDispatcherStatus}`,
  }, platformEnvironment)
  start('ehr-api', 'services/ehr-api', 'start:local', {
    PORT: String(ports.ehrApi),
    CORS_ORIGINS: ehrApiEnvironment.CORS_ORIGINS ?? localCorsOrigins,
    LAB_API_URL: `http://127.0.0.1:${ports.labApi}`,
    LAB_INTERNAL_SERVICE_TOKEN: labInternalServiceToken,
    LAB_SERVICE_IDENTITY_MODE: 'local-secret',
    PHARMACY_API_URL: `http://127.0.0.1:${ports.pharmacyApi}`,
    PHARMACY_INTERNAL_SERVICE_TOKEN: pharmacyInternalServiceToken,
    PHARMACY_SERVICE_IDENTITY_MODE: 'local-secret',
    IDENTITY_API_URL: `http://127.0.0.1:${ports.identityApi}`,
    IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
    IDENTITY_EHR_INTERNAL_SERVICE_TOKEN: identityEhrInternalServiceToken,
    EHR_INTERNAL_SERVICE_TOKEN: ehrInternalServiceToken,
    EHR_SERVICE_IDENTITY_MODE: 'local-secret',
  }, ehrApiEnvironment)
  start('lab-api', 'services/lab-api', 'start:local', {
    PORT: String(ports.labApi),
    CORS_ORIGINS: localCorsOrigins,
    DATABASE_URL: platformEnvironment.LAB_DATABASE_URL ?? sharedLocalDatabaseUrl,
    IDENTITY_API_URL: `http://127.0.0.1:${ports.identityApi}`,
    IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
    IDENTITY_LAB_INTERNAL_SERVICE_TOKEN: identityLabInternalServiceToken,
    LAB_INTERNAL_SERVICE_TOKEN: labInternalServiceToken,
    LAB_SERVICE_IDENTITY_MODE: 'local-secret',
  }, platformEnvironment)
  start('pharmacy-api', 'services/pharmacy-api', 'start:local', {
    PORT: String(ports.pharmacyApi),
    CORS_ORIGINS: localCorsOrigins,
    DATABASE_URL: platformEnvironment.PHARMACY_DATABASE_URL ?? sharedLocalDatabaseUrl,
    IDENTITY_API_URL: `http://127.0.0.1:${ports.identityApi}`,
    IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
    IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: identityPharmacyInternalServiceToken,
    PHARMACY_INTERNAL_SERVICE_TOKEN: pharmacyInternalServiceToken,
    PHARMACY_SERVICE_IDENTITY_MODE: 'local-secret',
  }, platformEnvironment)
  start('ocr-api', 'services/ocr-api', 'start:local', {
    PORT: String(ports.ocrApi),
    CORS_ORIGINS: localCorsOrigins,
    DATABASE_URL: platformEnvironment.OCR_DATABASE_URL ?? sharedLocalDatabaseUrl,
    IDENTITY_API_URL: `http://127.0.0.1:${ports.identityApi}`,
    IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
    IDENTITY_OCR_INTERNAL_SERVICE_TOKEN: identityOcrInternalServiceToken,
    EHR_API_URL: `http://127.0.0.1:${ports.ehrApi}`,
    EHR_SERVICE_IDENTITY_MODE: 'local-secret',
    EHR_INTERNAL_SERVICE_TOKEN: ehrInternalServiceToken,
    LAB_API_URL: `http://127.0.0.1:${ports.labApi}`,
    LAB_SERVICE_IDENTITY_MODE: 'local-secret',
    LAB_INTERNAL_SERVICE_TOKEN: labInternalServiceToken,
    PHARMACY_API_URL: `http://127.0.0.1:${ports.pharmacyApi}`,
    PHARMACY_SERVICE_IDENTITY_MODE: 'local-secret',
    PHARMACY_INTERNAL_SERVICE_TOKEN: pharmacyInternalServiceToken,
  }, platformEnvironment)
  if (ocrWorkerEnvironment.OCR_WORKER_DATABASE_URL
      && ocrWorkerEnvironment.OCR_PROVIDER
      && ocrWorkerEnvironment.OCR_PROVIDER !== 'disabled') {
    start('ocr-worker', 'services/ocr-worker', 'start:local', {}, ocrWorkerEnvironment)
  } else {
    console.warn(
      '[hid-system] OCR worker remains independently disabled until OCR_WORKER_DATABASE_URL and a non-disabled OCR_PROVIDER are configured.',
    )
  }
  start('outreach-api', 'services/outreach-api', 'start:local', {
    PORT: String(ports.outreachApi),
    CORS_ORIGINS: localCorsOrigins,
    DATABASE_URL: platformEnvironment.OUTREACH_DATABASE_URL ?? sharedLocalDatabaseUrl,
    IDENTITY_API_URL: `http://127.0.0.1:${ports.identityApi}`,
    OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: outreachIdentityInternalServiceToken,
    OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  }, platformEnvironment)
  start('notification-api', 'services/notification-api', 'start:local', {
    PORT: String(ports.notificationApi),
    NOTIFICATION_WORKLOAD_IDENTITY_MODE: 'local-secret',
    NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: notificationIdentityInternalServiceToken,
  }, notificationApiEnvironment)
  if (notificationWorkerEnvironment.NOTIFICATION_WORKER_ENABLED === 'true') {
    start('notification-worker', 'services/notification-worker', 'start:local', {
      NOTIFICATION_WORKER_STATUS_PORT: String(ports.notificationWorkerStatus),
      NOTIFICATION_WORKER_DATABASE_URL: notificationWorkerEnvironment.NOTIFICATION_WORKER_DATABASE_URL
        ?? sharedLocalDatabaseUrl,
    }, notificationWorkerEnvironment)
  } else {
    console.warn(
      '[hid-system] Notification worker remains independently disabled until NOTIFICATION_WORKER_ENABLED=true and its SQS/Novu configuration are provided.',
    )
  }
  if (eventDispatcherEnvironment.EVENT_DISPATCHER_ENABLED === 'true') {
    start('event-dispatcher', 'services/event-dispatcher', 'start:local', {
      EVENT_DISPATCHER_STATUS_PORT: String(ports.eventDispatcherStatus),
      EVENT_DISPATCHER_DATABASE_URL: eventDispatcherEnvironment.EVENT_DISPATCHER_DATABASE_URL
        ?? sharedLocalDatabaseUrl,
    }, eventDispatcherEnvironment)
  } else {
    console.warn(
      '[hid-system] Event dispatcher remains independently disabled until EVENT_DISPATCHER_ENABLED=true and an explicit transport are configured.',
    )
  }
} else {
  console.warn(
    '[hid-system] API unavailable until DATABASE_URL and the remaining API environment variables are configured.',
  )
}
