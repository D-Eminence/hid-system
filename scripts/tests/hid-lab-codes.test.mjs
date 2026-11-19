import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

// The published HID-LAB local codes (docs/codes/hid-lab-codes.json) and their
// table in docs/INTERFACE_CONTRACT.md ("Wave 0: answers for the EHR screens").
// The limits are those a lab request takes today: testCodeSystem 1-255,
// testCode 1-100, testDisplay 1-500 and specimenTypeCode up to 100 characters
// (services/ehr-api/src/ehr/shared/clinical.dto.ts, CreateLabRequestDto).
const repository = resolve(import.meta.dirname, '..', '..')
const published = JSON.parse(readFileSync(resolve(repository, 'docs/codes/hid-lab-codes.json'), 'utf8'))
const contract = readFileSync(resolve(repository, 'docs/INTERFACE_CONTRACT.md'), 'utf8')
const CODE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/
const LOINC_SHAPE = /^\d+-\d$/

// The tests the EHR screen offers with a name only (no LOINC code), as Akos's
// built-in list names them.
const UNCODED_TESTS = [
  'Malaria parasite (blood film)', 'Malaria rapid diagnostic test', 'Widal test', 'Urinalysis',
  'Haemoglobin genotype', 'HIV screening', 'Hepatitis B surface antigen', 'Hepatitis C antibody',
  'Electrolytes, urea and creatinine', 'Liver function test', 'Lipid profile', 'Stool microscopy', 'Sputum for AFB',
]

test('the code system is HID-LAB, within the lab request limit', () => {
  assert.equal(published.codeSystem, 'HID-LAB')
  assert.ok(published.codeSystem.length >= 1 && published.codeSystem.length <= 255)
  assert.match(published.version, /^\d{4}-\d{2}-\d{2}$/)
})

test('every code is well formed and fits a lab request', () => {
  assert.ok(Array.isArray(published.codes) && published.codes.length > 0)
  for (const entry of published.codes) {
    assert.deepEqual(Object.keys(entry).sort(), ['code', 'display', 'specimen'], entry.code)
    assert.match(entry.code, CODE, `${entry.code}: uppercase A-Z, 0-9 and single hyphens only`)
    assert.ok(entry.code.length <= 100, `${entry.code}: longer than testCode allows`)
    assert.doesNotMatch(entry.code, LOINC_SHAPE, `${entry.code}: looks like a LOINC code`)
    for (const field of ['display', 'specimen']) {
      assert.equal(typeof entry[field], 'string', `${entry.code}: ${field}`)
      assert.equal(entry[field], entry[field].trim(), `${entry.code}: ${field} has outer spaces`)
      assert.ok(entry[field].length >= 1, `${entry.code}: empty ${field}`)
    }
    assert.ok(entry.display.length <= 500, `${entry.code}: display longer than testDisplay allows`)
    assert.ok(entry.specimen.length <= 100, `${entry.code}: specimen longer than specimenTypeCode allows`)
  }
})

test('codes and names are unique', () => {
  const codes = published.codes.map((entry) => entry.code)
  const names = published.codes.map((entry) => entry.display.toLowerCase())
  assert.equal(new Set(codes).size, codes.length, 'a code is used twice')
  assert.equal(new Set(names).size, names.length, 'a name is used twice')
})

test('there is one code for each test the screen offers without a LOINC code', () => {
  assert.deepEqual(published.codes.map((entry) => entry.display).sort(), [...UNCODED_TESTS].sort())
})

test('the contract table lists exactly the published codes', () => {
  const start = contract.indexOf('## Wave 0: answers for the EHR screens (R-1 to R-4, P2-5, P2-6)')
  assert.ok(start >= 0, 'the Wave 0 section is missing')
  const next = contract.indexOf('\n## ', start + 1)
  const section = contract.slice(start, next < 0 ? undefined : next)
  const rows = [...section.matchAll(/^\| `([A-Z0-9-]+)` \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map(([, code, display, specimen]) => ({ code, display: display.trim(), specimen: specimen.trim() }))
  assert.deepEqual(rows, published.codes)
})
