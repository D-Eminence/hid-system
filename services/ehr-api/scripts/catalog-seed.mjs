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
export const KINDS = ['medicine', 'lab_test'];
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

/**
 * The licence answers a sign-off records (Q124 A; Rahman's review of #319,
 * point 3), each a reference (8-500 characters) to where the owner's answer
 * is kept, never a personal name:
 * - nigeriaEml8: the owner's confirmation that the Nigeria Essential
 *   Medicines List, 8th edition ("All rights reserved"), may be used for its
 *   facts. Every medicine version needs it.
 * - whoccAtc: the WHOCC terms answer for ATC codes in a commercial product.
 *   A medicine version holding any ATC code needs it, and the seed builder
 *   writes ATC codes (--with-atc) only when the version's sign-off has it.
 */
export const LICENCES = {
  nigeriaEml8: 'the owner\'s confirmation that the Nigeria EML 8th edition may be used',
  whoccAtc: 'the WHOCC terms answer for ATC codes',
};

/** The notices the seeds carry, shown on the screens' About page (planned contract, "attribution"). */
export const LOINC_NOTICE = 'This material contains content from LOINC (http://loinc.org). LOINC is copyright Regenstrief '
  + 'Institute, Inc. and the Logical Observation Identifiers Names and Codes (LOINC) Committee and is available at no cost '
  + 'under the license at http://loinc.org/license. LOINC is a registered United States trademark of Regenstrief Institute, Inc.';
export const WHO_EML_NOTICE = 'WHO Model List of Essential Medicines, 24th list. Geneva: World Health Organization; 2025. '
  + 'Licence: CC BY-NC-SA 3.0 IGO.';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The seed builder reads ocr-worker's brand-names.ts with Node's own
 * TypeScript type stripping, which is on by default from Node 22.18 (and
 * from 23.6 on Node 23). Returns why `version` (process.versions.node) cannot
 * run the builder, or null.
 */
export function typeStrippingProblem(version) {
  const [major, minor] = String(version).split('.').map(Number);
  const enough = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
  return enough ? null : `the seed builder reads services/ocr-worker/src/reading/brand-names.ts with Node's own TypeScript `
    + `type stripping, which needs Node 22.18 or later; this is Node ${version}; nothing built`;
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

function medicineFromRow(row, withAtc) {
  return {
    listId: row.id,
    genericName: row.name.trim(),
    otherNames: words(row.other_names ?? ''),
    strength: optional(row.strength ?? ''),
    doseForm: row.dose_form.trim(),
    doseFormText: optional(row.dose_form_text ?? ''),
    routes: words(row.route ?? ''),
    // Null unless the build is asked for ATC codes (--with-atc), which needs the WHOCC answer recorded first.
    atcCode: withAtc && row.code_system === 'ATC' ? optional(row.code ?? '') : null,
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

/** A name compared as Ola's brand rule compares it: lower case, white space collapsed, trimmed. */
const sameName = (name) => name.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The review statuses of brand-names.ts (its reviewed_by column) whose rows
 * may go into a seed. Ola's clinical decision (#319, round 2): only confirmed
 * brands. The file has two statuses: 'coordinator-curated' (the brands
 * curated before the table, which the file keeps active) and
 * 'pending-pharmacist' (added from the NAFDAC Greenbook; a pharmacist's
 * review is pending). A pending row, or a row of any other status, is left
 * out and reported.
 */
export const CONFIRMED_BRAND_REVIEWS = Object.freeze(['coordinator-curated']);

/** Why a brand row may not go into a seed whatever its generic, or null. */
function brandRowProblem(row) {
  if (row.reviewedBy === 'pending-pharmacist') return 'pending pharmacist review';
  if (!CONFIRMED_BRAND_REVIEWS.includes(row.reviewedBy)) return `review status ${JSON.stringify(row.reviewedBy ?? null)} is not confirmed`;
  if (row.active !== true) return 'not an active row of brand-names.ts';
  return null;
}

/**
 * The brand names (ocr-worker's brand-names.ts) added to the other names of
 * the medicine they stand for, so they are signed with the file (planned
 * contract: "Brand names come with the loader"). Each row is { brand,
 * generic, reviewedBy (its reviewed_by), active (isActiveBrandRow) }.
 * Ola's clinical rules: only a confirmed row (CONFIRMED_BRAND_REVIEWS, and
 * active) is added (#319, round 2), and only where its generic, compared
 * case-insensitively with white space collapsed, is the generic name of
 * exactly one medicine in the seed (review of #319, point 6; a combination
 * counts only when written as the seed writes it, "amoxicillin + clavulanic
 * acid"); it then goes on every item (strength and form) of that medicine.
 * Nothing is guessed. Returns the items and the report the clinical lead
 * signs with: every brand added (brand, generic, items) and every brand left
 * out with why (pending pharmacist review, another status, no exact generic).
 */
export function addBrandNames(medicines, brands) {
  const byGeneric = new Map();
  for (const item of medicines) {
    const key = sameName(item.genericName);
    byGeneric.set(key, [...(byGeneric.get(key) ?? []), item]);
  }
  const toAdd = new Map();
  const added = [];
  const leftOut = [];
  for (const row of brands) {
    const { brand, generic } = row;
    const problem = brandRowProblem(row);
    if (problem) { leftOut.push({ brand, generic, why: problem }); continue; }
    const key = sameName(generic);
    const matching = byGeneric.get(key) ?? [];
    const names = new Set(matching.map((item) => item.genericName));
    if (names.size !== 1) {
      leftOut.push({ brand, generic, why: names.size === 0 ? 'no medicine in the seed has this generic name'
        : `${names.size} medicines in the seed have this generic name` });
      continue;
    }
    toAdd.set(key, [...(toAdd.get(key) ?? []), brand]);
    added.push({ brand, generic, items: matching.length });
  }
  const items = medicines.map((item) => {
    const extra = (toAdd.get(sameName(item.genericName)) ?? [])
      .filter((brand) => !item.otherNames.some((name) => sameName(name) === sameName(brand)));
    const unique = [...new Set(extra)].sort();
    return unique.length === 0 ? item : { ...item, otherNames: [...item.otherNames, ...unique] };
  });
  const branded = items.filter((item, index) => item !== medicines[index]).length;
  return { items, brands: { added, items: branded, leftOut } };
}

/**
 * The two seeds from the combined list's rows.
 * - `version` is the version label both seeds carry (for example 2026.1).
 * - `retired` maps each retired id to why ({"MED-01375": "..."}). An id gap
 *   that is not retired, or a retired id that is still a row, stops the build.
 * - `waveZero` is docs/codes/hid-lab-codes.json's codes: each one must be in
 *   the lab-test seed with its code and name unchanged (planned contract,
 *   "The 13 Wave 0 HID-LAB codes move in unchanged"); the seed reports how
 *   each one stands (kept, renamed, recoded, held back or missing), so the
 *   signer sees it.
 * - `withAtc` writes the list's ATC codes; without it every atcCode is null
 *   (the builder allows it only once the WHOCC answer is recorded).
 * - `brands` is brand-names.ts's rows ({ brand, generic, reviewedBy,
 *   active }); the confirmed ones become other names by addBrandNames's
 *   rule, and the report lists every brand added and every one left out.
 * A row that would not load is held back, with why, never cut or guessed.
 */
export function buildSeeds(rows, { version, retired = {}, waveZero = [], withAtc = false, brands = [] }) {
  if (!VERSION.test(version ?? '')) throw new Error(`the version ${version} is not a version label`);
  const unknown = rows.filter((row) => row.list !== 'medicine' && row.list !== 'lab-test');
  if (unknown.length > 0) throw new Error(`rows of an unknown list: ${unknown.map((row) => row.id).join(', ')}`);
  const ids = rows.map((row) => row.id);
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (repeated.length > 0) throw new Error(`ids used twice: ${[...new Set(repeated)].join(', ')}`);

  const medicines = rows.filter((row) => row.list === 'medicine').map((row) => medicineFromRow(row, withAtc));
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
  // Brands go on the items that load (a held-back medicine is not in the seed to be found).
  const branded = addBrandNames(medicineSplit.loaded, brands);

  // A row of the same name that is held back is reported "held back", not as recoded: it is not in the list.
  const heldBackIds = new Set(labSplit.heldBack.map((entry) => entry.listId));
  const waveZeroStatus = waveZero.map((entry) => {
    const same = labSplit.loaded.find((item) => item.codeSystem === 'HID-LAB' && item.code === entry.code);
    if (same) return { code: entry.code, status: same.display === entry.display ? 'kept' : 'renamed', listId: same.listId };
    const byName = labTests.find((item) => item.display.toLowerCase() === entry.display.toLowerCase());
    if (byName && heldBackIds.has(byName.listId)) return { code: entry.code, status: 'held back', listId: byName.listId };
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
    items: branded.items,
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
  return { medicine: medicineSeed, lab_test: labSeed, brands: branded.brands };
}

/** A seed file's bytes: stable JSON, two-space indent, one trailing newline, so its sha256 is reproducible. */
export function seedText(seed) {
  return `${JSON.stringify(seed, null, 2)}\n`;
}

/**
 * Why a parsed seed may not be loaded, or [] when it may: its format, kind,
 * version and notices, each item as 0149's rules, no id twice, no item that
 * is a retired id, no held-back row presented as an item, and (lab tests) no
 * code twice, and every HID-LAB code one of Wave 0's with its name
 * unchanged. `waveZero` is docs/codes/hid-lab-codes.json's codes; a lab-test
 * seed holding an HID-LAB code is refused without them.
 */
export function seedProblems(seed, { waveZero = null } = {}) {
  const problems = [];
  if (seed === null || typeof seed !== 'object') return ['the seed is not a JSON object'];
  if (seed.format !== SEED_FORMAT) problems.push(`the format is not ${SEED_FORMAT}`);
  if (!KINDS.includes(seed.kind)) problems.push('the kind is not medicine or lab_test');
  if (!VERSION.test(seed.version ?? '')) problems.push('the version is not a version label');
  if (!Array.isArray(seed.attribution) || seed.attribution.length > 5
      || seed.attribution.some((notice) => typeof notice !== 'string' || notice.trim() === '')) {
    problems.push('attribution must be at most 5 notices');
  }
  if (!Array.isArray(seed.retired) || seed.retired.some((entry) => typeof entry?.listId !== 'string'
      || typeof entry?.reason !== 'string' || entry.reason.trim().length < 8 || entry.reason.length > 500
      || !(seed.kind === 'medicine' ? MEDICINE_ID : LAB_TEST_ID).test(entry.listId))) {
    problems.push('each retired id needs an id of this kind and a reason of 8-500 characters');
  }
  if (!Array.isArray(seed.items) || seed.items.length === 0) {
    problems.push('the seed has no items');
    return problems;
  }
  const problemsOf = seed.kind === 'medicine' ? medicineProblems : labTestProblems;
  const ids = new Set();
  const codes = new Set();
  const retired = new Set((Array.isArray(seed.retired) ? seed.retired : []).map((entry) => entry?.listId));
  const heldBack = new Set((Array.isArray(seed.heldBack) ? seed.heldBack : []).map((entry) => entry?.listId));
  for (const item of seed.items) {
    for (const problem of problemsOf(item ?? {})) problems.push(`${item?.listId ?? '(no id)'}: ${problem}`);
    if (ids.has(item?.listId)) problems.push(`${item.listId}: the id is used twice`);
    ids.add(item?.listId);
    if (retired.has(item?.listId)) problems.push(`${item.listId}: a retired id is an item`);
    if (heldBack.has(item?.listId)) problems.push(`${item.listId}: a held-back row is an item`);
    if (seed.kind === 'lab_test') {
      const key = `${item?.codeSystem}|${item?.code}`;
      if (codes.has(key)) problems.push(`${item.listId}: the code ${item.code} is used twice`);
      codes.add(key);
      if (item?.codeSystem === 'HID-LAB') problems.push(...waveZeroProblems(item, waveZero));
    }
  }
  return problems;
}

/**
 * Wave 0's rule for an HID-LAB item (planned contract: "a code is never
 * changed or reused"; Rahman's review of #319, point 5): its code is one of
 * docs/codes/hid-lab-codes.json's, with that file's name exactly.
 */
function waveZeroProblems(item, waveZero) {
  if (!Array.isArray(waveZero)) return [`${item.listId}: the Wave 0 codes (docs/codes/hid-lab-codes.json) are needed to check an HID-LAB code`];
  const entry = waveZero.find((candidate) => candidate?.code === item.code);
  if (!entry) return [`${item.listId}: the HID-LAB code ${item.code} is not one of Wave 0's (docs/codes/hid-lab-codes.json)`];
  if (entry.display !== item.display) {
    return [`${item.listId}: the HID-LAB code ${item.code} is Wave 0's "${entry.display}", not "${item.display}" (a Wave 0 code is never changed or reused)`];
  }
  return [];
}

const reference = (value) => typeof value === 'string' && value.trim().length >= 8 && value.length <= 500;

/**
 * The sign-off a seed file needs (docs/codes/catalog-approvals.json): an
 * entry of this kind and version whose sha256 is the file's, and, for a
 * medicine version, the licence answers it needs (LICENCES): always the
 * Nigeria EML 8th edition confirmation, and the WHOCC answer when the file
 * holds an ATC code (`holdsAtc`). Returns it, or the reason there is none.
 */
export function approvalFor(approvals, { kind, version, fileSha256, holdsAtc = false }) {
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
  if (kind === 'medicine' && !reference(entry.licences?.nigeriaEml8)) {
    return { problem: `the sign-off for medicine ${version} does not record ${LICENCES.nigeriaEml8} (licences.nigeriaEml8)` };
  }
  if (kind === 'medicine' && holdsAtc && !reference(entry.licences?.whoccAtc)) {
    return { problem: `this file holds ATC codes, and the sign-off for medicine ${version} does not record ${LICENCES.whoccAtc} (licences.whoccAtc)` };
  }
  return { entry };
}

/**
 * Whether the seed builder may write ATC codes (--with-atc) for a medicine
 * version: only when a sign-off entry of that version records the WHOCC
 * answer. Returns the reason it may not, or null.
 */
export function withAtcProblem(approvals, version) {
  const entries = Array.isArray(approvals?.approvals) ? approvals.approvals : [];
  if (entries.some((entry) => entry?.kind === 'medicine' && entry.version === version && reference(entry.licences?.whoccAtc))) {
    return null;
  }
  return `--with-atc needs ${LICENCES.whoccAtc} recorded first (licences.whoccAtc on a medicine ${version} entry of `
    + 'docs/codes/catalog-approvals.json); until then build without it, so every atcCode is null';
}
