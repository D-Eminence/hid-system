import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { BUSY, DATABASE_REFUSALS, LoadRefusal, droppedIds, loadSeed, prepareLoad, refusalLine } from '../../services/ehr-api/scripts/catalog-load.mjs'
import {
  APPROVALS_FORMAT, CONFIRMED_BRAND_REVIEWS, LOINC_NOTICE, SEED_FORMAT, WHO_EML_NOTICE, addBrandNames, approvalFor, buildSeeds,
  parseCsv, seedProblems, seedText, sha256, typeStrippingProblem, withAtcProblem,
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
  { code: 'HBSAG', display: 'Hepatitis B surface antigen', specimen: 'Serum' },
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
    doseForm: 'capsule', doseFormText: 'Capsule', routes: ['oral'], atcCode: null, commonAdultDose: null,
    source: 'nigeria-eml-8', sourceSection: '6.2', sourceList: 'main', withdrawn: false,
  })
  assert.deepEqual(seed.items[1].routes, ['oral', 'rectal'])
  // ATC codes only with withAtc (the builder's --with-atc, once the WHOCC answer is recorded).
  assert.ok(seed.items.every((item) => item.atcCode === null), 'no ATC code without --with-atc')
  const { medicine: withAtc } = build(FIXTURE, { withAtc: true })
  assert.equal(withAtc.items[0].atcCode, 'J01CA04')
  assert.equal(withAtc.items.find((item) => item.listId === 'MED-00005').atcCode, null)
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

test('the Wave 0 codes: each is reported kept, recoded, held back or missing, so the signer sees it', () => {
  const { lab_test: seed } = build()
  assert.deepEqual(seed.waveZero, [
    { code: 'WIDAL', status: 'kept', listId: 'LAB-0002' },
    { code: 'MP-RDT', status: 'recoded', listId: 'LAB-0003', now: { codeSystem: 'LOINC', code: '70569-9' } },
    { code: 'HIV-SCREEN', status: 'missing' },
    { code: 'HBSAG', status: 'missing' },
  ])
  // A row of that name with no code is held back, and is reported so: not "recoded" to nothing (Rahman, #319 point 5a).
  const { lab_test: held } = build(csv(labTest('LAB-0001', 'HIV screening', { category: 'serology', code_system: '', code: '' })),
    { retired: {} })
  assert.deepEqual(held.waveZero.find((entry) => entry.code === 'HIV-SCREEN'), { code: 'HIV-SCREEN', status: 'held back', listId: 'LAB-0001' })
  assert.deepEqual(held.heldBack.map((entry) => entry.listId), ['LAB-0001'])
})

test('Wave 0: an HID-LAB code is one of hid-lab-codes.json\'s with its name, never reused or invented', () => {
  const lab = (display, code) => build(csv(labTest('LAB-0001', display, { category: 'serology', code_system: 'HID-LAB', code })),
    { retired: {} }).lab_test
  // Rahman's case: Wave 0's HIV-SCREEN on Hepatitis B surface antigen. Existing requests use HIV-SCREEN for HIV screening.
  const reused = lab('Hepatitis B surface antigen', 'HIV-SCREEN')
  assert.deepEqual(seedProblems(reused, { waveZero: WAVE_ZERO }), ['LAB-0001: the HID-LAB code HIV-SCREEN is Wave 0\'s '
    + '"HIV screening", not "Hepatitis B surface antigen" (a Wave 0 code is never changed or reused)'])
  assert.deepEqual(seedProblems(lab('HIV screen', 'HIV-SCREEN'), { waveZero: WAVE_ZERO }).length, 1, 'a renamed Wave 0 code')
  assert.deepEqual(seedProblems(lab('Hepatitis B surface antigen', 'HBSAG-2'), { waveZero: WAVE_ZERO }),
    ['LAB-0001: the HID-LAB code HBSAG-2 is not one of Wave 0\'s (docs/codes/hid-lab-codes.json)'])
  assert.deepEqual(seedProblems(lab('Hepatitis B surface antigen', 'HBSAG'), { waveZero: WAVE_ZERO }), [])
  // Without the Wave 0 codes an HID-LAB code cannot be checked, so it is refused.
  assert.match(seedProblems(lab('Hepatitis B surface antigen', 'HBSAG')).join(), /Wave 0 codes .* are needed/)
  // The repository's own Wave 0 file is what the builder and the loader read.
  const waveZero = JSON.parse(readFileSync(resolve(repository, 'docs/codes/hid-lab-codes.json'), 'utf8')).codes
  assert.equal(waveZero.length, 13)
  assert.deepEqual(seedProblems(lab('HIV screening', 'HIV-SCREEN'), { waveZero }), [])
  assert.equal(seedProblems(lab('Hepatitis B surface antigen', 'HIV-SCREEN'), { waveZero }).length, 1)
})

test('ids: a gap needs a retirement reason, a retired id may not be a row, and an id is used once', () => {
  assert.throws(() => build(FIXTURE, { retired: {} }), /id gaps with no retirement reason: MED-00003/)
  assert.throws(() => build(FIXTURE, { retired: { ...RETIRED, 'MED-00001': 'Synthetic: still listed though' } }),
    /retired ids that are still rows: MED-00001/)
  assert.throws(() => build(csv(medicine('MED-00001', 'a'), medicine('MED-00001', 'b'))), /ids used twice: MED-00001/)
  assert.throws(() => build(FIXTURE, { retired: { 'MED-00003': 'short' } }), /a reason of 8-500 characters/)
  assert.throws(() => build(FIXTURE, { version: 'not a version' }), /not a version label/)
})

test('a row the seed holds back is never also retired: fix the row, do not retire it (builder and seedProblems)', () => {
  // MED-00004's strength is over 80 characters, so the builder holds it back; retiring it instead would drop it for good.
  const line = 'MED-00004 is held back in this seed and also listed as retired; fix the row, do not retire it'
  assert.throws(() => build(FIXTURE, { retired: { ...RETIRED, 'MED-00004': 'Synthetic: retired instead of fixed' } }),
    (error) => error.message === line)
  // A seed made by hand that holds back and retires the same id: seedProblems refuses it (the builder's and the loader's check).
  const seed = JSON.parse(JSON.stringify(build().medicine))
  assert.deepEqual(seedProblems(seed), [])
  seed.retired.push({ listId: 'MED-00004', reason: 'Synthetic: retired instead of fixed' })
  assert.deepEqual(seedProblems(seed), [line])
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
  assert.deepEqual(seedProblems(labs, { waveZero: WAVE_ZERO }), [])
  const copy = (seed) => JSON.parse(JSON.stringify(seed))
  const twice = copy(good); twice.items.push(twice.items[0])
  assert.ok(seedProblems(twice).includes('MED-00001: the id is used twice'))
  const retiredItem = copy(good); retiredItem.items.push({ ...retiredItem.items[0], listId: 'MED-00003' })
  assert.ok(seedProblems(retiredItem).includes('MED-00003: a retired id is an item'))
  const heldBackItem = copy(good); heldBackItem.items.push({ ...heldBackItem.items[0], listId: 'MED-00004' })
  assert.ok(seedProblems(heldBackItem).includes('MED-00004: a held-back row is an item'))
  const codeTwice = copy(labs); codeTwice.items.push({ ...codeTwice.items[0], listId: 'LAB-0009' })
  assert.ok(seedProblems(codeTwice, { waveZero: WAVE_ZERO }).includes('LAB-0009: the code 57021-8 is used twice'))
  const badForm = copy(good); badForm.items[0].doseForm = 'pessary'
  assert.ok(seedProblems(badForm).includes('MED-00001: the dose form is not one of section 46\'s'))
  assert.deepEqual(seedProblems({ ...copy(good), format: 'other' }).slice(0, 1), [`the format is not ${SEED_FORMAT}`])
  assert.ok(seedProblems({ ...copy(good), items: [] }).includes('the seed has no items'))
})

const LICENCES = { nigeriaEml8: 'Synthetic: owner confirmation record 1', whoccAtc: 'Synthetic: WHOCC terms answer record 1' }

test('the sign-off: a file loads only when an entry names its sha256, kind and version', () => {
  const fileSha256 = 'a'.repeat(64)
  const approvals = { format: APPROVALS_FORMAT, approvals: [{ kind: 'medicine', version: '2026.1', file: 'hid-medicines.json',
    sha256: fileSha256, approvalReference: 'Synthetic sign-off reference', approvedAt: '2026-12-01T09:00:00+01:00',
    licences: { nigeriaEml8: LICENCES.nigeriaEml8 } }] }
  assert.equal(approvalFor(approvals, { kind: 'medicine', version: '2026.1', fileSha256 }).entry.version, '2026.1')
  assert.match(approvalFor(approvals, { kind: 'medicine', version: '2026.1', fileSha256: 'b'.repeat(64) }).problem,
    /no sign-off names this file's sha256/)
  assert.match(approvalFor(approvals, { kind: 'lab_test', version: '2026.1', fileSha256 }).problem, /is for medicine 2026.1/)
  const unsigned = { format: APPROVALS_FORMAT, approvals: [{ ...approvals.approvals[0], approvalReference: '' }] }
  assert.match(approvalFor(unsigned, { kind: 'medicine', version: '2026.1', fileSha256 }).problem, /no approval reference/)
  assert.match(approvalFor({}, { kind: 'medicine', version: '2026.1', fileSha256 }).problem, /is not hid-catalog-approvals/)
})

test('licences: a medicine sign-off records the Nigeria EML 8th edition confirmation, and the WHOCC answer for ATC codes', () => {
  const fileSha256 = 'a'.repeat(64)
  const entry = { kind: 'medicine', version: '2026.1', sha256: fileSha256, approvalReference: 'Synthetic sign-off reference',
    approvedAt: '2026-12-01T09:00:00+01:00' }
  const signed = (licences) => ({ format: APPROVALS_FORMAT, approvals: [{ ...entry, ...(licences ? { licences } : {}) }] })
  const lookup = (approvals, holdsAtc = false) => approvalFor(approvals, { kind: 'medicine', version: '2026.1', fileSha256, holdsAtc })
  assert.match(lookup(signed()).problem, /does not record the owner's confirmation that the Nigeria EML 8th edition may be used/)
  assert.match(lookup(signed({ nigeriaEml8: 'short' })).problem, /licences\.nigeriaEml8/)
  assert.equal(lookup(signed({ nigeriaEml8: LICENCES.nigeriaEml8 })).problem, undefined)
  assert.match(lookup(signed({ nigeriaEml8: LICENCES.nigeriaEml8 }), true).problem,
    /this file holds ATC codes, and the sign-off .* does not record the WHOCC terms answer/)
  assert.equal(lookup(signed(LICENCES), true).problem, undefined)
  // A lab-test sign-off needs neither.
  assert.equal(approvalFor({ format: APPROVALS_FORMAT, approvals: [{ ...entry, kind: 'lab_test' }] },
    { kind: 'lab_test', version: '2026.1', fileSha256 }).problem, undefined)
  // The builder's --with-atc: only once a medicine entry of that version records the WHOCC answer.
  assert.match(withAtcProblem(signed({ nigeriaEml8: LICENCES.nigeriaEml8 }), '2026.1'), /--with-atc needs the WHOCC terms answer/)
  assert.match(withAtcProblem(signed(LICENCES), '2026.2'), /licences\.whoccAtc on a medicine 2026\.2 entry/)
  assert.equal(withAtcProblem(signed(LICENCES), '2026.1'), null)
  assert.match(withAtcProblem({}, '2026.1'), /--with-atc needs/)
})

// A brand row as the builder passes it: brand-names.ts's brand and generic, its reviewed_by, and isActiveBrandRow.
const confirmed = (brand, generic) => ({ brand, generic, reviewedBy: 'coordinator-curated', active: true })
const pending = (brand, generic) => ({ brand, generic, reviewedBy: 'pending-pharmacist', active: true })

test('brand names: added only where the brand\'s generic is exactly one medicine\'s name; the rest are reported', () => {
  const item = (listId, genericName, otherNames = []) => ({ listId, genericName, otherNames })
  const medicines = [item('MED-00001', 'paracetamol'), item('MED-00002', 'paracetamol'),
    item('MED-00003', 'amoxicillin + clavulanic acid'), item('MED-00004', 'metronidazole', ['Flagyl']),
    item('MED-00005', 'chlorphenamine')]
  const { items, brands } = addBrandNames(medicines, [
    confirmed('panadol', 'paracetamol'), confirmed('augmentin', 'Amoxicillin  +  Clavulanic acid'),
    confirmed('flagyl', 'metronidazole'), confirmed('piriton', 'chlorpheniramine'),
    confirmed('ampiclox', 'ampicillin + cloxacillin'), confirmed('coamox', 'amoxicillin and clavulanic acid')])
  assert.deepEqual(items.map((entry) => entry.otherNames), [['panadol'], ['panadol'], ['augmentin'], ['Flagyl'], []])
  assert.deepEqual(brands.added, [{ brand: 'panadol', generic: 'paracetamol', items: 2 },
    { brand: 'augmentin', generic: 'Amoxicillin  +  Clavulanic acid', items: 1 }, { brand: 'flagyl', generic: 'metronidazole', items: 1 }])
  assert.deepEqual(brands.leftOut.map((entry) => [entry.brand, entry.generic]), [['piriton', 'chlorpheniramine'],
    ['ampiclox', 'ampicillin + cloxacillin'], ['coamox', 'amoxicillin and clavulanic acid']], 'never guessed')
  assert.ok(brands.leftOut.every((entry) => entry.why === 'no medicine in the seed has this generic name'))
  assert.equal(brands.items, 3)
  // Two medicines whose names differ only in case or spacing: the brand is not guessed onto either.
  const twice = addBrandNames([item('MED-00001', 'paracetamol'), item('MED-00002', 'Paracetamol')], [confirmed('panadol', 'paracetamol')])
  assert.deepEqual(twice.items.map((entry) => entry.otherNames), [[], []])
  assert.match(twice.brands.leftOut[0].why, /2 medicines/)
  // Through the builder: on the items that load, signed with the file.
  const { medicine: seed, brands: report } = build(FIXTURE, { brands: [confirmed('panadol', 'paracetamol'),
    confirmed('epilim', 'sodium valproate')] })
  assert.deepEqual(seed.items.find((entry) => entry.listId === 'MED-00002').otherNames, ['panadol'])
  assert.deepEqual(report.leftOut, [{ brand: 'epilim', generic: 'sodium valproate', why: 'no medicine in the seed has this generic name' }])
})

test('brand names: only a confirmed row goes into the seed; one pending a pharmacist, or of any other status, is left out with why', () => {
  assert.deepEqual(CONFIRMED_BRAND_REVIEWS, ['coordinator-curated'])
  const item = (listId, genericName) => ({ listId, genericName, otherNames: [] })
  const medicines = [item('MED-00001', 'artemether + lumefantrine'), item('MED-00002', 'paracetamol'), item('MED-00003', 'ciprofloxacin')]
  const { items, brands } = addBrandNames(medicines, [
    confirmed('coartem', 'artemether + lumefantrine'), pending('lonart', 'artemether + lumefantrine'),
    pending('ciprotab', 'ciprofloxacin'), { brand: 'calpol', generic: 'paracetamol', reviewedBy: 'pharmacist-confirmed?', active: true },
    { brand: 'emzor', generic: 'paracetamol', active: true }, { ...confirmed('panadol', 'paracetamol'), active: false }])
  assert.deepEqual(items.map((entry) => entry.otherNames), [['coartem'], [], []], 'a pending brand never reaches a prescriber\'s search')
  assert.deepEqual(brands.added, [{ brand: 'coartem', generic: 'artemether + lumefantrine', items: 1 }])
  assert.deepEqual(brands.leftOut, [
    { brand: 'lonart', generic: 'artemether + lumefantrine', why: 'pending pharmacist review' },
    { brand: 'ciprotab', generic: 'ciprofloxacin', why: 'pending pharmacist review' },
    { brand: 'calpol', generic: 'paracetamol', why: 'review status "pharmacist-confirmed?" is not confirmed' },
    { brand: 'emzor', generic: 'paracetamol', why: 'review status null is not confirmed' },
    { brand: 'panadol', generic: 'paracetamol', why: 'not an active row of brand-names.ts' }])
  assert.equal(brands.items, 1)
})

test('brand-names.ts: every row has one of the two review statuses the rule knows; augmentin and panadol are confirmed', async () => {
  const module = await import(pathToFileURL(resolve(repository, 'services/ocr-worker/src/reading/brand-names.ts')).href)
  const statuses = new Set(module.BRAND_ROWS.map((row) => row.reviewed_by))
  assert.deepEqual([...statuses].sort(), ['coordinator-curated', 'pending-pharmacist'])
  const rows = module.BRAND_ROWS.map((row) => ({ brand: row.brand, generic: row.generic, reviewedBy: row.reviewed_by,
    active: module.isActiveBrandRow(row) }))
  assert.ok(rows.every((row) => typeof row.brand === 'string' && typeof row.generic === 'string'))
  for (const brand of ['augmentin', 'panadol']) {
    assert.equal(rows.find((row) => row.brand === brand).reviewedBy, 'coordinator-curated', brand)
    assert.equal(rows.find((row) => row.brand === brand).active, true, brand)
  }
  assert.ok(rows.some((row) => row.reviewedBy === 'pending-pharmacist'))
})

// The builder (build-catalog-seeds.mjs) end to end, on a tiny list, a brands module standing in for brand-names.ts.
const builderScript = resolve(repository, 'services/ehr-api/scripts/build-catalog-seeds.mjs')
function builderFolder() {
  const folder = mkdtempSync(join(tmpdir(), 'catalog-build-'))
  writeFileSync(join(folder, 'list.csv'), FIXTURE)
  writeFileSync(join(folder, 'retired.json'), JSON.stringify(RETIRED))
  writeFileSync(join(folder, 'wave-zero.json'), JSON.stringify({ codes: WAVE_ZERO }))
  writeFileSync(join(folder, 'brands.mjs'), `export const BRAND_ROWS = ${JSON.stringify([
    { brand: 'panadol', generic: 'paracetamol', strength_forms: '', source: 'coordinator-curated 2026-11', reviewed_by: 'coordinator-curated' },
    { brand: 'amoxil', generic: 'amoxicillin', strength_forms: '', source: 'coordinator-curated 2026-11', reviewed_by: 'coordinator-curated' },
    { brand: 'epilim', generic: 'sodium valproate', strength_forms: '', source: 'coordinator-curated 2026-11', reviewed_by: 'coordinator-curated' },
    { brand: 'calpol', generic: 'paracetamol', strength_forms: '', source: 'NAFDAC Greenbook (synthetic)', reviewed_by: 'pending-pharmacist' }])};
export const isActiveBrandRow = () => true;\n`)
  return folder
}
const runBuilder = (folder, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, builderScript, '--csv', join(folder, 'list.csv'),
  '--retired', join(folder, 'retired.json'), '--wave-zero', join(folder, 'wave-zero.json'), '--version', '2026.1',
  '--out', folder, '--brands', join(folder, 'brands.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH } })

test('the builder reports every brand added (brand -> generic) and every brand left out, with why', () => {
  const folder = builderFolder()
  try {
    const result = runBuilder(folder)
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)['hid-medicines.json'].brands
    assert.deepEqual(report, { added: ['panadol -> paracetamol (1 item)', 'amoxil -> amoxicillin (1 item)'], onItems: 1,
      leftOut: ['epilim -> sodium valproate: no medicine in the seed has this generic name',
        'calpol -> paracetamol: pending pharmacist review'] }, 'amoxil is already an other name of MED-00001')
    const seed = JSON.parse(readFileSync(join(folder, 'hid-medicines.json'), 'utf8'))
    assert.deepEqual(seed.items.find((entry) => entry.listId === 'MED-00002').otherNames, ['panadol'])
    assert.ok(!seed.items.some((entry) => entry.otherNames.includes('calpol')))
    assert.equal(runBuilder(folder).status, 0)
    const check = spawnSync(process.execPath, [builderScript, '--csv', join(folder, 'list.csv'), '--retired', join(folder, 'retired.json'),
      '--wave-zero', join(folder, 'wave-zero.json'), '--version', '2026.1', '--out', folder, '--brands', join(folder, 'brands.mjs'),
      '--check'], { encoding: 'utf8', env: { PATH: process.env.PATH } })
    assert.equal(check.status, 0, check.stderr)
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('the builder\'s report opens with Ola\'s brand decision: the 21 confirmed brands, the pending ones kept out', async () => {
  const { BRAND_DECISION, CHECKED_BRANDS } = await import('../../services/ehr-api/scripts/catalog-seed.mjs')
  assert.deepEqual(CHECKED_BRANDS, ['valium', 'phenergan', 'flagyl', 'amoxil', 'augmentin', 'septrin', 'rocephin', 'zinnat',
    'coartem', 'fansidar', 'daraprim', 'panadol', 'norvasc', 'adalat', 'lasix', 'plasil', 'glucophage', 'ventolin', 'postinor',
    'buscopan', 'voltaren'])
  assert.equal(BRAND_DECISION, 'Brands (Ola\'s clinical decision as clinical owner, #319): only rows of brand-names.ts reviewed '
    + '"coordinator-curated" go into the medicine seed. The 21 coordinator-curated brands in the seed built from #312\'s list ('
    + CHECKED_BRANDS.join(', ') + ') were checked by Ola on 23 Nov 2026 and are confirmed. A brand pending a pharmacist\'s '
    + 'review stays out until a pharmacist confirms it.')
  // Each brand Ola checked is a confirmed, active row of the real brand-names.ts.
  const module = await import(pathToFileURL(resolve(repository, 'services/ocr-worker/src/reading/brand-names.ts')).href)
  for (const brand of CHECKED_BRANDS) {
    const row = module.BRAND_ROWS.find((entry) => entry.brand === brand)
    assert.equal(row?.reviewed_by, 'coordinator-curated', brand)
    assert.equal(module.isActiveBrandRow(row), true, brand)
  }
  const folder = builderFolder()
  try {
    const result = runBuilder(folder)
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(Object.keys(report), ['brandDecision', 'hid-medicines.json', 'hid-lab-tests.json'])
    assert.equal(report.brandDecision, BRAND_DECISION)
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('the builder refuses a retired id that it holds back, with one plain line (exit 2), and builds nothing', () => {
  const folder = builderFolder()
  try {
    writeFileSync(join(folder, 'retired.json'), JSON.stringify({ ...RETIRED, 'MED-00004': 'Synthetic: retired instead of fixed' }))
    const result = runBuilder(folder)
    assert.equal(result.stderr.trim(), 'MED-00004 is held back in this seed and also listed as retired; fix the row, do not retire '
      + 'it; nothing built')
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.ok(!existsSync(join(folder, 'hid-medicines.json')), 'nothing built')
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

// The files in a builder folder, for "nothing built" and "no temporary file left".
const folderFiles = (folder) => readdirSync(folder).sort()
const FOLDER_INPUTS = ['brands.mjs', 'list.csv', 'retired.json', 'wave-zero.json']

test('everything the builder reads is inside its one-line handling: a broken CSV is one plain line (exit 2), nothing built', () => {
  const cases = [
    // An unclosed quote, and a row with the wrong number of fields (round 4 of #319, point 2a).
    ['list.csv', `${FIXTURE}MED-00006,medicine,"an unclosed quote\n`, (folder) => `the combined list ${join(folder, 'list.csv')}: `
      + 'CSV: a quoted field is not closed'],
    ['list.csv', `${FIXTURE}MED-00006,medicine,three fields\n`, (folder) => `the combined list ${join(folder, 'list.csv')}: `
      + 'CSV row 12: 3 fields where the header has 18'],
    ['list.csv', 'id,list,name,source\nMED-00001,medicine,amoxicillin,nigeria-eml-8\n', (folder) => `the combined list `
      + `${join(folder, 'list.csv')} has no dose_form column`],
    ['retired.json', '{"MED-00003": ', (folder) => `the retired ids file ${join(folder, 'retired.json')} is not JSON`],
    ['retired.json', '["MED-00003"]', (folder) => `the retired ids file ${join(folder, 'retired.json')} is not an object of `
      + 'retired ids, each with why'],
    ['wave-zero.json', '{"codes": "none"}', (folder) => `the Wave 0 codes file ${join(folder, 'wave-zero.json')} has no list of `
      + 'codes, each with its name'],
    ['brands.mjs', 'export const BRAND_ROWS = [', (folder) => `the brand names file ${join(folder, 'brands.mjs')} cannot be read `
      + '(Unexpected end of input)'],
    ['brands.mjs', 'export const rows = []\n', (folder) => `the brand names file ${join(folder, 'brands.mjs')} has no BRAND_ROWS and `
      + 'isActiveBrandRow'],
  ]
  for (const [file, text, line] of cases) {
    const folder = builderFolder()
    try {
      writeFileSync(join(folder, file), text)
      const result = runBuilder(folder)
      assert.equal(result.stderr, `${line(folder)}; nothing built\n`, `${file}: ${text.slice(-40)}`)
      assert.equal(result.status, 2, file)
      assert.equal(result.stdout, '', file)
      assert.deepEqual(folderFiles(folder), FOLDER_INPUTS, `${file}: nothing built`)
    } finally { rmSync(folder, { recursive: true, force: true }) }
  }
  // A file that is not there is one line too.
  const folder = builderFolder()
  try {
    rmSync(join(folder, 'retired.json'))
    const result = runBuilder(folder)
    assert.equal(result.stderr, `the retired ids file ${join(folder, 'retired.json')} cannot be read (ENOENT); nothing built\n`)
    assert.equal(result.status, 2)
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('the builder writes both seeds or neither: a bad lab-test list leaves no new medicine file behind', () => {
  // LAB-0002's HID-LAB code is not one of Wave 0's: the lab-test seed would not load. The medicines are good.
  const badLab = FIXTURE.replace(',HID-LAB,WIDAL,', ',HID-LAB,WIDAL-2,')
  assert.notEqual(badLab, FIXTURE)
  const refusal = 'hid-lab-tests.json: LAB-0002: the HID-LAB code WIDAL-2 is not one of Wave 0\'s (docs/codes/hid-lab-codes.json); '
    + 'nothing built\n'
  const folder = builderFolder()
  try {
    // A first build: neither seed is written.
    writeFileSync(join(folder, 'list.csv'), badLab)
    let result = runBuilder(folder)
    assert.equal(result.stderr, refusal)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.deepEqual(folderFiles(folder), FOLDER_INPUTS, 'no medicine file, no lab-test file, no temporary file')
    // Seeds already there (a good build) stay exactly as they were when a changed list is refused.
    writeFileSync(join(folder, 'list.csv'), FIXTURE)
    assert.equal(runBuilder(folder).status, 0)
    const before = ['hid-medicines.json', 'hid-lab-tests.json'].map((file) => readFileSync(join(folder, file)))
    writeFileSync(join(folder, 'list.csv'), badLab.replace('prussian blue', 'prussian blue (ferric hexacyanoferrate)'))
    result = runBuilder(folder)
    assert.equal(result.stderr, refusal)
    assert.equal(result.status, 2)
    assert.deepEqual(['hid-medicines.json', 'hid-lab-tests.json'].map((file) => readFileSync(join(folder, file))), before)
    assert.deepEqual(folderFiles(folder), [...FOLDER_INPUTS, 'hid-lab-tests.json', 'hid-medicines.json'].sort())
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('a seed file the builder cannot write is one plain line (exit 1); no temporary file is left', () => {
  const folder = builderFolder()
  try {
    // No such output folder: nothing is written.
    const missing = join(folder, 'no-such-folder')
    let result = spawnSync(process.execPath, [builderScript, '--csv', join(folder, 'list.csv'), '--retired', join(folder, 'retired.json'),
      '--wave-zero', join(folder, 'wave-zero.json'), '--version', '2026.1', '--out', missing, '--brands', join(folder, 'brands.mjs')],
    { encoding: 'utf8', env: { PATH: process.env.PATH } })
    assert.equal(result.stderr, `the seed files could not be written to ${missing} (ENOENT); nothing built\n`)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    // The lab-test file's name taken by a folder: the medicine file is renamed into place first, and the line says so.
    mkdirSync(join(folder, 'hid-lab-tests.json'))
    result = runBuilder(folder)
    assert.equal(result.stderr, `hid-medicines.json was written to ${folder} but the other seed file could not be (EISDIR); `
      + 'run the builder again\n')
    assert.equal(result.status, 1)
    assert.deepEqual(folderFiles(folder), [...FOLDER_INPUTS, 'hid-lab-tests.json', 'hid-medicines.json'].sort(),
      'no temporary file left')
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('the builder needs Node 22.18 (type stripping) and says so plainly before it reads anything', () => {
  for (const version of ['22.17.1', '22.0.0', '20.19.4', '23.5.0', '18.20.8']) {
    assert.match(typeStrippingProblem(version), new RegExp(`needs Node 22\\.18 or later; this is Node ${version.replaceAll('.', '\\.')}; nothing built$`))
  }
  for (const version of ['22.18.0', '22.22.0', '23.6.0', '24.11.1', '25.0.0']) assert.equal(typeStrippingProblem(version), null, version)
  const folder = builderFolder()
  try {
    const result = runBuilder(folder, ['--import', 'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"22.17.1"})'])
    assert.equal(result.status, 2)
    assert.equal(result.stderr.trim(), 'the seed builder reads services/ocr-worker/src/reading/brand-names.ts with Node\'s own '
      + 'TypeScript type stripping, which needs Node 22.18 or later; this is Node 22.17.1; nothing built')
    assert.equal(result.stdout, '')
    assert.ok(!existsSync(join(folder, 'hid-medicines.json')), 'nothing built')
  } finally { rmSync(folder, { recursive: true, force: true }) }
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

// The loader (catalog-load.mjs, load-catalog.mjs): its refusals before it connects, and its transaction with a
// stand-in client. The real-database runs are in the PR's evidence.
const loaderScript = resolve(repository, 'services/ehr-api/scripts/load-catalog.mjs')
const waveZeroFile = resolve(repository, 'docs/codes/hid-lab-codes.json')
function signedFiles(seed, { licences = { nigeriaEml8: LICENCES.nigeriaEml8 }, approvalsText } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'catalog-load-'))
  const text = seedText(seed)
  const seedPath = join(folder, 'seed.json')
  writeFileSync(seedPath, text)
  const approvalsPath = join(folder, 'approvals.json')
  writeFileSync(approvalsPath, approvalsText ?? JSON.stringify({ format: APPROVALS_FORMAT, approvals: [{ kind: seed.kind,
    version: seed.version, file: 'seed.json', sha256: sha256(Buffer.from(text)), approvalReference: 'Synthetic sign-off reference',
    approvedAt: '2026-12-01T09:00:00+01:00', ...(licences ? { licences } : {}) }] }))
  return { folder, seedPath, approvalsPath }
}
function runLoader(args, environment) {
  const result = spawnSync(process.execPath, [loaderScript, ...args], { encoding: 'utf8',
    env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://nobody@127.0.0.1:9/none', ...environment } })
  return { status: result.status, stderr: result.stderr.trim(), stdout: result.stdout.trim() }
}

test('the loader refuses --approvals under NODE_ENV=production, before it reads or connects (exit 2)', () => {
  const { folder, seedPath, approvalsPath } = signedFiles(build().medicine)
  try {
    assert.throws(() => prepareLoad({ seedPath, approvalsPath, approvalsGiven: true, waveZeroPath: waveZeroFile,
      environment: { NODE_ENV: 'production' } }), (error) => error instanceof LoadRefusal
      && /--approvals is not allowed in production/.test(error.message))
    const refused = runLoader(['--seed', seedPath, '--approvals', approvalsPath], { NODE_ENV: 'production' })
    assert.equal(refused.status, 2)
    assert.equal(refused.stderr, 'load-catalog: --approvals is not allowed in production: only the deployed '
      + 'docs/codes/catalog-approvals.json signs a load; nothing loaded')
    // Outside production the same file signs the load, and the approvals file's own sha256 is what the version records.
    const prepared = prepareLoad({ seedPath, approvalsPath, approvalsGiven: true, waveZeroPath: waveZeroFile,
      environment: { NODE_ENV: 'test' } })
    assert.equal(prepared.approvalsSha256, sha256(readFileSync(approvalsPath)))
    assert.equal(prepared.fileSha256, sha256(readFileSync(seedPath)))
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('the loader refuses a malformed approvals file, an unreadable seed and a missing licence answer with a plain line (exit 2)', () => {
  const { folder, seedPath, approvalsPath } = signedFiles(build().medicine, { approvalsText: '{"format": "hid-catalog-approvals/1",' })
  try {
    const malformed = runLoader(['--seed', seedPath, '--approvals', approvalsPath], { NODE_ENV: 'test' })
    assert.equal(malformed.status, 2)
    assert.equal(malformed.stderr, `load-catalog: the approvals file ${approvalsPath} is not JSON; nothing loaded`)
    const missing = runLoader(['--seed', join(folder, 'none.json'), '--approvals', approvalsPath], { NODE_ENV: 'test' })
    assert.equal(missing.status, 2)
    assert.equal(missing.stderr, `load-catalog: the seed file ${join(folder, 'none.json')} cannot be read (ENOENT); nothing loaded`)
    assert.equal(runLoader([], { NODE_ENV: 'test' }).stderr, 'load-catalog: --seed is required; nothing loaded')
  } finally { rmSync(folder, { recursive: true, force: true }) }
  const unlicensed = signedFiles(build().medicine, { licences: null })
  try {
    const refused = runLoader(['--seed', unlicensed.seedPath, '--approvals', unlicensed.approvalsPath], { NODE_ENV: 'test' })
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /^load-catalog: the sign-off for medicine 2026\.1 does not record the owner's confirmation that the Nigeria EML 8th edition may be used \(licences\.nigeriaEml8\); nothing loaded$/)
  } finally { rmSync(unlicensed.folder, { recursive: true, force: true }) }
  // ATC codes in a file need the WHOCC answer in its sign-off.
  const atc = signedFiles(build(FIXTURE, { withAtc: true }).medicine)
  try {
    assert.throws(() => prepareLoad({ seedPath: atc.seedPath, approvalsPath: atc.approvalsPath, waveZeroPath: waveZeroFile,
      environment: {} }), /this file holds ATC codes, and the sign-off for medicine 2026\.1 does not record the WHOCC terms answer/)
  } finally { rmSync(atc.folder, { recursive: true, force: true }) }
  // A lab-test seed reusing Wave 0's HIV-SCREEN is refused by the loader too, against the repository's Wave 0 file.
  const reused = build(csv(labTest('LAB-0001', 'Hepatitis B surface antigen', { category: 'serology', code_system: 'HID-LAB',
    code: 'HIV-SCREEN' })), { retired: {} }).lab_test
  const lab = signedFiles(reused)
  try {
    assert.throws(() => prepareLoad({ seedPath: lab.seedPath, approvalsPath: lab.approvalsPath, waveZeroPath: waveZeroFile,
      environment: {} }), /the HID-LAB code HIV-SCREEN is Wave 0's "HIV screening", not "Hepatitis B surface antigen"/)
  } finally { rmSync(lab.folder, { recursive: true, force: true }) }
})

/** A stand-in pg client: answers the loader's statements from a fixed active version, and records them. */
class StandInClient {
  constructor({ active = null, busyOn = null, failOn = null, ready = true } = {}) {
    this.active = active; this.busyOn = busyOn; this.failOn = failOn; this.ready = ready; this.statements = []
  }
  async query(sql, params = []) {
    this.statements.push({ sql, params })
    if (this.busyOn && sql.includes(this.busyOn)) {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
    }
    if (this.failOn && sql.includes(this.failOn.sql)) throw this.failOn.error
    if (sql.includes('to_regclass')) return { rows: [{ ready: this.ready }], rowCount: 1 }
    if (sql.startsWith('select 1 from ehr.catalog_versions')) return { rows: [], rowCount: 0 }
    if (sql.includes('versions.active')) return { rows: this.active ? [this.active] : [], rowCount: this.active ? 1 : 0 }
    if (sql.includes('insert into ehr.catalog_retired_codes')) {
      const rows = JSON.parse(params[1]).map((entry) => ({ list_id: entry.listId }))
      return { rows, rowCount: rows.length }
    }
    if (/insert into ehr\.catalog_(medicines|lab_tests|diagnoses)/.test(sql)) return { rows: [], rowCount: JSON.parse(params[1]).length }
    if (sql.includes('set active = false')) return { rows: this.active ? [{ version: this.active.version }] : [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }
  writes() { return this.statements.filter(({ sql }) => /^\s*(insert|update)/.test(sql)) }
}

test('dropped ids: an id of the active version missing from the seed is refused unless it is retired with a reason', async () => {
  // The active 2026.1 holds MED-00006, the highest id; the new seed ends at MED-00005, so the builder sees no gap.
  const active = { version: '2026.1', ids: ['MED-00001', 'MED-00002', 'MED-00005', 'MED-00006'] }
  const dropping = build(FIXTURE, { version: '2026.2' }).medicine
  assert.deepEqual(seedProblems(dropping), [])
  const approval = { approvalReference: 'Synthetic sign-off reference', approvedAt: '2026-12-02T09:00:00+01:00' }
  const refusedClient = new StandInClient({ active })
  await assert.rejects(loadSeed(refusedClient, { seed: dropping, fileSha256: 'a'.repeat(64), approval, approvalsSha256: 'b'.repeat(64) }),
    (error) => error instanceof LoadRefusal && refusalLine(error) === 'load-catalog: the active medicine 2026.1 holds an id this '
      + 'seed drops without retiring: MED-00006; list each in the seed\'s retired ids with a reason; nothing loaded')
  assert.deepEqual(refusedClient.writes(), [], 'nothing written')
  assert.equal(refusedClient.statements.at(-1).sql, 'rollback')
  // Listed in the seed's retired ids with a reason, it loads and is recorded as retired.
  const retiring = build(FIXTURE, { version: '2026.2', retired: { ...RETIRED, 'MED-00006': 'Synthetic: dropped from the list' } }).medicine
  const client = new StandInClient({ active })
  const outcome = await loadSeed(client, { seed: retiring, fileSha256: 'a'.repeat(64), approval, approvalsSha256: 'b'.repeat(64) })
  assert.deepEqual(outcome, { status: 'loaded', kind: 'medicine', version: '2026.2', fileSha256: 'a'.repeat(64),
    approvalsSha256: 'b'.repeat(64), items: 3, newRetiredIds: ['MED-00003', 'MED-00006'], replaced: '2026.1', heldBack: 1 })
  const version = client.statements.find(({ sql }) => sql.includes('insert into ehr.catalog_versions'))
  assert.match(version.sql, /approval_reference,\s+approvals_sha256, approved_at/)
  assert.equal(version.params[5], 'b'.repeat(64), 'the version records the approvals file\'s sha256')
  assert.equal(client.statements.at(-1).sql, 'commit')
})

test('an ICD-11 release (0150) loads into ehr.catalog_diagnoses, needs 0150, and has no dropped-id check', async () => {
  const seed = { format: SEED_FORMAT, kind: 'diagnosis', version: '2026-01',
    attribution: ['Synthetic notice: ICD-11, World Health Organization, CC BY-ND 3.0 IGO.'], retired: [], items: [
      { code: '1F40', title: 'Malaria due to Plasmodium falciparum', otherNames: ['falciparum malaria'], chapter: '01', residual: false },
      { code: 'RA01', title: 'COVID-19', otherNames: [], chapter: '25', residual: false }] }
  assert.deepEqual(seedProblems(seed), [])
  const approval = { approvalReference: 'Synthetic sign-off reference', approvedAt: '2026-12-01T09:00:00+01:00' }
  // The active release holds a code the new one leaves out: a WHO release may drop a code, so it still loads.
  const client = new StandInClient({ active: { version: '2025-01', ids: ['1F41'] } })
  const outcome = await loadSeed(client, { seed, fileSha256: 'a'.repeat(64), approval, approvalsSha256: 'b'.repeat(64) })
  assert.deepEqual(outcome, { status: 'loaded', kind: 'diagnosis', version: '2026-01', fileSha256: 'a'.repeat(64),
    approvalsSha256: 'b'.repeat(64), items: 2, newRetiredIds: [], replaced: '2025-01', heldBack: 0 })
  assert.deepEqual(client.statements.find(({ sql }) => sql.includes('to_regclass')).params, ['diagnosis'])
  assert.ok(!client.statements.some(({ sql }) => sql.includes('versions.active')), 'no dropped-id query for a diagnosis list')
  const rows = client.statements.find(({ sql }) => sql.includes('insert into ehr.catalog_diagnoses'))
  assert.deepEqual(JSON.parse(rows.params[1]).map((item) => item.code), ['1F40', 'RA01'])
  assert.equal(client.statements.at(-1).sql, 'commit')
  // A schema without 0150 is refused, nothing written.
  const without = new StandInClient({ ready: false })
  await assert.rejects(loadSeed(without, { seed, fileSha256: 'a'.repeat(64), approval, approvalsSha256: 'b'.repeat(64) }),
    (error) => error instanceof LoadRefusal && refusalLine(error)
      === 'load-catalog: this schema has no catalogue tables for diagnosis (0150 is not applied); nothing loaded')
  assert.deepEqual(without.writes(), [])
})

test('a busy lock is the house busy refusal (exit 2), not a raw lock timeout', async () => {
  const seed = build().medicine
  const approval = { approvalReference: 'Synthetic sign-off reference', approvedAt: '2026-12-01T09:00:00+01:00' }
  for (const busyOn of ['pg_advisory_xact_lock', 'lock table ehr.catalog_versions']) {
    const client = new StandInClient({ busyOn })
    await assert.rejects(loadSeed(client, { seed, fileSha256: 'a'.repeat(64), approval, approvalsSha256: 'b'.repeat(64) }),
      (error) => error instanceof LoadRefusal && error.message === BUSY && refusalLine(error) === 'load-catalog: '
        + 'ehr.catalog_versions or another catalogue load stayed busy for 5 seconds; nothing loaded; run the release again at a quieter time')
    assert.deepEqual(client.writes(), [])
  }
})

test('dropped ids: an id of the live list that this seed holds back is to be fixed, never retired', async () => {
  // MED-00004 is live in 2026.1; the new seed holds it back (its strength is over 80 characters).
  const seed = build(FIXTURE, { version: '2026.2' }).medicine
  assert.deepEqual(seed.heldBack.map((entry) => entry.listId), ['MED-00004'])
  const approval = { approvalReference: 'Synthetic sign-off reference', approvedAt: '2026-12-02T09:00:00+01:00' }
  const load = (active) => loadSeed(new StandInClient({ active }), { seed, fileSha256: 'a'.repeat(64), approval,
    approvalsSha256: 'b'.repeat(64) })
  const line = (error) => error instanceof LoadRefusal && refusalLine(error)
  let refused
  await assert.rejects(load({ version: '2026.1', ids: ['MED-00001', 'MED-00002', 'MED-00004', 'MED-00005'] }),
    (error) => { refused = line(error); return true })
  assert.equal(refused, 'load-catalog: MED-00004 is in the live list but held back in this seed; fix the row, do not retire it; '
    + 'nothing loaded')
  // Held back and dropped outright together: each is named with what to do.
  await assert.rejects(load({ version: '2026.1', ids: ['MED-00001', 'MED-00002', 'MED-00004', 'MED-00005', 'MED-00006'] }),
    (error) => { refused = line(error); return true })
  assert.equal(refused, 'load-catalog: MED-00004 is in the live list but held back in this seed; fix the row, do not retire it; '
    + 'the active medicine 2026.1 holds an id this seed drops without retiring: MED-00006; list each in the seed\'s retired ids '
    + 'with a reason; nothing loaded')
  assert.deepEqual(droppedIds({ items: [{ listId: 'MED-00001' }], retired: [], heldBack: [{ listId: 'MED-00002' }, { listId: 'MED-00003' }] },
    ['MED-00001', 'MED-00002', 'MED-00003', 'MED-00009']), { heldBack: ['MED-00002', 'MED-00003'], notRetired: ['MED-00009'] })
  const many = { items: [], retired: [], heldBack: [{ listId: 'MED-00002' }, { listId: 'MED-00003' }], kind: 'medicine' }
  await assert.rejects(loadSeed(new StandInClient({ active: { version: '2026.1', ids: ['MED-00002', 'MED-00003'] } }),
    { seed: many, fileSha256: 'a'.repeat(64), approval, approvalsSha256: 'b'.repeat(64) }), (error) => error instanceof LoadRefusal
    && error.message === 'MED-00002, MED-00003 are in the live list but held back in this seed; fix the rows, do not retire them')
})

test('0149\'s own refusals in the transaction (55000, 23514) are refusals with the database\'s message; nothing loaded', async () => {
  assert.deepEqual(DATABASE_REFUSALS, ['55000', '23514'])
  const seed = build(FIXTURE, { version: '2026.2' }).medicine
  const approval = { approvalReference: 'Synthetic sign-off reference', approvedAt: '2026-12-02T09:00:00+01:00' }
  const cases = [
    ['insert into ehr.catalog_medicines', '55000', 'CATALOG_ID_CHANGED: MED-00001'],
    ['insert into ehr.catalog_medicines', '55000', 'CATALOG_ID_RETIRED: MED-00002'],
    ['insert into ehr.catalog_medicines', '55000', 'CATALOG_VERSION_SEALED: medicine 2026.2'],
    ['set active = true', '55000', 'ehr.catalog_versions: only active, loaded_at and sealed may change'],
    ['insert into ehr.catalog_medicines', '23514', 'new row for relation "catalog_medicines" violates check constraint "catalog_medicines_strength_check"'],
  ]
  for (const [sql, code, message] of cases) {
    const client = new StandInClient({ failOn: { sql, error: Object.assign(new Error(message), { code }) } })
    await assert.rejects(loadSeed(client, { seed, fileSha256: 'a'.repeat(64), approval, approvalsSha256: 'b'.repeat(64) }),
      (error) => error instanceof LoadRefusal && !error.busy
        && refusalLine(error) === `load-catalog: the database refused the load: ${message} (${code}); nothing loaded`, message)
    assert.equal(client.statements.at(-1).sql, 'rollback', message)
    assert.ok(!client.statements.some(({ sql: text }) => text === 'commit'), message)
  }
  // Anything else stays a failure (exit 1), not a refusal.
  const dropped = new StandInClient({ failOn: { sql: 'insert into ehr.catalog_medicines',
    error: Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }) } })
  await assert.rejects(loadSeed(dropped, { seed, fileSha256: 'a'.repeat(64), approval, approvalsSha256: 'b'.repeat(64) }),
    (error) => !(error instanceof LoadRefusal) && error.code === '57P01')
})

test('0150\'s refusals of a diagnosis row (55000, 23514) are refusals too, with the database\'s message; nothing loaded', async () => {
  const seed = { format: SEED_FORMAT, kind: 'diagnosis', version: '2026-01',
    attribution: ['Synthetic notice: ICD-11, World Health Organization, CC BY-ND 3.0 IGO.'], retired: [], items: [
      { code: '1F40', title: 'Malaria due to Plasmodium falciparum', otherNames: [], chapter: '01', residual: false }] }
  const approval = { approvalReference: 'Synthetic sign-off reference', approvedAt: '2026-12-01T09:00:00+01:00' }
  const cases = [
    ['55000', 'CATALOG_VERSION_SEALED: diagnosis 2026-01'],
    ['23514', 'new row for relation "catalog_diagnoses" violates check constraint "catalog_diagnoses_code_check"'],
    ['23514', 'new row for relation "catalog_diagnoses" violates check constraint "catalog_diagnoses_title_check"'],
  ]
  for (const [code, message] of cases) {
    const client = new StandInClient({ failOn: { sql: 'insert into ehr.catalog_diagnoses',
      error: Object.assign(new Error(message), { code }) } })
    await assert.rejects(loadSeed(client, { seed, fileSha256: 'a'.repeat(64), approval, approvalsSha256: 'b'.repeat(64) }),
      (error) => error instanceof LoadRefusal && !error.busy
        && refusalLine(error) === `load-catalog: the database refused the load: ${message} (${code}); nothing loaded`, message)
    assert.equal(client.statements.at(-1).sql, 'rollback', message)
    assert.ok(!client.statements.some(({ sql: text }) => text === 'commit'), message)
  }
})

test('a failure that is not a refusal ends with one plain line too (exit 1), never a stack trace', () => {
  const { folder, seedPath, approvalsPath } = signedFiles(build().medicine)
  try {
    // A signed file, and no database listening on port 9.
    const failed = runLoader(['--seed', seedPath, '--approvals', approvalsPath], { NODE_ENV: 'test' })
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /^load-catalog: .*\(ECONNREFUSED\); nothing loaded$/)
    assert.equal(failed.stderr.split('\n').length, 1)
    assert.equal(failed.stdout, '')
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('the loader refuses a seed that holds back and retires the same id (exit 2), before it connects or writes', async () => {
  const seed = JSON.parse(JSON.stringify(build(FIXTURE, { version: '2026.2' }).medicine))
  seed.retired.push({ listId: 'MED-00004', reason: 'Synthetic: retired instead of fixed' })
  const { folder, seedPath, approvalsPath } = signedFiles(seed)
  try {
    // DATABASE_URL points at port 9, where nothing listens: the refusal comes first.
    const refused = runLoader(['--seed', seedPath, '--approvals', approvalsPath], { NODE_ENV: 'test' })
    assert.equal(refused.stderr, `load-catalog: ${seedPath}: MED-00004 is held back in this seed and also listed as retired; `
      + 'fix the row, do not retire it; nothing loaded')
    assert.equal(refused.status, 2)
  } finally { rmSync(folder, { recursive: true, force: true }) }
  // loadSeed itself refuses it before its transaction: MED-00004, live in 2026.1, is not retired.
  const client = new StandInClient({ active: { version: '2026.1', ids: ['MED-00001', 'MED-00002', 'MED-00004', 'MED-00005'] } })
  await assert.rejects(loadSeed(client, { seed, fileSha256: 'a'.repeat(64), approval: { approvalReference: 'Synthetic sign-off '
    + 'reference', approvedAt: '2026-12-02T09:00:00+01:00' }, approvalsSha256: 'b'.repeat(64) }), (error) => error instanceof LoadRefusal
    && refusalLine(error) === 'load-catalog: MED-00004 is held back in this seed and also listed as retired; fix the row, do not '
      + 'retire it; nothing loaded')
  assert.deepEqual(client.statements, [], 'nothing sent, so nothing retired')
})

/**
 * A stand-in PostgreSQL server for a connection dropped mid-load (the real terminated backend is in the PR's
 * evidence). It lets the loader in (AuthenticationOk, ReadyForQuery), answers its first statement ("begin"), and on
 * the next one ends the connection: as pg_terminate_backend does (an ErrorResponse FATAL 57P01, then the socket
 * closes), or, with fatal false, as a failover does (the socket closes with no message). `statements` records what the
 * loader sent.
 */
async function droppingServer({ fatal }) {
  const message = (type, body) => {
    const header = Buffer.alloc(5)
    header.write(type)
    header.writeInt32BE(body.length + 4, 1)
    return Buffer.concat([header, body])
  }
  const statements = []
  const server = createServer((socket) => {
    let chunks = 0
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      chunks += 1
      if (chunks === 1) {
        socket.write(Buffer.concat([message('R', Buffer.from([0, 0, 0, 0])), message('Z', Buffer.from('I'))]))
        return
      }
      if (chunk[0] === 0x51) statements.push(chunk.subarray(5, chunk.length - 1).toString())
      if (chunks === 2) {
        socket.write(Buffer.concat([message('C', Buffer.from('BEGIN\0')), message('Z', Buffer.from('T'))]))
        return
      }
      if (fatal) {
        socket.end(message('E', Buffer.from('SFATAL\0VFATAL\0C57P01\0Mterminating connection due to administrator command\0\0')))
      } else {
        socket.destroy()
      }
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { port: server.address().port, statements, close: () => new Promise((done) => server.close(done)) }
}
function runLoaderAsync(args, environment) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [loaderScript, ...args], { env: { PATH: process.env.PATH, ...environment } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.on('close', (status) => done({ status, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

test('a connection dropped mid-load (a terminated backend, a failover) is one plain line (exit 1), never an unhandled error event', async () => {
  const { folder, seedPath, approvalsPath } = signedFiles(build().medicine)
  try {
    for (const [fatal, line] of [
      [true, 'load-catalog: terminating connection due to administrator command (57P01); nothing loaded'],
      [false, 'load-catalog: Connection terminated unexpectedly; nothing loaded']]) {
      const server = await droppingServer({ fatal })
      try {
        const result = await runLoaderAsync(['--seed', seedPath, '--approvals', approvalsPath], { NODE_ENV: 'test',
          DATABASE_URL: `postgresql://nobody@127.0.0.1:${server.port}/none` })
        assert.equal(result.stderr, line, `fatal ${fatal}`)
        assert.equal(result.status, 1)
        assert.equal(result.stdout, '')
        // Dropped inside the load's transaction, at its second statement.
        assert.deepEqual(server.statements, ['begin', "set local lock_timeout = '5s'"])
      } finally { await server.close() }
    }
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

// The loader's line when its COMMIT was sent and no reply came (round 4 of #319, point 1); the deploy tool matches it
// word for word (scripts/test_production_deployment_ecs.py).
const COMMIT_UNKNOWN = 'load-catalog: the connection was lost during commit, so the load may have committed; ask for the same '
  + 'load again to settle it (it loads, or is refused as already loaded)'

test('COMMIT sent and no reply (the connection lost, or a fatal error) leaves the outcome unknown, never "nothing loaded"', async () => {
  const seed = build(FIXTURE, { version: '2026.2' }).medicine
  const approval = { approvalReference: 'Synthetic sign-off reference', approvedAt: '2026-12-02T09:00:00+01:00' }
  const load = (client, options = {}) => loadSeed(client, { seed, fileSha256: 'a'.repeat(64), approval,
    approvalsSha256: 'b'.repeat(64), ...options })
  // No reply: the socket closed (pg's own words), or a FATAL in the reply's place (a terminated backend).
  for (const error of [new Error('Connection terminated unexpectedly'),
    Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity: 'FATAL' })]) {
    const client = new StandInClient({ failOn: { sql: 'commit', error } })
    let thrown
    await assert.rejects(load(client), (caught) => { thrown = caught; return true })
    assert.equal(thrown.name, 'CommitOutcomeUnknown', error.message)
    assert.equal(thrown.cause, error, 'the lost connection is kept as the cause')
    assert.ok(!(thrown instanceof LoadRefusal))
    assert.equal(client.statements.at(-1).sql, 'commit', 'no rollback is asked of a connection that is gone')
  }
  // An ERROR reply to COMMIT is a reply: the transaction rolled back, so it stays a failure, or a refusal, nothing loaded.
  const serialization = Object.assign(new Error('could not serialize access'), { code: '40001', severity: 'ERROR' })
  const failed = new StandInClient({ failOn: { sql: 'commit', error: serialization } })
  await assert.rejects(load(failed), (caught) => caught === serialization)
  assert.equal(failed.statements.at(-1).sql, 'rollback')
  const check = Object.assign(new Error('violates check constraint'), { code: '23514', severity: 'ERROR' })
  await assert.rejects(load(new StandInClient({ failOn: { sql: 'commit', error: check } })), (caught) => caught instanceof LoadRefusal
    && refusalLine(caught) === 'load-catalog: the database refused the load: violates check constraint (23514); nothing loaded')
  // A dry run sends no COMMIT: its rollback losing the connection leaves nothing.
  const lostRollback = new Error('Connection terminated unexpectedly')
  await assert.rejects(load(new StandInClient({ failOn: { sql: 'rollback', error: lostRollback } }), { dryRun: true }),
    (caught) => caught === lostRollback)
  // The connection lost before COMMIT is asked for (the client's 'error' event came first): pg refuses the query
  // without sending it, so nothing can have committed and it stays a failure. loadSeed takes its listeners off after.
  class LosingClient extends StandInClient {
    events = new EventEmitter()
    on(name, listener) { this.events.on(name, listener); return this }
    off(name, listener) { this.events.off(name, listener); return this }
    async query(sql, params) {
      if (this.gone) throw new Error('Client has encountered a connection error and is not queryable')
      const result = await super.query(sql, params)
      if (sql.includes('set active = true')) {
        this.gone = true
        this.events.emit('error', Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01',
          severity: 'FATAL' }))
        this.events.emit('end')
      }
      return result
    }
  }
  const losing = new LosingClient()
  losing.on('error', () => {})
  await assert.rejects(load(losing), (caught) => caught.name !== 'CommitOutcomeUnknown'
    && caught.message === 'Client has encountered a connection error and is not queryable')
  assert.ok(!losing.statements.some(({ sql }) => sql === 'commit'), 'COMMIT never sent')
  assert.equal(losing.events.listenerCount('error'), 1, 'only the caller\'s own listener is left')
  assert.equal(losing.events.listenerCount('end'), 0)
})

/**
 * A stand-in PostgreSQL server that answers the whole load (simple and extended protocol, from the statement's
 * text), then ends the connection: drop "commit-fatal" answers the loader's COMMIT with FATAL 57P01 and closes the
 * socket; "commit-silent" closes it with no message, as a backend terminated while its commit waits for a
 * synchronous standby does (on a real database in the PR's evidence; it has committed locally) and as a failover
 * does; "before-commit" sends FATAL 57P01 straight after the reply to the load's last statement, before the loader
 * can send COMMIT; "none" answers COMMIT too. `statements` records what the loader sent.
 */
async function loadingServer({ drop, items }) {
  const message = (type, body = Buffer.alloc(0)) => {
    const header = Buffer.alloc(5)
    header.write(type)
    header.writeInt32BE(body.length + 4, 1)
    return Buffer.concat([header, body])
  }
  const text = (value) => Buffer.from(`${value}\0`)
  const fatal = message('E', Buffer.from('SFATAL\0VFATAL\0C57P01\0Mterminating connection due to administrator command\0\0'))
  // RowDescription and DataRow for to_regclass's one boolean column, "ready", true.
  const ready = (() => {
    const field = Buffer.alloc(18)
    field.writeInt32BE(0, 0); field.writeInt16BE(0, 4); field.writeInt32BE(16, 6); field.writeInt16BE(1, 10)
    field.writeInt32BE(-1, 12); field.writeInt16BE(0, 16)
    const count = Buffer.alloc(2)
    count.writeInt16BE(1)
    const value = Buffer.alloc(6)
    value.writeInt16BE(1, 0); value.writeInt32BE(1, 2)
    return [message('T', Buffer.concat([count, text('ready'), field])), message('D', Buffer.concat([value, Buffer.from('t')]))]
  })()
  const tag = (sql) => {
    if (sql === 'begin') return 'BEGIN'
    if (sql === 'rollback') return 'ROLLBACK'
    if (sql.startsWith('set ')) return 'SET'
    if (sql.startsWith('lock ')) return 'LOCK TABLE'
    if (/insert into ehr\.catalog_(medicines|lab_tests)/.test(sql)) return `INSERT 0 ${items}`
    if (sql.includes('insert into ehr.catalog_versions')) return 'INSERT 0 1'
    if (sql.includes('insert into ehr.catalog_retired_codes')) return 'INSERT 0 0'
    if (sql.includes('set active = true')) return 'UPDATE 1'
    if (sql.includes('set active = false')) return 'UPDATE 0'
    if (sql.includes('to_regclass') || sql.includes('pg_advisory_xact_lock')) return 'SELECT 1'
    return 'SELECT 0'
  }
  const statements = []
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0)
    let started = false
    let parsed = ''
    socket.on('error', () => {})
    const answer = (sql, extended) => {
      statements.push(sql)
      if (sql === 'commit' && drop.startsWith('commit-')) {
        if (drop === 'commit-fatal') socket.end(fatal)
        else socket.destroy()
        return
      }
      const rows = sql.includes('to_regclass') ? ready : []
      const reply = Buffer.concat([...(extended ? [message('1'), message('2')] : []),
        ...(rows.length > 0 ? rows : extended ? [message('n')] : []), message('C', text(sql === 'commit' ? 'COMMIT' : tag(sql))),
        message('Z', Buffer.from(sql === 'commit' || sql === 'rollback' ? 'I' : 'T'))])
      if (drop === 'before-commit' && sql.includes('set active = true')) socket.end(Buffer.concat([reply, fatal]))
      else socket.write(reply)
    }
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (!started) {
          if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return
          buffer = buffer.subarray(buffer.readInt32BE(0))
          started = true
          socket.write(Buffer.concat([message('R', Buffer.alloc(4)), message('Z', Buffer.from('I'))]))
          continue
        }
        if (buffer.length < 5 || buffer.length < buffer.readInt32BE(1) + 1) return
        const type = String.fromCharCode(buffer[0])
        const body = buffer.subarray(5, buffer.readInt32BE(1) + 1)
        buffer = buffer.subarray(buffer.readInt32BE(1) + 1)
        if (type === 'Q') answer(body.subarray(0, body.length - 1).toString(), false)
        else if (type === 'P') parsed = body.subarray(body.indexOf(0) + 1, body.indexOf(0, body.indexOf(0) + 1)).toString()
        else if (type === 'S') answer(parsed, true)
        else if (type === 'X') socket.end()
      }
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { port: server.address().port, statements, close: () => new Promise((done) => server.close(done)) }
}

test('the loader cut off once its COMMIT is sent says the load may have committed (exit 1), not "nothing loaded"', async () => {
  const seed = build().medicine
  const { folder, seedPath, approvalsPath } = signedFiles(seed)
  try {
    for (const [drop, line] of [
      ['commit-fatal', COMMIT_UNKNOWN],
      ['commit-silent', COMMIT_UNKNOWN],
      // Lost before COMMIT could be sent: the load rolled back, so "nothing loaded" is true and stays.
      ['before-commit', 'load-catalog: terminating connection due to administrator command (57P01); nothing loaded']]) {
      const server = await loadingServer({ drop, items: seed.items.length })
      try {
        const result = await runLoaderAsync(['--seed', seedPath, '--approvals', approvalsPath], { NODE_ENV: 'test',
          DATABASE_URL: `postgresql://nobody@127.0.0.1:${server.port}/none` })
        assert.equal(result.stderr, line, drop)
        assert.equal(result.status, 1, drop)
        assert.equal(result.stdout, '', drop)
        assert.equal(server.statements[0], 'begin', drop)
        assert.ok(server.statements.some((sql) => sql.includes('set active = true')), `${drop}: the whole load was answered`)
        assert.equal(server.statements.includes('commit'), drop !== 'before-commit', drop)
      } finally { await server.close() }
    }
    // The same stand-in, never dropping, loads: the stand-in answers the load as a database would.
    const server = await loadingServer({ drop: 'none', items: seed.items.length })
    try {
      const result = await runLoaderAsync(['--seed', seedPath, '--approvals', approvalsPath], { NODE_ENV: 'test',
        DATABASE_URL: `postgresql://nobody@127.0.0.1:${server.port}/none` })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { status: 'loaded', kind: 'medicine', version: '2026.1',
        fileSha256: sha256(readFileSync(seedPath)), approvalsSha256: sha256(readFileSync(approvalsPath)), items: seed.items.length,
        newRetiredIds: [], replaced: null, heldBack: 1 })
      assert.equal(server.statements.at(-1), 'commit')
    } finally { await server.close() }
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('an error before the loader connects (a malformed DATABASE_HOST, a bad TLS setting) is one plain line (exit 1)', () => {
  const { folder, seedPath, approvalsPath } = signedFiles(build().medicine)
  const args = ['--seed', seedPath, '--approvals', approvalsPath]
  try {
    const managed = { NODE_ENV: 'test', DATABASE_URL: '', DATABASE_USERNAME: 'loader', DATABASE_PASSWORD: 'synthetic-placeholder' }
    const malformed = runLoader(args, { ...managed, DATABASE_HOST: 'db host' })
    assert.equal(malformed.stderr, 'load-catalog: DATABASE_HOST does not make a database address: Invalid URL (ERR_INVALID_URL); '
      + 'nothing loaded')
    assert.equal(malformed.status, 1)
    assert.equal(malformed.stdout, '')
    const tls = runLoader(args, { NODE_ENV: 'test', DATABASE_SSL: 'yes' })
    assert.equal(tls.stderr, 'load-catalog: DATABASE_SSL must be true or false; nothing loaded')
    assert.equal(tls.status, 1)
    // No address at all stays a refusal (exit 2).
    const none = runLoader(args, { NODE_ENV: 'test', DATABASE_URL: '' })
    assert.equal(none.stderr, 'load-catalog: set DATABASE_URL or DATABASE_HOST, DATABASE_USERNAME and DATABASE_PASSWORD; nothing loaded')
    assert.equal(none.status, 2)
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
