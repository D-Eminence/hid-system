import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const identityRoot = join(root, '..', '..', 'services', 'identity-api')
const databaseRoot = join(root, '..', '..', 'services', 'ehr-api')
const generator = await readFile(join(identityRoot, 'src', 'identity', 'hid-code-generator.service.ts'), 'utf8')
const consentMigration = await readFile(
  join(databaseRoot, 'database', 'migrations', '0010_consent_commands_and_audit_reads.sql'),
  'utf8',
)
const ninMigration = await readFile(
  join(databaseRoot, 'database', 'migrations', '0011_governed_nin_registration.sql'),
  'utf8',
)
const ninRegistrationService = await readFile(
  join(identityRoot, 'src', 'identity', 'nin-registration.service.ts'),
  'utf8',
)
const accessRequestDto = await readFile(
  join(identityRoot, 'src', 'consent', 'dto', 'create-access-request.dto.ts'),
  'utf8',
)
const utilities = await readFile(join(root, 'src', 'lib', 'utils.ts'), 'utf8')
const portalAuth = await readFile(join(root, 'src', 'lib', 'auth.ts'), 'utf8')
const pageCache = await readFile(join(root, 'src', 'lib', 'pageCache.ts'), 'utf8')
const ehrApp = await readFile(join(root, '..', '..', 'apps', 'ehr', 'src', 'ehr-app.jsx'), 'utf8')
const failures = []

for (const required of [
  "const HID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'",
  'randomBytes(16)',
  'byte & 31',
  'maxAttempts = 8',
  'if (outcome.reserved) return outcome.result',
]) {
  if (!generator.includes(required)) failures.push(`server HID generator is missing: ${required}`)
}
if (/Math\.random\s*\(/.test(generator)) failures.push('server HID generator uses non-cryptographic Math.random()')
if (!accessRequestDto.includes('/^HID-[A-HJ-NP-Z2-9]{6,32}$/')) {
  failures.push('access request validation must accept governed historical and current HID lengths')
}
for (const required of [
  'identity.create_access_request',
  'identity.activate_break_glass',
  'identity.close_own_consent_grant',
  "requested_duration_minutes not between 5 and 240",
  "actor_purpose <> 'emergency'",
]) {
  if (!consentMigration.includes(required)) failures.push(`consent migration is missing: ${required}`)
}
if (!utilities.includes('crypto.getRandomValues(new Uint8Array(len))')) {
  failures.push('client-side HID helper must use Web Crypto')
}
if (!utilities.includes('return `HID-${randomSegment(16)}`')) {
  failures.push('client-side HID helper must emit a 16-symbol suffix')
}
if (/localStorage|sessionStorage/.test(portalAuth)) {
  failures.push('portal session profiles must remain memory-only and be rehydrated from the server')
}
if (/localStorage|sessionStorage|indexedDB|\bcaches\b/.test(pageCache)) {
  failures.push('PHI page caches must remain memory-only until protected offline storage is implemented')
}
if (!portalAuth.includes('useSyncExternalStore')) {
  failures.push('memory-only portal sessions must notify protected routes after server rehydration')
}
for (const required of [
  'registration_case_id uuid',
  'patient_identifiers_registration_case_fk',
  'registration_cases_active_nin_uq',
  'review_idempotency_key',
  'resolved_existing_identity',
]) {
  if (!ninMigration.includes(required)) failures.push(`governed NIN migration is missing: ${required}`)
}
if (!ninRegistrationService.includes('ninResolutionRequestDigest(input, ninLookupHmac)')) {
  failures.push('NIN resolution idempotency must bind to the keyed lookup HMAC')
}
if (ninRegistrationService.includes("requestDigest('identity.nin.resolve', input)")) {
  failures.push('raw NIN input must not be persisted through an unkeyed request digest')
}
if (/localStorage|sessionStorage/.test(ehrApp)) {
  failures.push('EHR facility setup must remain memory-only and server-session-derived')
}

if (failures.length) {
  console.error(`Identity contract verification failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}

console.log('Verified governed identity issuance, NIN registration, and memory-only browser security boundaries.')
