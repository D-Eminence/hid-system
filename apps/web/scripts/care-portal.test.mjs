import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createCarePortalApi } from '../src/lib/carePortalContract.ts'
const facilityId = '10000000-0000-4000-8000-000000000001'
const patientId = '20000000-0000-4000-8000-000000000001'
const consentGrantId = '30000000-0000-4000-8000-000000000001'
const grant = () => ({ consentGrantId, patientId, accessRequestId: '40000000-0000-4000-8000-000000000001', status: 'active', expiresAt: new Date(Date.now()+60_000).toISOString(), existingGrant: false })
const records = { encounters: [], notes: [], limit: 50 }

test('patient reads accept no caller patient or facility identity', async () => {
  const requests = []
  const api = createCarePortalApi(async (path, init) => { requests.push({ path, init }); return records })
  await api.self(); await api.ownRecords()
  assert.deepEqual(requests, [{ path: '/api/v1/identity/me', init: undefined }, { path: '/api/v1/ehr/me/records', init: undefined }])
})
test('emergency activation, records and revoke bind canonical identifiers, facility and emergency purpose', async () => {
  const requests = []
  const api = createCarePortalApi(async (path, init) => { requests.push({ path, init }); return path.endsWith('break-glass') ? grant() : records })
  const active = await api.activate(facilityId, 'hid-abcdefgh', 'Urgent clinical treatment', 30)
  await api.emergencyRecords(facilityId, active)
  await api.close(facilityId, consentGrantId, 'Emergency treatment completed')
  assert.deepEqual(requests.map(request => request.path), ['/api/v1/identity/break-glass', `/api/v1/ehr/patients/${patientId}/emergency-records`, `/api/v1/identity/consent-grants/${consentGrantId}/close`])
  for (const request of requests) assert.deepEqual(request.init.headers, { 'X-Facility-Id': facilityId, 'X-Purpose-Of-Use': 'emergency' })
  assert.deepEqual(JSON.parse(requests[0].init.body), { hid: 'HID-ABCDEFGH', reason: 'Urgent clinical treatment', durationMinutes: 30 })
  assert.equal(requests[1].init.method, undefined)
})
test('expired access never fetches clinical records', async () => {
  let requests = 0
  const api = createCarePortalApi(async () => { requests++; return records })
  await assert.rejects(api.emergencyRecords(facilityId, { ...grant(), expiresAt: new Date(0).toISOString() }), /expired/)
  assert.equal(requests, 0)
})
test('an in-flight response cannot restore records after expiry', async () => {
  const active = grant()
  const api = createCarePortalApi(async () => { active.expiresAt = new Date(0).toISOString(); return records })
  await assert.rejects(api.emergencyRecords(facilityId, active), /expired/)
})
test('denial, revoked grant, rate limit and audit outage propagate without fabricated success', async () => {
  for (const status of [403, 409, 429, 503]) {
    const denied = Object.assign(new Error('Authoritative denial'), { status })
    const api = createCarePortalApi(async () => { throw denied })
    await assert.rejects(api.activate(facilityId, 'HID-ABCDEFGH', 'Urgent clinical treatment', 30), error => error === denied)
    await assert.rejects(api.emergencyRecords(facilityId, grant()), error => error === denied)
  }
})
test('missing reason, unknown identifiers and out-of-policy duration stop before transport', async () => {
  let requests = 0
  const api = createCarePortalApi(async () => { requests++; return grant() })
  for (const [hid, reason, duration] of [['HID-ABCDEFGH', '', 30], ['legacy-id', 'Urgent treatment', 30], ['HID-ABCDEFGH', 'Urgent treatment', 241]]) await assert.rejects(api.activate(facilityId, hid, reason, duration))
  await assert.rejects(api.activate('unknown', 'HID-ABCDEFGH', 'Urgent treatment', 30))
  assert.equal(requests, 0)
})
test('active patient and emergency components cannot import legacy helpers or clinical writes', async () => {
  for (const file of ['components/AccountAccess.tsx', 'components/CarePortal.tsx', 'pages/patient/PatientSelfPortal.tsx', 'pages/doctor/DoctorEmergency.tsx']) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /hidApi|functions\.invoke|edgeRequest|token-exchange|createMedicalRecord|WithUploads|experienceWarmup/)
  }
})
