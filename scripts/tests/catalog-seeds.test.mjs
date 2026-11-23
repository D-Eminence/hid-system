import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  APPROVALS_FORMAT, LOINC_NOTICE, SEED_FORMAT, WHO_EML_NOTICE, approvalFor, buildSeeds, parseCsv, seedProblems, seedText,
  sha256,
} from '../../services/ehr-api/scripts/catalog-seed.mjs'

// ORD-7's seed files (services/ehr-api/scripts/catalog-seed.mjs): the
// combined list's rows to the two seeds the governed loader takes, and the
// checks the loader makes before anything is written. Synthetic rows only;
// the medicine and test names are list facts, not patient data.
const repository = resolve(import.meta.dirname, '..', '..')
const COLUMNS = 'id,list,name,other_names,strength,dose_form,dose_form_text,route,specimen,category,code_system,code,'
  + 'code_name,source,source_section,source_list,use_status,notes'
const row = (cells) => COLUMNS.split(',').map((name) => {
  const value = cells[name] ?? ''
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}).join(',')
const medicine = (id, name, extra = {}) => row({ id, list: 'medicine', name, dose_form: 'tablet', dose_form_text: 'Tablet',
  route: 'oral', strength: '500 mg', source: 'nigeria-eml-8', source_section: '6.2', source_list: 'main', ...extra })
const labTest = (id, name, extra = {}) => row({ id, list: 'lab-test', name, specimen: 'Blood (EDTA)', category: 'haematology',
  code_system: 'LOINC', code: '57021-8', source: 'hid-common-tests', ...extra })
const csv = (...rows) => [COLUMNS, ...rows].join('\n') + '\n'
const WAVE_ZERO = [
  { code: 'WIDAL', display: 'Widal test', specimen: 'Serum' },
  { code: 'MP-RDT', display: 'Malaria rapid diagnostic test', specimen: 'Blood' },
  { code: 'HIV-SCREEN', display: 'HIV screening', specimen: 'Blood' },
]
const FIXTURE = csv(
  medicine('MED-00001', 'amoxicillin', { other_names: 'Amoxil; Ospamox', strength: '500 mg', dose_form: 'capsule',
    dose_form_text: 'Capsule', code_system: 'ATC', code: 'J01CA04' }),
  medicine('MED-00002', 'paracetamol', { route: 'oral; rectal', code_system: 'ATC', code: 'N02BE01' }),
  medicine('MED-00004', 'oral rehydration salts', { strength: 'x'.repeat(81), dose_form: 'other',
    dose_form_text: 'Powder for oral liquid' }),
  medicine('MED-00005', 'prussian blue', { source: 'who-eml-24', source_list: 'specialist' }),
  labTest('LAB-0001', 'Full blood count', { other_names: 'FBC; CBC' }),
  labTest('LAB-0002', 'Widal test', { category: 'serology', code_system: 'HID-LAB', code: 'WIDAL', specimen: 'Serum' }),
  labTest('LAB-0003', 'Malaria rapid diagnostic test', { category: 'parasitology', code: '70569-9' }),
  labTest('LAB-0004', 'Thyroid function test', { category: 'endocrinology', code_system: '', code: '' }),
  labTest('LAB-0005', 'Group and crossmatch', { category: 'blood bank', code: '34532-2' }),
  labTest('LAB-0006', 'Thyroid stimulating hormone', { category: 'endocrinology', code: '3016-3', specimen: 'Serum' }),
)
const RETIRED = { 'MED-00003': 'Synthetic: the same medicine is listed under another name' }
const build = (text = FIXTURE, options = {}) =>
  buildSeeds(parseCsv(text), { version: '2026.1', retired: RETIRED, waveZero: WAVE_ZERO, ...options })

test('the CSV reader takes quotes, doubled quotes, commas and line breaks inside a field, and CRLF', () => {
  const rows = parseCsv('a,b\r\n"x, ""y""","line one\nline two"\r\nplain,\r\n')
  assert.deepEqual(rows, [{ a: 'x, "y"', b: 'line one\nline two' }, { a: 'plain', b: '' }])
  assert.throws(() => parseCsv('a,b\n1,2,3\n'), /3 fields where the header has 2/)
  assert.throws(() => parseCsv('a\n"open\n'), /not closed/)
})

test('medicines: the list\'s columns become the seed\'s, routes and other names split, ATC only from an ATC code', () => {
  const { medicine: seed } = build()
  assert.equal(seed.format, SEED_FORMAT)
  assert.equal(seed.kind, 'medicine')
  assert.deepEqual(seed.items[0], {
    listId: 'MED-00001', genericName: 'amoxicillin', otherNames: ['Amoxil', 'Ospamox'], strength: '500 mg',
    doseForm: 'capsule', doseFormText: 'Capsule', routes: ['oral'], atcCode: 'J01CA04', commonAdultDose: null,
    source: 'nigeria-eml-8', sourceSection: '6.2', sourceList: 'main', withdrawn: false,
  })
  assert.deepEqual(seed.items[1].routes, ['oral', 'rectal'])
  assert.equal(seed.items.find((item) => item.listId === 'MED-00005').atcCode, null)
  assert.deepEqual(seed.sources, ['nigeria-eml-8', 'who-eml-24'])
  assert.deepEqual(seed.attribution, [WHO_EML_NOTICE], 'a WHO row brings the WHO list\'s citation')
  assert.deepEqual(seed.retired, [{ listId: 'MED-00003', reason: RETIRED['MED-00003'] }])
})

test('a row the database would refuse is held back with why, never cut or guessed', () => {
  const { medicine: medicines, lab_test: labTests } = build()
  assert.deepEqual(medicines.heldBack, [{ listId: 'MED-00004', reasons: ['the strength must be at most 80 characters (section 46)'] }])
  assert.ok(!medicines.items.some((item) => item.listId === 'MED-00004'))
  assert.deepEqual(labTests.heldBack, [{ listId: 'LAB-0004',
    reasons: ['a test needs a LOINC or HID-LAB code to be ordered from the list (0004:243)'] }])
})

test('lab tests: the list\'s category words map to the twelve; LOINC brings its notice', () => {
  const { lab_test: seed } = build()
  assert.deepEqual(seed.items.map((item) => [item.listId, item.category]),
    [['LAB-0001', 'haematology'], ['LAB-0002', 'serology'], ['LAB-0003', 'parasitology'], ['LAB-0005', 'blood-bank'],
      ['LAB-0006', 'hormones']])
  assert.deepEqual(seed.items[0].otherNames, ['FBC', 'CBC'])
  assert.deepEqual(seed.attribution, [LOINC_NOTICE])
})

test('the Wave 0 codes: each is reported kept, renamed, recoded or missing, so the signer sees it', () => {
  const { lab_test: seed } = build()
  assert.deepEqual(seed.waveZero, [
    { code: 'WIDAL', status: 'kept', listId: 'LAB-0002' },
    { code: 'MP-RDT', status: 'recoded', listId: 'LAB-0003', now: { codeSystem: 'LOINC', code: '70569-9' } },
    { code: 'HIV-SCREEN', status: 'missing' },
  ])
})

test('ids: a gap needs a retirement reason, a retired id may not be a row, and an id is used once', () => {
  assert.throws(() => build(FIXTURE, { retired: {} }), /id gaps with no retirement reason: MED-00003/)
  assert.throws(() => build(FIXTURE, { retired: { ...RETIRED, 'MED-00001': 'Synthetic: still listed though' } }),
    /retired ids that are still rows: MED-00001/)
  assert.throws(() => build(csv(medicine('MED-00001', 'a'), medicine('MED-00001', 'b'))), /ids used twice: MED-00001/)
  assert.throws(() => build(FIXTURE, { retired: { 'MED-00003': 'short' } }), /a reason of 8-500 characters/)
  assert.throws(() => build(FIXTURE, { version: 'not a version' }), /not a version label/)
})

test('the same list makes the same bytes, so the signed sha256 is reproducible', () => {
  const first = seedText(build().medicine)
  assert.equal(seedText(build().medicine), first)
  assert.match(sha256(Buffer.from(first)), /^[0-9a-f]{64}$/)
  assert.ok(first.endsWith('}\n'))
})

test('the loader\'s checks refuse a seed it must not load', () => {
  const { medicine: good, lab_test: labs } = build()
  assert.deepEqual(seedProblems(good), [])
  assert.deepEqual(seedProblems(labs), [])
  const copy = (seed) => JSON.parse(JSON.stringify(seed))
  const twice = copy(good); twice.items.push(twice.items[0])
  assert.ok(seedProblems(twice).includes('MED-00001: the id is used twice'))
  const retiredItem = copy(good); retiredItem.items.push({ ...retiredItem.items[0], listId: 'MED-00003' })
  assert.ok(seedProblems(retiredItem).includes('MED-00003: a retired id is an item'))
  const heldBackItem = copy(good); heldBackItem.items.push({ ...heldBackItem.items[0], listId: 'MED-00004' })
  assert.ok(seedProblems(heldBackItem).includes('MED-00004: a held-back row is an item'))
  const codeTwice = copy(labs); codeTwice.items.push({ ...codeTwice.items[0], listId: 'LAB-0009' })
  assert.ok(seedProblems(codeTwice).includes('LAB-0009: the code 57021-8 is used twice'))
  const badForm = copy(good); badForm.items[0].doseForm = 'pessary'
  assert.ok(seedProblems(badForm).includes('MED-00001: the dose form is not one of section 46\'s'))
  assert.deepEqual(seedProblems({ ...copy(good), format: 'other' }).slice(0, 1), [`the format is not ${SEED_FORMAT}`])
  assert.ok(seedProblems({ ...copy(good), items: [] }).includes('the seed has no items'))
})

test('the sign-off: a file loads only when an entry names its sha256, kind and version', () => {
  const fileSha256 = 'a'.repeat(64)
  const approvals = { format: APPROVALS_FORMAT, approvals: [{ kind: 'medicine', version: '2026.1', file: 'hid-medicines.json',
    sha256: fileSha256, approvalReference: 'Synthetic sign-off reference', approvedAt: '2026-12-01T09:00:00+01:00' }] }
  assert.equal(approvalFor(approvals, { kind: 'medicine', version: '2026.1', fileSha256 }).entry.version, '2026.1')
  assert.match(approvalFor(approvals, { kind: 'medicine', version: '2026.1', fileSha256: 'b'.repeat(64) }).problem,
    /no sign-off names this file's sha256/)
  assert.match(approvalFor(approvals, { kind: 'lab_test', version: '2026.1', fileSha256 }).problem, /is for medicine 2026.1/)
  const unsigned = { format: APPROVALS_FORMAT, approvals: [{ ...approvals.approvals[0], approvalReference: '' }] }
  assert.match(approvalFor(unsigned, { kind: 'medicine', version: '2026.1', fileSha256 }).problem, /no approval reference/)
  assert.match(approvalFor({}, { kind: 'medicine', version: '2026.1', fileSha256 }).problem, /is not hid-catalog-approvals/)
})

test('docs/codes/catalog-approvals.json is well formed, and every entry it holds could be loaded', () => {
  const approvals = JSON.parse(readFileSync(resolve(repository, 'docs/codes/catalog-approvals.json'), 'utf8'))
  assert.equal(approvals.format, APPROVALS_FORMAT)
  assert.ok(Array.isArray(approvals.approvals))
  for (const entry of approvals.approvals) {
    assert.ok(['medicine', 'lab_test'].includes(entry.kind), JSON.stringify(entry))
    assert.match(entry.sha256, /^[0-9a-f]{64}$/)
    assert.equal(approvalFor(approvals, { kind: entry.kind, version: entry.version, fileSha256: entry.sha256 }).problem,
      undefined)
  }
})
