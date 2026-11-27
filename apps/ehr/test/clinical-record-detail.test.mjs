import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

// The pure helper the clinical timeline uses for a diagnosis's or a lab request's detail line. From migration 0156
// ehr-api may answer either one saved by its name only, with both codes null.
const source = await readFile(new URL('../src/api/clinicalRecordDetail.ts', import.meta.url), 'utf8')
const helper = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source,
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`)
const { diagnosisDetail, labRequestDetail, NO_CODE } = helper

const client = await readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8')

test('a coded diagnosis shows its code system and code', () => {
  assert.equal(diagnosisDetail('ICD-10', 'B50.9'), 'ICD-10 • B50.9')
})

test('a diagnosis saved by its name only shows "No code"', () => {
  assert.equal(NO_CODE, 'No code')
  assert.equal(diagnosisDetail(undefined, undefined), 'No code')
  assert.equal(diagnosisDetail('ICD-10', undefined), 'No code')
  assert.equal(diagnosisDetail(undefined, 'B50.9'), 'No code')
})

test('a coded lab request shows its test code and priority; one by name only shows the priority alone', () => {
  assert.equal(labRequestDetail('MP-SMEAR', 'routine'), 'MP-SMEAR • ROUTINE')
  assert.equal(labRequestDetail(undefined, 'urgent'), 'URGENT')
})

test('the client reads the code pairs as optional and uses the helper, so a null pair does not fail the page', () => {
  assert.match(client, /detail: diagnosisDetail\(optionalString\(value, 'codeSystem'\), optionalString\(value, 'code'\)\)/)
  assert.match(client, /detail: labRequestDetail\(optionalString\(value, 'testCode'\), requiredString\(value, 'priority'\)\)/)
  assert.doesNotMatch(client, /requiredString\(value, '(codeSystem|code|testCode|testCodeSystem)'\)/)
})
