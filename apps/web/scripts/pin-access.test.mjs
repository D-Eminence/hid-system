import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

// Owner decision (10 Nov 2026; database 0121): a patient's Access PIN opens
// their records to see and add to for 24 hours (1440 minutes).
const source = path => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')

test('the PIN asks for 24 hours by default', async () => {
  const api = await source('lib/hidApi.ts')
  assert.match(api, /export const PATIENT_PIN_ACCESS_MINUTES = 1440\b/)
  assert.match(api, /accessPatientWithPin\([^)]*durationMinutes = PATIENT_PIN_ACCESS_MINUTES\b/)
})

test('the doctor portal asks for the full 24 hours, not 60 minutes', async () => {
  const portal = await source('pages/doctor/DoctorPortal.tsx')
  const calls = portal.match(/await accessPatientWithPin\(.*$/gm) ?? []
  assert.equal(calls.length, 1)
  assert.match(calls[0], /, PATIENT_PIN_ACCESS_MINUTES, staffName\)$/)
})

test('the patient is told the PIN lets a clinician see and add to records for 24 hours', async () => {
  const page = await source('pages/patient/PatientSelfPortal.tsx')
  assert.ok(page.includes('can see and add to your records for 24 hours. You can end this at any time.'))
  assert.ok(!/read-only|short-lived/i.test(page))
})
