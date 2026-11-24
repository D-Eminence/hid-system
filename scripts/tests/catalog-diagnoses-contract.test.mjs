import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

// ORD-9 (0150): the planned contract says what ehr-api sends for the diagnosis search's 503 (Rahman's re-review of
// #320, nit 9a). ProblemDetailsFilter replaces every 5xx detail with one text; the catalogue spec's HTTP test pins it
// on the wire, and this test holds the contract's ORD-9 error row and its first slice to the same words. (A service
// test may not read docs/: a change there would not select the service's tests.)
const repository = resolve(import.meta.dirname, '..', '..')
const problem = readFileSync(resolve(repository, 'services/ehr-api/src/common/problem.ts'), 'utf8')
const contract = readFileSync(resolve(repository, 'docs/EHR_PLANNED_CONTRACT.md'), 'utf8')

test('the filter replaces every 5xx detail with one text', () => {
  assert.match(problem, /const detail = status >= 500\s*\?\s*'The service could not complete the request\.'/)
})

test('ORD-9\'s 503 row and its first slice say the filter\'s words are what is sent', () => {
  const sent = problem.match(/const detail = status >= 500\s*\?\s*'([^']+)'/)[1]
  const start = contract.indexOf('\n## ORD-9: ')
  const section = contract.slice(start, contract.indexOf('\n## ', start + 1))
  const rows = section.split('\n').filter((line) => line.startsWith('| 503 | `CATALOG_UNAVAILABLE` |'))
  assert.equal(rows.length, 1)
  assert.ok(rows[0].includes(`sent as "${sent}"`), rows[0])
  assert.doesNotMatch(rows[0], /\| "Diagnosis search is not available right now\."/)
  const firstSlice = section.slice(section.indexOf('### First slice')).replace(/\s+/g, ' ')
  assert.ok(firstSlice.includes(`503 \`CATALOG_UNAVAILABLE\`, sent as "${sent}"`))
})
