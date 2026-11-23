// ORD-7, the medicine and lab-test lists' seed files (planned contract,
// "Who keeps the lists"): the combined list (docs/codes/drafts/
// hid-medicines-and-lab-tests.csv, #312) turned into the two seed files the
// governed loader takes, and the checks both make. Node only, no dependency:
// the seed builder (build-catalog-seeds.mjs), the loader (load-catalog.mjs)
// and scripts/tests/catalog-seeds.test.mjs all use this module, so a file the
// builder writes is a file the loader accepts.
//
// A seed is facts only (names, strengths, forms, routes, codes), never text
// copied from a source. Its rules are 0149's table rules, so a row the
// database would refuse is held back here, with why, rather than cut or
// guessed; the clinical lead signs the file with its held-back rows in view.
import { createHash } from 'node:crypto';

export const SEED_FORMAT = 'hid-catalog-seed/1';
export const APPROVALS_FORMAT = 'hid-catalog-approvals/1';
export const KINDS = ['medicine', 'lab_test', 'diagnosis'];
export const DOSE_FORMS = ['tablet', 'capsule', 'liquid', 'injection', 'cream', 'inhaler', 'drops', 'other'];
export const LAB_CATEGORIES = ['haematology', 'chemistry', 'microbiology', 'serology', 'parasitology', 'urine-and-stool',
  'hormones', 'molecular', 'blood-bank', 'immunology', 'histopathology', 'other'];
/** The combined list's own category words, and the category each loads as (#312's review on the PR). */
export const LIST_CATEGORIES = {
  haematology: 'haematology', chemistry: 'chemistry', microbiology: 'microbiology', serology: 'serology',
  parasitology: 'parasitology', 'urine and stool': 'urine-and-stool', endocrinology: 'hormones', molecular: 'molecular',
  'blood bank': 'blood-bank', immunology: 'immunology', 'histology and cytology': 'histopathology', other: 'other',
};
export const SOURCE_LISTS = ['main', 'restricted', 'specialist'];
export const MEDICINE_ID = /^MED-[0-9]{5}$/;
export const LAB_TEST_ID = /^LAB-[0-9]{4}$/;
export const VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$/;
export const ATC_CODE = /^[A-Z][0-9]{2}[A-Z]{2}[0-9]{2}$/;
export const SOURCE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ROUTE = /^[a-z][a-z -]{0,99}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
/** An ICD-11 MMS code (0150): a stem of four, then up to two parts after dots; never an extension code (X...). */
export const ICD11_CODE = /^(?!X)[0-9A-Z]{4}(\.[0-9A-Z]{1,2}){0,2}$/;
export const ICD11_CHAPTER = /^([0-9]{2}|[A-Z])$/;

/** The notices the seeds carry, shown on the screens' About page (planned contract, "attribution"). */
export const LOINC_NOTICE = 'This material contains content from LOINC (http://loinc.org). LOINC is copyright Regenstrief '
  + 'Institute, Inc. and the Logical Observation Identifiers Names and Codes (LOINC) Committee and is available at no cost '
  + 'under the license at http://loinc.org/license. LOINC is a registered United States trademark of Regenstrief Institute, Inc.';
export const WHO_EML_NOTICE = 'WHO Model List of Essential Medicines, 24th list. Geneva: World Health Organization; 2025. '
  + 'Licence: CC BY-NC-SA 3.0 IGO.';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. The first row names the columns. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field === '') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += character;
  }
  if (quoted) throw new Error('CSV: a quoted field is not closed');
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((cells) => !(cells.length === 1 && cells[0] === ''));
  if (!header) throw new Error('CSV: no header row');
  return body.map((cells, position) => {
    if (cells.length !== header.length) {
      throw new Error(`CSV row ${position + 2}: ${cells.length} fields where the header has ${header.length}`);
    }
    return Object.fromEntries(header.map((name, column) => [name, cells[column]]));
  });
}

const words = (text) => text.split(';').map((part) => part.trim()).filter((part) => part !== '');
const optional = (text) => (text.trim() === '' ? null : text.trim());

/** Why a medicine item would not load as 0149 makes the table, or [] when it would. */
export function medicineProblems(item) {
  const problems = [];
  if (!MEDICINE_ID.test(item.listId)) problems.push('the id is not MED-nnnnn');
  if (typeof item.genericName !== 'string' || item.genericName.trim().length < 1 || item.genericName.length > 200) {
    problems.push('the generic name must be 1-200 characters');
  }
  if (!Array.isArray(item.otherNames) || item.otherNames.some((name) => typeof name !== 'string' || name.trim() === ''
      || name.includes(';')) || item.otherNames.join('; ').length > 2000) {
    problems.push('other names must be non-empty words without ";", 2000 characters in all');
  }
  if (item.strength !== null && (typeof item.strength !== 'string' || item.strength.length < 1 || item.strength.length > 80)) {
    problems.push('the strength must be at most 80 characters (section 46)');
  }
  if (!DOSE_FORMS.includes(item.doseForm)) problems.push('the dose form is not one of section 46\'s');
  if (item.doseFormText !== null
      && (typeof item.doseFormText !== 'string' || item.doseFormText.length < 1 || item.doseFormText.length > 80)) {
    problems.push('the dose form words must be at most 80 characters');
  }
  if (!Array.isArray(item.routes) || item.routes.length > 5 || item.routes.some((route) => !ROUTE.test(route))) {
    problems.push('routes must be at most 5 plain lower-case words');
  }
  if (item.atcCode !== null && !ATC_CODE.test(item.atcCode)) problems.push('the ATC code is not well formed');
  if (item.commonAdultDose !== null && (typeof item.commonAdultDose !== 'string' || item.commonAdultDose.length < 1
      || item.commonAdultDose.length > 240)) problems.push('the common adult dose must be at most 240 characters');
  if (!SOURCE.test(item.source ?? '')) problems.push('the source is not a plain id');
  if (item.sourceSection !== null && (typeof item.sourceSection !== 'string' || item.sourceSection.length > 40)) {
    problems.push('the source section must be at most 40 characters');
  }
  if (item.sourceList !== null && !SOURCE_LISTS.includes(item.sourceList)) problems.push('the source list is unknown');
  if (typeof item.withdrawn !== 'boolean') problems.push('withdrawn must be true or false');
  return problems;
}

/** Why a lab-test item would not load as 0149 makes the table, or [] when it would. */
export function labTestProblems(item) {
  const problems = [];
  if (!LAB_TEST_ID.test(item.listId)) problems.push('the id is not LAB-nnnn');
  if (!['LOINC', 'HID-LAB'].includes(item.codeSystem) || typeof item.code !== 'string' || item.code.length < 1
      || item.code.length > 100) {
    problems.push('a test needs a LOINC or HID-LAB code to be ordered from the list (0004:243)');
  }
  if (typeof item.display !== 'string' || item.display.trim().length < 1 || item.display.length > 500) {
    problems.push('the name must be 1-500 characters');
  }
  if (!Array.isArray(item.otherNames) || item.otherNames.some((name) => typeof name !== 'string' || name.trim() === ''
      || name.includes(';')) || item.otherNames.join('; ').length > 2000) {
    problems.push('other names must be non-empty words without ";", 2000 characters in all');
  }
  if (item.specimen !== null && (typeof item.specimen !== 'string' || item.specimen.length < 1 || item.specimen.length > 100)) {
    problems.push('the specimen must be at most 100 characters');
  }
  if (!LAB_CATEGORIES.includes(item.category)) problems.push('the category is not one of the twelve');
  if (!SOURCE.test(item.source ?? '')) problems.push('the source is not a plain id');
  if (typeof item.withdrawn !== 'boolean') problems.push('withdrawn must be true or false');
  return problems;
}

/** Why an ICD-11 entry would not load as 0150 makes the table, or [] when it would. */
export function diagnosisProblems(item) {
  const problems = [];
  if (typeof item.code !== 'string' || !ICD11_CODE.test(item.code)) problems.push('the code is not an ICD-11 MMS code');
  if (typeof item.title !== 'string' || item.title.trim().length < 1 || item.title.length > 500) {
    problems.push('the title must be 1-500 characters');
  }
  if (!Array.isArray(item.otherNames) || item.otherNames.some((name) => typeof name !== 'string' || name.trim() === ''
      || name.includes(';')) || item.otherNames.join('; ').length > 2000) {
    problems.push('other names must be non-empty words without ";", 2000 characters in all');
  }
  if (typeof item.chapter !== 'string' || !ICD11_CHAPTER.test(item.chapter)) problems.push('the chapter is not 01-99 or a letter');
  if (typeof item.residual !== 'boolean') problems.push('residual must be true or false');
  return problems;
}

function medicineFromRow(row) {
  return {
    listId: row.id,
    genericName: row.name.trim(),
    otherNames: words(row.other_names ?? ''),
    strength: optional(row.strength ?? ''),
    doseForm: row.dose_form.trim(),
    doseFormText: optional(row.dose_form_text ?? ''),
    routes: words(row.route ?? ''),
    atcCode: row.code_system === 'ATC' ? optional(row.code ?? '') : null,
    commonAdultDose: null,
    source: row.source.trim(),
    sourceSection: optional(row.source_section ?? ''),
    sourceList: optional(row.source_list ?? ''),
    withdrawn: false,
  };
}

function labTestFromRow(row) {
  const category = LIST_CATEGORIES[row.category.trim()];
  return {
    listId: row.id,
    codeSystem: optional(row.code_system ?? ''),
    code: optional(row.code ?? ''),
    display: row.name.trim(),
    otherNames: words(row.other_names ?? ''),
    specimen: optional(row.specimen ?? ''),
    category: category ?? row.category.trim(),
    source: row.source.trim(),
    withdrawn: false,
  };
}

/** The ids 1..max of a kind that no row holds: each must be a retired id, and no retired id may be a row. */
function idGaps(items, prefix, width) {
  const numbers = new Set(items.map((item) => Number(item.listId.slice(prefix.length))));
  const highest = Math.max(0, ...numbers);
  const gaps = [];
  for (let number = 1; number <= highest; number += 1) {
    if (!numbers.has(number)) gaps.push(`${prefix}${String(number).padStart(width, '0')}`);
  }
  return gaps;
}

/**
 * The two seeds from the combined list's rows.
 * - `version` is the version label both seeds carry (for example 2026.1).
 * - `retired` maps each retired id to why ({"MED-01375": "..."}). An id gap
 *   that is not retired, or a retired id that is still a row, stops the build.
 * - `waveZero` is docs/codes/hid-lab-codes.json's codes: each one must be in
 *   the lab-test seed with its code and name unchanged (planned contract,
 *   "The 13 Wave 0 HID-LAB codes move in unchanged"); the seed reports how
 *   each one stands, so the signer sees it.
 * A row that would not load is held back, with why, never cut or guessed.
 */
export function buildSeeds(rows, { version, retired = {}, waveZero = [] }) {
  if (!VERSION.test(version ?? '')) throw new Error(`the version ${version} is not a version label`);
  const unknown = rows.filter((row) => row.list !== 'medicine' && row.list !== 'lab-test');
  if (unknown.length > 0) throw new Error(`rows of an unknown list: ${unknown.map((row) => row.id).join(', ')}`);
  const ids = rows.map((row) => row.id);
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (repeated.length > 0) throw new Error(`ids used twice: ${[...new Set(repeated)].join(', ')}`);

  const medicines = rows.filter((row) => row.list === 'medicine').map(medicineFromRow);
  const labTests = rows.filter((row) => row.list === 'lab-test').map(labTestFromRow);
  const retiredIds = Object.keys(retired);
  const stillRows = retiredIds.filter((id) => ids.includes(id));
  if (stillRows.length > 0) throw new Error(`retired ids that are still rows: ${stillRows.join(', ')}`);
  const gaps = [...idGaps(medicines, 'MED-', 5), ...idGaps(labTests, 'LAB-', 4)];
  const unexplained = gaps.filter((id) => !retiredIds.includes(id));
  if (unexplained.length > 0) throw new Error(`id gaps with no retirement reason: ${unexplained.join(', ')}`);
  for (const [id, reason] of Object.entries(retired)) {
    if (!(MEDICINE_ID.test(id) || LAB_TEST_ID.test(id)) || typeof reason !== 'string' || reason.trim().length < 8
        || reason.length > 500) throw new Error(`the retirement of ${id} needs an id and a reason of 8-500 characters`);
  }

  const split = (items, problemsOf) => {
    const loaded = [];
    const heldBack = [];
    for (const item of items) {
      const problems = problemsOf(item);
      if (problems.length === 0) loaded.push(item);
      else heldBack.push({ listId: item.listId, reasons: problems });
    }
    return { loaded, heldBack };
  };
  const medicineSplit = split(medicines, medicineProblems);
  const labSplit = split(labTests, labTestProblems);

  const waveZeroStatus = waveZero.map((entry) => {
    const same = labSplit.loaded.find((item) => item.codeSystem === 'HID-LAB' && item.code === entry.code);
    if (same) return { code: entry.code, status: same.display === entry.display ? 'kept' : 'renamed', listId: same.listId };
    const byName = labTests.find((item) => item.display.toLowerCase() === entry.display.toLowerCase());
    return byName
      ? { code: entry.code, status: 'recoded', listId: byName.listId, now: { codeSystem: byName.codeSystem, code: byName.code } }
      : { code: entry.code, status: 'missing' };
  });

  const retiredOf = (pattern) => Object.entries(retired).filter(([id]) => pattern.test(id))
    .map(([listId, reason]) => ({ listId, reason: reason.trim() })).sort((a, b) => a.listId.localeCompare(b.listId));
  const sources = (items) => [...new Set(items.map((item) => item.source))].sort();
  const medicineSeed = {
    format: SEED_FORMAT,
    kind: 'medicine',
    version,
    sources: sources(medicineSplit.loaded),
    attribution: medicineSplit.loaded.some((item) => item.source.startsWith('who-eml')) ? [WHO_EML_NOTICE] : [],
    retired: retiredOf(MEDICINE_ID),
    heldBack: medicineSplit.heldBack,
    items: medicineSplit.loaded,
  };
  const labSeed = {
    format: SEED_FORMAT,
    kind: 'lab_test',
    version,
    sources: sources(labSplit.loaded),
    attribution: labSplit.loaded.some((item) => item.codeSystem === 'LOINC') ? [LOINC_NOTICE] : [],
    retired: retiredOf(LAB_TEST_ID),
    heldBack: labSplit.heldBack,
    waveZero: waveZeroStatus,
    items: labSplit.loaded,
  };
  return { medicine: medicineSeed, lab_test: labSeed };
}

/**
 * A seed file's bytes: stable JSON, two-space indent, each item on one line
 * (so a list of 18,000 entries stays small and diffs line by line), one
 * trailing newline, so its sha256 is reproducible.
 */
export function seedText(seed) {
  const { items, ...rest } = seed;
  const head = JSON.stringify({ ...rest, items: [] }, null, 2);
  const lines = (items ?? []).map((item) => `    ${JSON.stringify(item)}`).join(',\n');
  return `${head.slice(0, head.lastIndexOf('[]'))}[\n${lines}\n  ]\n}\n`;
}

/**
 * Why a parsed seed may not be loaded, or [] when it may: its format, kind,
 * version and notices, each item as 0149's rules, no id twice, no item that
 * is a retired id, no held-back row presented as an item, and (lab tests) no
 * code twice.
 */
export function seedProblems(seed) {
  const problems = [];
  if (seed === null || typeof seed !== 'object') return ['the seed is not a JSON object'];
  if (seed.format !== SEED_FORMAT) problems.push(`the format is not ${SEED_FORMAT}`);
  if (!KINDS.includes(seed.kind)) problems.push('the kind is not medicine or lab_test');
  if (!VERSION.test(seed.version ?? '')) problems.push('the version is not a version label');
  if (!Array.isArray(seed.attribution) || seed.attribution.length > 5
      || seed.attribution.some((notice) => typeof notice !== 'string' || notice.trim() === '')) {
    problems.push('attribution must be at most 5 notices');
  }
  if (!Array.isArray(seed.retired) || (seed.kind === 'diagnosis' && seed.retired.length > 0)
      || seed.retired.some((entry) => typeof entry?.listId !== 'string'
      || typeof entry?.reason !== 'string' || entry.reason.trim().length < 8 || entry.reason.length > 500
      || !(seed.kind === 'medicine' ? MEDICINE_ID : LAB_TEST_ID).test(entry.listId))) {
    problems.push(seed.kind === 'diagnosis' ? 'a diagnosis list retires no id (WHO\'s codes are WHO\'s)'
      : 'each retired id needs an id of this kind and a reason of 8-500 characters');
  }
  if (!Array.isArray(seed.items) || seed.items.length === 0) {
    problems.push('the seed has no items');
    return problems;
  }
  const problemsOf = { medicine: medicineProblems, lab_test: labTestProblems, diagnosis: diagnosisProblems }[seed.kind]
    ?? (() => []);
  const idOf = (item) => (seed.kind === 'diagnosis' ? item?.code : item?.listId);
  const ids = new Set();
  const codes = new Set();
  const retired = new Set((Array.isArray(seed.retired) ? seed.retired : []).map((entry) => entry?.listId));
  const heldBack = new Set((Array.isArray(seed.heldBack) ? seed.heldBack : []).map((entry) => entry?.listId));
  for (const item of seed.items) {
    const id = idOf(item);
    for (const problem of problemsOf(item ?? {})) problems.push(`${id ?? '(no id)'}: ${problem}`);
    if (ids.has(id)) problems.push(`${id}: the id is used twice`);
    ids.add(id);
    if (retired.has(id)) problems.push(`${id}: a retired id is an item`);
    if (heldBack.has(id)) problems.push(`${id}: a held-back row is an item`);
    if (seed.kind === 'lab_test') {
      const key = `${item?.codeSystem}|${item?.code}`;
      if (codes.has(key)) problems.push(`${item.listId}: the code ${item.code} is used twice`);
      codes.add(key);
    }
  }
  return problems;
}

/**
 * The sign-off a seed file needs (docs/codes/catalog-approvals.json): an
 * entry of this kind and version whose sha256 is the file's. Returns it, or
 * the reason there is none.
 */
export function approvalFor(approvals, { kind, version, fileSha256 }) {
  if (approvals?.format !== APPROVALS_FORMAT || !Array.isArray(approvals.approvals)) {
    return { problem: `the approvals file is not ${APPROVALS_FORMAT}` };
  }
  const entry = approvals.approvals.find((candidate) => candidate?.sha256 === fileSha256);
  if (!entry) return { problem: `no sign-off names this file's sha256 ${fileSha256}` };
  if (entry.kind !== kind || entry.version !== version) {
    return { problem: `the sign-off for this sha256 is for ${entry.kind} ${entry.version}, not ${kind} ${version}` };
  }
  if (typeof entry.approvalReference !== 'string' || entry.approvalReference.trim().length < 8
      || entry.approvalReference.length > 500) return { problem: 'the sign-off has no approval reference (8-500 characters)' };
  if (Number.isNaN(Date.parse(entry.approvedAt ?? ''))) return { problem: 'the sign-off has no approval time' };
  return { entry };
}
