import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { BUSY, LoadRefusal, loadSeed, prepareLoad, refusalLine } from '../../services/ehr-api/scripts/catalog-load.mjs'
import {
  APPROVALS_FORMAT, LOINC_NOTICE, SEED_FORMAT, WHO_EML_NOTICE, addBrandNames, approvalFor, buildSeeds, parseCsv,
  seedProblems, seedText, sha256, withAtcProblem,
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

test('brand names: added only where the brand\'s generic is exactly one medicine\'s name; the rest are reported', () => {
  const item = (listId, genericName, otherNames = []) => ({ listId, genericName, otherNames })
  const medicines = [item('MED-00001', 'paracetamol'), item('MED-00002', 'paracetamol'),
    item('MED-00003', 'amoxicillin + clavulanic acid'), item('MED-00004', 'metronidazole', ['Flagyl']),
    item('MED-00005', 'chlorphenamine')]
  const { items, brands } = addBrandNames(medicines, [
    { brand: 'panadol', generic: 'paracetamol' }, { brand: 'augmentin', generic: 'Amoxicillin  +  Clavulanic acid' },
    { brand: 'clavulin', generic: 'amoxicillin + clavulanic acid' }, { brand: 'flagyl', generic: 'metronidazole' },
    { brand: 'piriton', generic: 'chlorpheniramine' }, { brand: 'ampiclox', generic: 'ampicillin + cloxacillin' },
    { brand: 'coamox', generic: 'amoxicillin and clavulanic acid' }])
  assert.deepEqual(items.map((entry) => entry.otherNames), [['panadol'], ['panadol'], ['augmentin', 'clavulin'], ['Flagyl'], []])
  assert.deepEqual(brands.notMapped.map((entry) => [entry.brand, entry.generic]), [['piriton', 'chlorpheniramine'],
    ['ampiclox', 'ampicillin + cloxacillin'], ['coamox', 'amoxicillin and clavulanic acid']], 'never guessed')
  assert.equal(brands.items, 3)
  // Two medicines whose names differ only in case or spacing: the brand is not guessed onto either.
  const twice = addBrandNames([item('MED-00001', 'paracetamol'), item('MED-00002', 'Paracetamol')],
    [{ brand: 'panadol', generic: 'paracetamol' }])
  assert.deepEqual(twice.items.map((entry) => entry.otherNames), [[], []])
  assert.match(twice.brands.notMapped[0].why, /2 medicines/)
  // Through the builder: on the items that load, signed with the file.
  const { medicine: seed, brands: report } = build(FIXTURE, { brands: [{ brand: 'panadol', generic: 'paracetamol' },
    { brand: 'epilim', generic: 'sodium valproate' }] })
  assert.deepEqual(seed.items.find((entry) => entry.listId === 'MED-00002').otherNames, ['panadol'])
  assert.deepEqual(report.notMapped, [{ brand: 'epilim', generic: 'sodium valproate', why: 'no medicine in the seed has this generic name' }])
})

test('brand-names.ts: its active rows are read as the builder reads them', async () => {
  const module = await import(pathToFileURL(resolve(repository, 'services/ocr-worker/src/reading/brand-names.ts')).href)
  const rows = module.BRAND_ROWS.filter(module.isActiveBrandRow)
  assert.ok(rows.length > 20)
  assert.ok(rows.every((row) => typeof row.brand === 'string' && typeof row.generic === 'string'))
  assert.equal(rows.find((row) => row.brand === 'augmentin').generic, 'amoxicillin + clavulanic acid')
  assert.equal(rows.find((row) => row.brand === 'panadol').generic, 'paracetamol')
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
  constructor({ active = null, busyOn = null, ready = true } = {}) {
    this.active = active; this.busyOn = busyOn; this.ready = ready; this.statements = []
  }
  async query(sql, params = []) {
    this.statements.push({ sql, params })
    if (this.busyOn && sql.includes(this.busyOn)) {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
    }
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
