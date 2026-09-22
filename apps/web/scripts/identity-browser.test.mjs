import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
let server, client
const calls = [], responses = []
const originalFetch = globalThis.fetch
before(async () => {
  server = await createServer({ configFile: false, resolve: { alias: { '@hid/api-client': fileURLToPath(new URL('../../../packages/api-client/src/index.ts', import.meta.url)) } }, server: { middlewareMode: true }, appType: 'custom' })
  client = await server.ssrLoadModule('/src/lib/identityClient.ts')
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
test('canonical mutations use session CSRF token without bearer token exposure', async () => {
  responses.push(response({ status: 'active' }))
  await client.canonicalRequest('/api/v1/identity/break-glass', { method: 'POST', body: JSON.stringify({ hid: 'HID-ABCDEFGH' }) })
  const request = calls.at(-1)
  assert.equal(request.init.headers.get('X-CSRF-Token'), 'synthetic-csrf')
  assert.equal(request.init.headers.has('Authorization'), false)
  assert.equal(request.init.credentials, 'include'); assert.equal(request.init.cache, 'no-store')
  await assert.rejects(client.canonicalRequest('/api/v1/functions/break-glass'), /canonical API path/)
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
