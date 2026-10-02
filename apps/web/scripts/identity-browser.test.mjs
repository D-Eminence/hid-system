import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
let server, client, organizationApplication, patientEnrollment, routePreload, otpInputs
const calls = [], responses = []
const originalFetch = globalThis.fetch
before(async () => {
  server = await createServer({ configFile: false, resolve: { alias: { '@hid/api-client': fileURLToPath(new URL('../../../packages/api-client/src/index.ts', import.meta.url)) } }, server: { middlewareMode: true }, appType: 'custom' })
  client = await server.ssrLoadModule('/src/lib/identityClient.ts')
  organizationApplication = await server.ssrLoadModule('/src/lib/organizationApplicationApi.ts')
  patientEnrollment = await server.ssrLoadModule('/src/lib/patientEnrollmentApi.ts')
  routePreload = await server.ssrLoadModule('/src/lib/routePreload.tsx')
  otpInputs = await server.ssrLoadModule('/src/components/OtpInputs.tsx')
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const response = responses.shift()
    assert.ok(response, 'Unexpected network request')
    return response
  }
})
after(async () => { globalThis.fetch = originalFetch; await server?.close() })
const actor = { subject: 'patient:test', accountId: '10000000-0000-4000-8000-000000000001', kind: 'patient', patientId: '20000000-0000-4000-8000-000000000001', email: 'synthetic@test.invalid', roles: [], permissions: [], facilities: [] }
function response(body, status = 200, headers = {}) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }) }

test('patient login uses canonical patient realm and host cookie session', async () => {
  responses.push(response({ actor, expiresAt: new Date(Date.now()+60_000).toISOString() }, 200, { 'x-csrf-token': 'synthetic-csrf' }))
  const result = await client.identityClient.auth.signInPatientWithPassword({ email: actor.email, password: 'synthetic-password-only', turnstileToken: 'synthetic-turnstile' })
  assert.equal(result.error, null); assert.equal(result.data.session.user.user_metadata.requested_role, 'patient')
  assert.equal(result.data.session.user.user_metadata.patient_id, actor.patientId)
  assert.equal(result.data.session.access_token, 'http-only-cookie')
  const request = calls.at(-1)
  assert.equal(request.url, '/api/v1/auth/patient/login')
  assert.deepEqual(JSON.parse(request.init.body), { email: actor.email, password: 'synthetic-password-only', turnstileToken: 'synthetic-turnstile', turnstileAction: 'patient-login' })
  assert.equal(request.init.credentials, 'include'); assert.equal(request.init.cache, 'no-store')
})
test('patient enrollment sends only NIN and Turnstile for the identity step through the cookie-bound public route', async () => {
  const key = '50000000-0000-4000-8000-000000000001'
  responses.push(response({ stage: 'verify_contact', expiresAt: new Date(Date.now() + 60_000).toISOString() }, 202))
  const progress = await patientEnrollment.patientEnrollmentApi.start(' 12345678901 ', 'synthetic-turnstile', key)
  assert.equal(progress.stage, 'verify_contact')
  const request = calls.at(-1)
  assert.equal(request.url, '/api/v1/identity/patient-enrollments')
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.headers.get('Idempotency-Key'), key)
  assert.deepEqual(JSON.parse(request.init.body), {
    nin: '12345678901', turnstileAction: 'patient-enrollment', turnstileToken: 'synthetic-turnstile',
  })
  assert.equal(request.init.credentials, 'include')
  assert.equal(request.init.cache, 'no-store')
  assert.deepEqual(routePreload.getRoutePreloadKeys('/patient/enroll'), [])
})
test('patient enrollment requires one contact, verifies its code, and activates without a client-issued identity', async () => {
  const requests = []
  const api = patientEnrollment.createPatientEnrollmentApi(async (path, init = {}) => {
    requests.push({ path, init })
    if (path.endsWith('/contact')) return { challengeId: '40000000-0000-4000-8000-000000000001', expiresInSeconds: 300, resendAfterSeconds: 60 }
    if (path.endsWith('/activate')) return { stage: 'active', hidCode: 'HID-ABCDEFGHJKLMNPQ' }
    if (path.endsWith('/google')) return { bound: true }
    return { stage: 'set_password' }
  })
  const challenge = await api.contact('phone', '08012345678')
  assert.equal(challenge.challengeId, '40000000-0000-4000-8000-000000000001')
  assert.deepEqual(JSON.parse(requests.at(-1).init.body), { channel: 'phone', contact: '+2348012345678' })
  await api.verifyContact(challenge.challengeId, '123456')
  assert.deepEqual(JSON.parse(requests.at(-1).init.body), { challengeId: challenge.challengeId, code: '123456' })
  const activated = await api.activate('synthetic-passphrase')
  assert.deepEqual(activated, { stage: 'active', hidCode: 'HID-ABCDEFGHJKLMNPQ' })
  assert.deepEqual(JSON.parse(requests.at(-1).init.body), { password: 'synthetic-passphrase' })
  assert.deepEqual(await api.bindGoogle(), { bound: true })
  assert.equal(requests.at(-1).path, '/api/v1/identity/patient-enrollments/google')
  assert.equal(requests.at(-1).init.method, 'POST')
  const count = requests.length
  assert.throws(() => api.start('123', 'token', '50000000-0000-4000-8000-000000000001'), /11-digit NIN/)
  assert.throws(() => api.contact('email', 'invalid'), /valid email/)
  assert.throws(() => api.verifyContact(challenge.challengeId, '12345'), /six-digit/)
  assert.throws(() => api.activate('short'), /12–256/)
  assert.equal(requests.length, count)
})
test('segmented OTP paste replaces stale digits and leaves partial paste incomplete', () => {
  let manual = ''
  for (const [index, digit] of [...'123456'].entries()) manual = otpInputs.nextOtpValue(manual, index, digit)
  assert.equal(manual, '123456')
  assert.equal(otpInputs.nextOtpValue('', 0, '123456', true), '123456')
  assert.equal(otpInputs.nextOtpValue('987654', 0, '123', true), '123')
  assert.equal(otpInputs.nextOtpValue('123456', 2, '45', true), '1245')
  assert.equal(otpInputs.nextOtpValue('123456', 3, '654321', true), '654321')
  assert.equal(otpInputs.nextOtpValue('12345', 5, '6'), '123456')
  assert.equal(otpInputs.shouldCompleteOtp('123456', '123456', true), true)
  assert.equal(otpInputs.shouldCompleteOtp('123456', '456', true), false)
  assert.equal(otpInputs.shouldCompleteOtp('123456', '6'), true)
})
test('Google credentials use the server nonce cookie contract and never forward client-decoded identity data', async () => {
  const nonce = 'n'.repeat(43)
  responses.push(response({ nonce }))
  assert.equal(await client.getGoogleSignInNonce(), nonce)
  const nonceRequest = calls.at(-1)
  assert.equal(nonceRequest.url, '/api/v1/auth/google/nonce')
  assert.equal(nonceRequest.init.method, undefined)

  responses.push(response({ actor, expiresAt: new Date(Date.now() + 60_000).toISOString() }))
  const result = await client.identityClient.auth.signInWithIdToken({
    provider: 'google', token: 'synthetic-google-id-token', nonce,
    actorKind: 'patient', turnstileToken: 'synthetic-turnstile',
  })
  assert.equal(result.error, null)
  const exchange = calls.at(-1)
  assert.equal(exchange.url, '/api/v1/auth/oidc/exchange')
  assert.deepEqual(JSON.parse(exchange.init.body), {
    idToken: 'synthetic-google-id-token',
    turnstileAction: 'patient-login',
    turnstileToken: 'synthetic-turnstile',
  })
})
test('Google exchange infers the patient Turnstile boundary from a patient portal path', async () => {
  responses.push(response({ actor, expiresAt: new Date(Date.now() + 60_000).toISOString() }))
  const result = await client.identityClient.auth.signInWithIdToken({
    provider: 'google', token: 'synthetic-google-id-token', path: '/patient', turnstileToken: 'synthetic-turnstile',
  })
  assert.equal(result.error, null)
  assert.equal(JSON.parse(calls.at(-1).init.body).turnstileAction, 'patient-login')
})
test('unknown Google enrollment stays accountless until NIN and OTP activation', async () => {
  let signedIn = 0
  const subscription = client.identityClient.auth.onAuthStateChange(event => { if (event === 'SIGNED_IN') signedIn++ })
  responses.push(response({ stage: 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY', expiresAt: '2026-10-01T13:00:00Z' }, 202))
  const pending = await client.identityClient.auth.beginGooglePatientEnrollment({ token: 'synthetic-google-id-token', turnstileToken: 'synthetic-turnstile' })
  assert.equal(pending.stage, 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY')
  assert.equal(signedIn, 0)
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
    idToken: 'synthetic-google-id-token', turnstileAction: 'patient-login',
    turnstileToken: 'synthetic-turnstile', intent: 'enroll',
  })
  subscription.data.subscription.unsubscribe()
})
test('Google linking sends fresh proof and HID password in a protected patient command', async () => {
  responses.push(response({ actor }, 200, { 'x-csrf-token': 'synthetic-csrf' }))
  await client.identityClient.auth.getSession()
  responses.push(response({ linked: true }))
  const result = await client.identityClient.auth.linkGoogleIdentity({
    token: 'synthetic-google-id-token', principal: 'HID-ABCDEFGH',
    password: 'synthetic-current-password', turnstileToken: 'synthetic-turnstile',
  })
  assert.deepEqual(result, { linked: true })
  const request = calls.at(-1)
  assert.equal(request.url, '/api/v1/auth/google/link')
  assert.equal(request.init.credentials, 'include')
  assert.equal(request.init.headers.get('X-CSRF-Token'), 'synthetic-csrf')
  assert.deepEqual(JSON.parse(request.init.body), {
    idToken: 'synthetic-google-id-token', principal: 'HID-ABCDEFGH',
    password: 'synthetic-current-password', turnstileAction: 'patient-login',
    turnstileToken: 'synthetic-turnstile',
  })
})
test('canonical mutations use session CSRF token without bearer token exposure', async () => {
  responses.push(response({ status: 'active' }))
  await client.canonicalRequest('/api/v1/identity/break-glass', { method: 'POST', body: JSON.stringify({ hid: 'HID-ABCDEFGH' }) })
  const request = calls.at(-1)
  assert.equal(request.init.headers.get('X-CSRF-Token'), 'synthetic-csrf')
  assert.equal(request.init.headers.has('Authorization'), false)
  assert.equal(request.init.credentials, 'include'); assert.equal(request.init.cache, 'no-store')
  await assert.rejects(client.canonicalRequest('/api/v1/functions/break-glass'), /canonical API path/)
})
test('provider application sends only the required data to the public route and uses the exact Turnstile action', async () => {
  responses.push(response({ accepted: true }, 202))
  const result = await organizationApplication.submitOrganizationApplication({
    organizationName: '  Example General Hospital  ',
    organizationType: 'hospital',
    productCode: 'laboratory',
    cacRegistrationNumber: ' rc 123456 ',
    administratorName: '  Test Administrator  ',
    administratorEmail: '  admin@example.invalid  ',
    turnstileToken: 'synthetic-turnstile',
  })
  assert.equal(result, undefined)
  const request = calls.at(-1)
  assert.equal(request.url, '/api/v1/identity/organization-applications')
  assert.equal(request.init.method, 'POST')
  assert.deepEqual(JSON.parse(request.init.body), {
    productCode: 'laboratory',
    organizationType: 'hospital',
    cacRegistrationNumber: 'RC123456',
    administratorName: 'Test Administrator',
    administratorEmail: 'admin@example.invalid',
    turnstileAction: 'organization-application',
    turnstileToken: 'synthetic-turnstile',
  })
  assert.equal(request.init.credentials, 'include')
  assert.equal(request.init.cache, 'no-store')
})
test('provider application rejects invalid CAC and incompatible organization product before making a request', async () => {
  const input = {
    organizationName: 'Example Laboratory', organizationType: 'laboratory',
    productCode: 'laboratory', cacRegistrationNumber: 'RC123456',
    administratorName: 'Test Administrator', administratorEmail: 'admin@example.invalid',
    turnstileToken: 'synthetic-turnstile',
  }
  const before = calls.length
  await assert.rejects(organizationApplication.submitOrganizationApplication({ ...input, cacRegistrationNumber: '123456' }), /CAC registration number/)
  await assert.rejects(organizationApplication.submitOrganizationApplication({ ...input, productCode: 'pharmacy' }), /Choose a product/)
  assert.equal(calls.length, before)
})
test('recovery start, verify and completion preserve purpose and never create a session', async () => {
  let signedIn = 0
  const subscription = client.identityClient.auth.onAuthStateChange(event => { if (event === 'SIGNED_IN') signedIn++ })
  const challengeId = '30000000-0000-4000-8000-000000000001'
  responses.push(response({ accepted: true, challengeId, deliveryChannels: ['email'], expiresInSeconds: 300, resendAfterSeconds: 60 }, 202))
  const start = await client.identityClient.auth.startRecoveryOtp({ identifier: actor.email, purpose: 'PASSWORD_RESET', turnstileAction: 'patient-reset-start', turnstileToken: 'synthetic-turnstile' })
  assert.equal(start.data.accepted, true)
  responses.push(response({ verified: true, challengeId, verificationToken: 'synthetic-verification' }))
  const verified = await client.identityClient.auth.verifyRecoveryOtp({ challengeId, purpose: 'PASSWORD_RESET', code: '123456' })
  responses.push(response({ completed: true }))
  const completed = await client.identityClient.auth.completeRecoveryOtp({ challengeId, purpose: 'PASSWORD_RESET', verificationToken: verified.data.verificationToken, newPassword: 'synthetic-new-password' })
  assert.deepEqual(completed.data, { completed: true }); assert.equal(signedIn, 0)
  assert.deepEqual(calls.slice(-3).map(call => call.url), ['/api/v1/auth/otp/start', '/api/v1/auth/otp/verify', '/api/v1/auth/otp/complete'])
  for (const request of calls.slice(-3)) assert.equal(JSON.parse(request.init.body).purpose, 'PASSWORD_RESET')
  subscription.data.subscription.unsubscribe()
})
test('expired or replayed recovery returns authoritative error', async () => {
  responses.push(response({ code: 'OTP_INVALID', detail: 'Code expired or invalid' }, 400))
  const result = await client.identityClient.auth.verifyRecoveryOtp({ challengeId: 'synthetic', purpose: 'PASSWORD_RESET', code: '123456' })
  assert.equal(result.data, null); assert.equal(result.error.status, 400); assert.equal(result.error.code, 'OTP_INVALID')
})
test('unauthorized restored session emits sign-out so patient information clears', async () => {
  let signedOut = 0
  const subscription = client.identityClient.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') signedOut++ })
  responses.push(response({ code: 'UNAUTHENTICATED' }, 401))
  const result = await client.identityClient.auth.getSession()
  assert.equal(result.data.session, null); assert.equal(signedOut, 1)
  subscription.data.subscription.unsubscribe()
})
