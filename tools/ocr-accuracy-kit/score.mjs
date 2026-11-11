#!/usr/bin/env node
// Scores a run's payloads against the answer keys and writes a JSON report and a plain-English summary.
//
//   node score.mjs --results results/real-1 [--keys keys] [--out-json FILE] [--out-md FILE] [--partial]
//
// Every document in the keys is scored; one with no result counts as missed. --partial scores only the
// documents the run has a record for (for trying a few documents; never for the launch decision).
// Exit code 0 when both launch thresholds pass on a full real run, 1 when either fails, 2 for a usage problem
// (including a results directory that mixes fake and real records), 3 when the thresholds are met but the
// result is not a launch result (a --partial run, or a --fake run).
// Reports name documents by id only: no document text is printed or written.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_KEYS_DIR, KitError, loadKeys, parseArgs } from './lib/kit.mjs';
import {
  FREQUENCY_TABLE, normDuration, normFrequency, normName, normStrength, normText, onPage, overlap, similarity, tokens,
} from './lib/normalise.mjs';

export const THRESHOLDS = { medicineAccuracyAfterChecking: 0.99, unsupportedShareBelow: 0.01 };
export const KINDS = ['medicine', 'diagnosis', 'allergy', 'lab_result', 'vital', 'note'];
const MATCH_AT = { medicine: 0.8, diagnosis: 0.8, allergy: 0.8, lab_result: 0.8, vital: 0.8, note: 0.5 };
/** Fields compared with the paper for "unsupported" (enums such as status or measure are choices, not text). */
const TEXT_FIELDS = {
  medicine: ['name', 'strength', 'form', 'route', 'frequency', 'duration'],
  diagnosis: ['name'],
  allergy: ['substance', 'reaction'],
  lab_result: ['test', 'value', 'unit', 'referenceRange', 'flag'],
  vital: ['value', 'unit'],
  note: ['text'],
};

const blank = (value) => value === null || value === undefined || String(value).trim() === '';

function keyBox(key, item) {
  const lines = key.text[item.page - 1]?.lines ?? [];
  const boxes = item.lines.map((n) => lines[n - 1]?.box).filter(Boolean);
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.left));
  const top = Math.min(...boxes.map((b) => b.top));
  const right = Math.max(...boxes.map((b) => b.left + b.width));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  return { left, top, width: right - left, height: bottom - top };
}

/** Intersection over the smaller box: 1 when one box lies inside the other. */
export function boxOverlap(a, b) {
  if (!a || !b) return 0;
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  if (width <= 0 || height <= 0) return 0;
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? (width * height) / smaller : 0;
}

/**
 * A mixture's measured dose ("Mist. Magnesium trisilicate 10 ml tds"): the key writes the 10 ml as its strength,
 * but it is the dose taken, and the reader has no dose field, so a reading that leaves the strength empty is
 * accepted too. Only for a mixture ("Mist") whose strength is a volume in ml.
 */
export function mixtureDose(expected) {
  const form = normText(expected.fields.form);
  const isMixture = form.startsWith('mist') || (!form && /^\W*mist\b/i.test(expected.asWritten ?? ''));
  return isMixture && /^\d+(?:\.\d+)?ml$/.test(normStrength(expected.fields.strength));
}

function strengthAgrees(produced, expected) {
  return normStrength(produced.fields.strength) === normStrength(expected.fields.strength)
    || (blank(produced.fields.strength) && mixtureDose(expected));
}

/** Medicine "exact": the same name, strength and how often, after normalisation (see README). */
export function medicineExact(produced, expected) {
  return normName(produced.fields.name) === normName(expected.fields.name)
    && normName(expected.fields.name) !== ''
    && strengthAgrees(produced, expected)
    && normFrequency(produced.fields.frequency) === normFrequency(expected.fields.frequency);
}

/** Spellings of "inhaled" a reader may give as the route of an inhaler whose route is not written. */
const INHALED_ROUTES = new Set(['inhaled', 'inhalation', 'by inhalation', 'inh', 'inhal']);
const INHALER_FORMS = ['Inh', 'Inhaler'];
/** The key medicine is an inhaler with no route written: route "inhaled" is a reading of its form, not an addition. */
function inhalerWithoutRoute(expected) {
  if (!blank(expected.fields.route)) return false;
  return /^inh/.test(normText(expected.fields.form)) || /(?:^|\s)inh(?:aler)?\b/i.test(expected.asWritten ?? '');
}
const routeAgrees = (produced, expected) => sameOptional(produced.fields.route, expected.fields.route)
  || (INHALED_ROUTES.has(normText(produced.fields.route)) && inhalerWithoutRoute(expected));

/**
 * Whether a medicine's status says the same thing as the key's: taking it (new or current), not taking it
 * (stopped or past), or unknown. A stopped medicine read as current is wrong even when the name, strength
 * and frequency are exact.
 */
const STATUS_GROUP = { new: 'taking', current: 'taking', stopped: 'not_taking', past: 'not_taking' };
export function medicineStatusAgrees(produced, expected) {
  const group = (status) => STATUS_GROUP[status] ?? 'unknown';
  return group(produced.fields.status) === group(expected.fields.status);
}

/** How alike a produced item is to a key item of the same kind (0-1). */
export function pairScore(produced, expected) {
  const p = produced.fields;
  const k = expected.fields;
  switch (expected.kind) {
    case 'medicine': {
      const name = normName(p.name);
      const want = normName(k.name);
      if (!name) return normName(produced.asWritten).includes(want) ? 0.85 : 0;
      return similarity(name, want);
    }
    case 'diagnosis': {
      const name = normText(p.name);
      const want = normText(k.name);
      if (name && want && (name.includes(want) || want.includes(name))) return Math.max(0.85, similarity(name, want));
      return similarity(name, want);
    }
    case 'allergy':
      if (Boolean(p.noKnownAllergies) !== Boolean(k.noKnownAllergies)) return 0;
      return k.noKnownAllergies ? 1 : similarity(normText(p.substance), normText(k.substance));
    case 'lab_result':
      if (sameTestCore(p.test, k.test)) return 1;
      return Math.max(similarity(normText(p.test), normText(k.test)), overlap(p.test, k.test));
    case 'vital':
      if (p.measure !== k.measure) return 0;
      return 0.8 + (compactValue(p.value) === compactValue(k.value) ? 0.2 : 0);
    case 'note':
      return Math.max(overlap(p.text ?? produced.asWritten, k.text), overlap(produced.asWritten, expected.asWritten));
    default:
      return 0;
  }
}

const compactValue = (value) => normText(value).replace(/\s+/g, '');
/**
 * A lab test's name without a known method in brackets at its end: "MP (thick film)" and "MP" are the same test.
 * Only these method words; any other bracket ("FBS (random)") names a different test. The generator writes none.
 */
const TEST_METHODS = ['thick film', 'thin film', 'smear', 'thick smear', 'thin smear', 'hrp2', 'hrp-2'];
const testCore = (value) => normText(String(value ?? '').replace(/\s*\(([^()]*)\)\s*$/,
  (bracket, inside) => (TEST_METHODS.includes(normText(inside)) ? '' : bracket)));
const sameTestCore = (a, b) => testCore(a) !== '' && testCore(a) === testCore(b);
const sameOptional = (a, b, normalise = normText) => normalise(a ?? '') === normalise(b ?? '');

/** Whether every field the key gives was read the same (normalised). */
export function fieldsCorrect(produced, expected) {
  const p = produced.fields;
  const k = expected.fields;
  switch (expected.kind) {
    case 'medicine':
      return medicineExact(produced, expected) && sameOptional(p.duration, k.duration, normDuration)
        && routeAgrees(produced, expected) && p.status === k.status;
    case 'diagnosis':
      return similarity(normText(p.name), normText(k.name)) >= 0.9 && p.status === k.status;
    case 'allergy':
      return Boolean(p.noKnownAllergies) === Boolean(k.noKnownAllergies)
        && (k.noKnownAllergies || sameOptional(p.substance, k.substance)) && (p.severity ?? null) === (k.severity ?? null);
    case 'lab_result':
      return (similarity(normText(p.test), normText(k.test)) >= 0.9 || sameTestCore(p.test, k.test))
        && compactValue(p.value) === compactValue(k.value)
        && sameOptional(p.unit, k.unit, compactValue) && sameOptional(p.flag, k.flag);
    case 'vital':
      return p.measure === k.measure && compactValue(p.value) === compactValue(k.value)
        && sameOptional(p.unit, k.unit, compactValue);
    case 'note':
      return overlap(p.text ?? produced.asWritten, k.text) >= 0.5;
    default:
      return false;
  }
}

/** Greedy one-to-one pairing, best score first; ties go to reading order. */
function pairUp(candidates) {
  candidates.sort((a, b) => b.score - a.score || a.k - b.k || a.p - b.p);
  const usedP = new Set();
  const usedK = new Set();
  const pairs = [];
  for (const candidate of candidates) {
    if (usedP.has(candidate.p) || usedK.has(candidate.k)) continue;
    usedP.add(candidate.p);
    usedK.add(candidate.k);
    pairs.push(candidate);
  }
  return pairs;
}

/** The values an item states about the paper: asWritten, its text fields, its dates and prescriber. */
function statedValues(item) {
  const values = [['asWritten', item.asWritten]];
  for (const name of TEXT_FIELDS[item.kind] ?? []) {
    if (!blank(item.fields?.[name])) values.push([name, item.fields[name]]);
  }
  if (!blank(item.dateAsWritten)) values.push(['dateAsWritten', item.dateAsWritten]);
  if (item.prescription) {
    if (!blank(item.prescription.prescriberAsWritten)) values.push(['prescriber', item.prescription.prescriberAsWritten]);
    if (!blank(item.prescription.dateAsWritten)) values.push(['prescriptionDate', item.prescription.dateAsWritten]);
  }
  return values;
}

/** Frequency spellings that are also everyday words ("seen on 3 Nov"): found only right after the medicine. */
const EVERYDAY_WORD_SPELLINGS = new Set(['on', 'now']);

/**
 * Whether a stated value is on the paper. How often counts as on the paper when any spelling of the same code
 * is ("daily" for a written "od"): that is a reading of the paper, not something added to it. A spelling that
 * is also an everyday word ("on" for nocte) counts only on the same line as, and after, the medicine's name.
 */
export function supported(name, value, lines, medicineName = '') {
  // Route "inhaled" for an inhaler: the line shows the inhaler form word right before the medicine's name.
  if (name === 'route' && INHALED_ROUTES.has(normText(value)) && tokens(medicineName).length > 0
    && INHALER_FORMS.some((form) => onPage(`${form} ${medicineName}`, lines, 1))) return true;
  if (name !== 'frequency') return onPage(value, lines);
  const spellings = [value, ...(FREQUENCY_TABLE[normFrequency(value)] ?? [])];
  return spellings.some((spelling) => {
    if (!EVERYDAY_WORD_SPELLINGS.has(normText(spelling).replace(/\./g, ''))) return onPage(spelling, lines);
    return tokens(medicineName).length > 0 && onPage(`${medicineName} ${spelling}`, lines, 1);
  });
}

function sameName(a, b) {
  const sorted = (value) => tokens(value).sort().join(' ');
  return sorted(a) !== '' && sorted(a) === sorted(b);
}

function emptyKindCounts() {
  return Object.fromEntries(KINDS.map((kind) => [kind,
    { expected: 0, produced: 0, matched: 0, fieldsCorrect: 0, producedMatched: 0 }]));
}

// ----- Dates (the contract's item dateAsWritten; a prescription's date counts as the item's date too) -----

/** {year, month, day} of a date written d/m/y (/, - or .; 2- or 4-digit year) or y-m-d, else null. */
export function parseDate(value) {
  const text = normText(value);
  let match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text);
  if (match) {
    const year = Number(match[3]);
    return { day: Number(match[1]), month: Number(match[2]), year: year < 100 ? 2000 + year : year };
  }
  match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
}
const itemDate = (item) => (blank(item.dateAsWritten) ? (blank(item.prescription?.dateAsWritten) ? null
  : item.prescription.dateAsWritten) : item.dateAsWritten);
const sameDay = (a, b) => a !== null && b !== null && a.year === b.year && a.month === b.month && a.day === b.day;

/**
 * How a read date compares with the key's: 'same' (as written), 'same_date_other_spelling', 'day_month_swapped',
 * 'other_date_on_page' (a date the page gives for other items, such as the admitted date for a discharge medicine),
 * 'wrong', 'missing' (the key has one, the reading none), 'extra' (the reading has one, the key none), or null when
 * neither has a date.
 */
export function compareDate(producedDate, keyDate, pageDates = []) {
  if (blank(keyDate) && blank(producedDate)) return null;
  if (blank(producedDate)) return 'missing';
  if (blank(keyDate)) return 'extra';
  if (compactValue(producedDate) === compactValue(keyDate)) return 'same';
  const got = parseDate(producedDate);
  const want = parseDate(keyDate);
  if (sameDay(got, want)) return 'same_date_other_spelling';
  if (got && want && want.day !== want.month && sameDay(got, { ...want, day: want.month, month: want.day })) {
    return 'day_month_swapped';
  }
  if (pageDates.some((date) => compactValue(date) === compactValue(producedDate) || sameDay(got, parseDate(date)))) {
    return 'other_date_on_page';
  }
  return 'wrong';
}
export const DATE_OUTCOMES = ['same', 'same_date_other_spelling', 'day_month_swapped', 'other_date_on_page', 'wrong',
  'missing', 'given_as_note', 'extra'];

/** A note that only gives a date ("Date: 03/04/2026"), as its compact text, else null. */
function dateOnlyNote(item) {
  const text = normText(item.fields?.text ?? item.asWritten).replace(/^(?:date|dated)\s*:?\s*/, '');
  return parseDate(text) ? compactValue(text) : null;
}

/** IV fluids written as treatment ("IV fluids 0.9% saline 1L 8hrly"): a note in the key. */
const IV_FLUIDS = /\b(?:iv ?fluids?|ivf|saline|dextrose|ringer'?s?|hartmann'?s?)\b/i;

/** Scores one document. payload is null when the run produced none for it. */
export function scoreDocument(key, payload) {
  const expected = key.items;
  const produced = payload?.items ?? [];
  const status = payload === null ? 'missing' : payload.reading?.status ?? 'unknown';
  const kinds = emptyKindCounts();
  for (const item of expected) kinds[item.kind].expected += 1;
  for (const item of produced) if (kinds[item.kind]) kinds[item.kind].produced += 1;

  // 1. Medicines read exactly (name + strength + how often) are paired first.
  const exactPairs = pairUp(produced.flatMap((p, pi) => expected.flatMap((k, ki) =>
    p.kind === 'medicine' && k.kind === 'medicine' && p.page === k.page && medicineExact(p, k)
      ? [{ p: pi, k: ki, score: medicineStatusAgrees(p, k) ? 1 : 0.9 }] : [])));
  const pairedP = new Set(exactPairs.map((pair) => pair.p));
  const pairedK = new Set(exactPairs.map((pair) => pair.k));
  // 2. Everything else is paired by kind, page and how alike the item is, or (for a misread medicine) by
  //    being read from the same place on the page. A produced medicine whose name matches another key
  //    medicine on the page is a reading of that one (for example a duplicate), never of a skipped neighbour.
  const rest = [];
  produced.forEach((p, pi) => {
    if (pairedP.has(pi)) return;
    const namesAnother = (ki) => expected.some((other, oi) => oi !== ki && other.kind === 'medicine'
      && other.page === p.page && pairScore(p, other) >= MATCH_AT.medicine);
    expected.forEach((k, ki) => {
      if (pairedK.has(ki) || p.kind !== k.kind || p.page !== k.page) return;
      const score = pairScore(p, k);
      if (score >= MATCH_AT[k.kind]) rest.push({ p: pi, k: ki, score });
      else if (k.kind === 'medicine' && boxOverlap(p.box, keyBox(key, k)) >= 0.5 && !namesAnother(ki)) {
        rest.push({ p: pi, k: ki, score: 0.5 });
      }
    });
  });
  const pairs = [...exactPairs.map((pair) => ({ ...pair, exact: true })), ...pairUp(rest).map((pair) => ({ ...pair, exact: false }))];

  // 3. Accepted other readings (README "Other readings accepted"). IV fluids written as treatment are a note in
  //    the key; a reading of them as a past or stopped medicine is accepted, never as a medicine being taken.
  const alternatives = { ivFluidsAsPastMedicine: 0, prescriptionDateAsNote: 0 };
  const isPaired = (side, index) => pairs.some((pair) => pair[side] === index);
  expected.forEach((k, ki) => {
    if (k.kind !== 'note' || isPaired('k', ki) || !IV_FLUIDS.test(k.fields.text ?? k.asWritten)) return;
    const pi = produced.findIndex((p, index) => !isPaired('p', index) && p.kind === 'medicine' && p.page === k.page
      && ['past', 'stopped'].includes(p.fields?.status) && (overlap(p.asWritten, k.asWritten) >= 0.5
        || (tokens(p.fields?.name).length > 0 && onPage(p.fields.name, [k.asWritten]))));
    if (pi < 0) return;
    pairs.push({ p: pi, k: ki, score: 1, exact: false, alternative: true });
    alternatives.ivFluidsAsPastMedicine += 1;
  });
  //    A prescription's date read as a note of its own is accepted (the key gives the date on the medicines).
  const acceptedP = new Set();
  const notedDates = new Set();
  produced.forEach((p, pi) => {
    if (p.kind !== 'note' || isPaired('p', pi)) return;
    const date = dateOnlyNote(p);
    const prescribed = expected.some((k) => k.kind === 'medicine' && k.page === p.page
      && !blank(k.prescription?.dateAsWritten) && compactValue(k.prescription.dateAsWritten) === date);
    if (date === null || !prescribed) return;
    acceptedP.add(pi);
    notedDates.add(`${p.page}|${date}`);
    alternatives.prescriptionDateAsNote += 1;
  });

  const medicines = { expected: 0, exact: 0, caughtByCheck: 0, missedAfterChecking: 0, statusDisagreements: 0,
    traps: {}, missedIds: [], caughtIds: [] };
  const byK = new Map(pairs.map((pair) => [pair.k, pair]));
  expected.forEach((k, ki) => {
    const pair = byK.get(ki);
    if (pair) {
      kinds[k.kind].matched += 1;
      if (pair.alternative || fieldsCorrect(produced[pair.p], k)) kinds[k.kind].fieldsCorrect += 1;
    }
    if (k.kind !== 'medicine') return;
    medicines.expected += 1;
    let credited = false;
    const statusAgrees = Boolean(pair?.exact) && medicineStatusAgrees(produced[pair.p], k);
    if (pair?.exact && !statusAgrees) medicines.statusDisagreements += 1;
    if (statusAgrees) {
      medicines.exact += 1;
      credited = true;
    } else if (pair && produced[pair.p].confidence === 'check_carefully') {
      medicines.caughtByCheck += 1;
      medicines.caughtIds.push(k.id);
      credited = true;
    } else {
      medicines.missedAfterChecking += 1;
      medicines.missedIds.push(k.id);
    }
    if (k.trap) {
      const trap = k.trap.split(':')[0];
      const counts = (medicines.traps[trap] ??= { expected: 0, credited: 0, exact: 0 });
      counts.expected += 1;
      if (credited) counts.credited += 1;
      if (statusAgrees) counts.exact += 1;
    }
  });

  // Unsupported: a produced item whose words are not on the paper (the key's own page text).
  const unsupported = { produced: produced.length, unsupported: 0, unsupportedVsOcr: 0, byValue: {}, ids: [] };
  for (const item of produced) {
    const paper = key.text[item.page - 1]?.lines.map((line) => line.text) ?? [];
    const ocr = payload?.pages?.find((page) => page.page === item.page)?.lines.map((line) => line.text) ?? [];
    const medicineName = item.kind === 'medicine' ? item.fields?.name ?? '' : '';
    const missing = statedValues(item).filter(([name, value]) => !supported(name, value, paper, medicineName))
      .map(([name]) => name);
    if (missing.length > 0) {
      unsupported.unsupported += 1;
      unsupported.ids.push(item.id);
      for (const name of missing) unsupported.byValue[name] = (unsupported.byValue[name] ?? 0) + 1;
    }
    if (statedValues(item).some(([name, value]) => !supported(name, value, ocr, medicineName))) unsupported.unsupportedVsOcr += 1;
  }

  const want = key.identity;
  const got = payload?.identity ?? {};
  const identity = want ? {
    name: sameName(got.nameAsWritten, want.nameAsWritten),
    dateOfBirth: compactValue(got.dateOfBirthAsWritten) !== '' && compactValue(got.dateOfBirthAsWritten) === compactValue(want.dateOfBirthAsWritten),
    folderNumber: compactValue(got.folderNumberAsWritten) !== '' && compactValue(got.folderNumberAsWritten) === compactValue(want.folderNumberAsWritten),
    sex: normText(got.sexAsWritten).slice(0, 1) !== '' && normText(got.sexAsWritten).slice(0, 1) === normText(want.sexAsWritten).slice(0, 1),
  } : null;

  // Dates: each paired item's date against the key's. Reported on its own; not part of the two launch measures.
  const dates = { ...Object.fromEntries(DATE_OUTCOMES.map((outcome) => [outcome, 0])), swappedIds: [], wrongIds: [] };
  for (const pair of pairs) {
    const k = expected[pair.k];
    const keyDate = itemDate(k);
    const pageDates = [...new Set(expected.filter((other) => other.page === k.page).map(itemDate).filter(Boolean))];
    let outcome = compareDate(itemDate(produced[pair.p]), keyDate, pageDates);
    if (outcome === 'missing' && notedDates.has(`${k.page}|${compactValue(keyDate)}`)) outcome = 'given_as_note';
    if (outcome === null) continue;
    dates[outcome] += 1;
    if (outcome === 'day_month_swapped') dates.swappedIds.push(k.id);
    if (outcome === 'wrong') dates.wrongIds.push(k.id);
  }

  produced.forEach((p, pi) => {
    if (kinds[p.kind] && (isPaired('p', pi) || acceptedP.has(pi))) kinds[p.kind].producedMatched += 1;
  });
  const otherMissed = expected.filter((k, ki) => k.kind !== 'medicine' && !byK.has(ki)).length;
  const extra = produced.filter((_, pi) => !isPaired('p', pi) && !acceptedP.has(pi)).length;
  return { docId: key.docId, documentKind: key.documentKind, difficulty: key.difficulty, pages: key.pages,
    traps: key.traps, status, kinds, medicines, unsupported, identity, dates, alternatives, otherMissed,
    extraItems: extra };
}

const share = (part, whole) => (whole === 0 ? null : part / whole);

export function scoreRun(keys, payloads) {
  const documents = keys.map((key) => scoreDocument(key, payloads.get(key.docId) ?? null));
  const kinds = emptyKindCounts();
  const med = { expected: 0, exact: 0, caughtByCheck: 0, missedAfterChecking: 0, statusDisagreements: 0 };
  const traps = {};
  const unsupported = { produced: 0, unsupported: 0, unsupportedVsOcr: 0, byValue: {} };
  const identity = { documents: 0, name: 0, dateOfBirth: 0, folderNumber: 0, sex: 0 };
  const dates = { ...Object.fromEntries(DATE_OUTCOMES.map((outcome) => [outcome, 0])), swappedIds: [], wrongIds: [] };
  const alternatives = { ivFluidsAsPastMedicine: 0, prescriptionDateAsNote: 0 };
  const byDifficulty = {};
  const byDocumentKind = {};
  for (const doc of documents) {
    for (const kind of KINDS) for (const field of Object.keys(kinds[kind])) kinds[kind][field] += doc.kinds[kind][field];
    for (const field of Object.keys(med)) med[field] += doc.medicines[field];
    for (const [trap, counts] of Object.entries(doc.medicines.traps)) {
      const total = (traps[trap] ??= { expected: 0, credited: 0, exact: 0 });
      total.expected += counts.expected; total.credited += counts.credited; total.exact += counts.exact;
    }
    for (const outcome of DATE_OUTCOMES) dates[outcome] += doc.dates[outcome];
    dates.swappedIds.push(...doc.dates.swappedIds);
    dates.wrongIds.push(...doc.dates.wrongIds);
    for (const name of Object.keys(alternatives)) alternatives[name] += doc.alternatives[name];
    unsupported.produced += doc.unsupported.produced;
    unsupported.unsupported += doc.unsupported.unsupported;
    unsupported.unsupportedVsOcr += doc.unsupported.unsupportedVsOcr;
    for (const [name, count] of Object.entries(doc.unsupported.byValue)) unsupported.byValue[name] = (unsupported.byValue[name] ?? 0) + count;
    if (doc.identity) {
      identity.documents += 1;
      for (const field of ['name', 'dateOfBirth', 'folderNumber', 'sex']) if (doc.identity[field]) identity[field] += 1;
    }
    for (const [group, value] of [[byDifficulty, doc.difficulty], [byDocumentKind, doc.documentKind]]) {
      const g = (group[value] ??= { documents: 0, medicines: 0, credited: 0, exact: 0, produced: 0, unsupported: 0 });
      g.documents += 1;
      g.medicines += doc.medicines.expected;
      g.credited += doc.medicines.exact + doc.medicines.caughtByCheck;
      g.exact += doc.medicines.exact;
      g.produced += doc.unsupported.produced;
      g.unsupported += doc.unsupported.unsupported;
    }
  }
  const afterChecking = share(med.exact + med.caughtByCheck, med.expected) ?? 0;
  const strict = share(med.exact, med.expected) ?? 0;
  const unsupportedShare = share(unsupported.unsupported, unsupported.produced) ?? 0;
  const passMedicine = med.expected > 0 && afterChecking >= THRESHOLDS.medicineAccuracyAfterChecking;
  const passUnsupported = unsupported.produced > 0 && unsupportedShare < THRESHOLDS.unsupportedShareBelow;
  const perKind = Object.fromEntries(KINDS.map((kind) => {
    const k = kinds[kind];
    return [kind, { ...k, precision: share(k.producedMatched, k.produced), recall: share(k.matched, k.expected),
      fieldsCorrectShare: share(k.fieldsCorrect, k.matched) }];
  }));
  const problem = (doc) => doc.medicines.missedAfterChecking * 1000 + doc.unsupported.unsupported * 100
    + (doc.medicines.expected - doc.medicines.exact) * 10 + doc.otherMissed + (doc.status === 'read' ? 0 : 10_000);
  const worst = documents.filter((doc) => problem(doc) > 0).sort((a, b) => problem(b) - problem(a)
    || a.docId.localeCompare(b.docId)).slice(0, 20).map((doc) => ({ docId: doc.docId, documentKind: doc.documentKind,
    difficulty: doc.difficulty, pages: doc.pages, status: doc.status,
    medicinesMissedAfterChecking: doc.medicines.missedAfterChecking, medicinesCaughtByCheck: doc.medicines.caughtByCheck,
    medicinesNotExact: doc.medicines.expected - doc.medicines.exact, unsupportedItems: doc.unsupported.unsupported,
    otherItemsMissed: doc.otherMissed, missedMedicineIds: doc.medicines.missedIds, unsupportedItemIds: doc.unsupported.ids }));
  return {
    contract: 'hid-ocr-accuracy-report-1',
    thresholds: THRESHOLDS,
    pass: passMedicine && passUnsupported,
    launchMetrics: {
      medicineAccuracyAfterChecking: { value: afterChecking, pass: passMedicine, exact: med.exact,
        caughtByCheck: med.caughtByCheck, missed: med.missedAfterChecking, expected: med.expected },
      medicineAccuracyStrict: { value: strict, exact: med.exact, expected: med.expected },
      unsupportedItems: { value: unsupportedShare, pass: passUnsupported, unsupported: unsupported.unsupported,
        produced: unsupported.produced, byValue: unsupported.byValue,
        unsupportedVsOcrText: unsupported.unsupportedVsOcr },
    },
    medicineStatusDisagreements: med.statusDisagreements,
    traps,
    dates,
    alternatives,
    perKind,
    identity,
    byDifficulty,
    byDocumentKind,
    documents: { total: documents.length, read: documents.filter((doc) => doc.status === 'read').length,
      missing: documents.filter((doc) => doc.status === 'missing').map((doc) => doc.docId),
      notRead: documents.filter((doc) => !['read', 'missing'].includes(doc.status)).map((doc) => doc.docId) },
    worstDocuments: worst,
    perDocument: documents.map((doc) => ({ docId: doc.docId, status: doc.status, medicines: {
      expected: doc.medicines.expected, exact: doc.medicines.exact, caughtByCheck: doc.medicines.caughtByCheck,
      missedAfterChecking: doc.medicines.missedAfterChecking, missedIds: doc.medicines.missedIds },
    unsupported: doc.unsupported.unsupported, produced: doc.unsupported.produced, otherMissed: doc.otherMissed,
    extraItems: doc.extraItems })),
  };
}

const thresholdsMet = (report) => report.thresholdsMet ?? report.pass;
const verdict = (report) => (report.pass ? 'PASS' : thresholdsMet(report) ? 'NOT A LAUNCH RESULT' : 'FAIL');

const pct = (value) => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`);

export function renderMarkdown(report, { resultsDir = '' } = {}) {
  const m = report.launchMetrics;
  const lines = [];
  lines.push('# Paper reading launch check: result', '');
  lines.push(`**${verdict(report)}**${resultsDir ? ` (results: \`${resultsDir}\`)` : ''}`, '');
  lines.push('All documents in this check are fictional. This summary names documents by number only.', '');
  if (report.partial) {
    lines.push(`**Partial run: only ${report.documents.total} documents were scored. This is not a launch result; a launch decision needs the full set.**`, '');
  }
  if (report.handLabelled) {
    lines.push('**Hand-labelled set: a first reading of accuracy, not a launch result. The launch pass is the kit\'s own 200-document set.**', '');
  }
  if (report.mode && report.mode !== 'real') {
    lines.push(`**${report.mode === 'fake' ? 'Fake mode: these results come from the offline stand-ins, not from Textract and Claude' : 'These results have no real run records'}. This is not a launch result.**`, '');
  }
  lines.push('## The two launch measures', '');
  lines.push('| Measure | Result | Needed | Pass? |', '|---|---|---|---|');
  lines.push(`| Medicines right after checking | ${pct(m.medicineAccuracyAfterChecking.value)} (${m.medicineAccuracyAfterChecking.exact + m.medicineAccuracyAfterChecking.caughtByCheck} of ${m.medicineAccuracyAfterChecking.expected}) | at least 99% | ${m.medicineAccuracyAfterChecking.pass ? 'yes' : 'no'} |`);
  lines.push(`| Items not on the paper (unsupported) | ${pct(m.unsupportedItems.value)} (${m.unsupportedItems.unsupported} of ${m.unsupportedItems.produced}) | under 1% | ${m.unsupportedItems.pass ? 'yes' : 'no'} |`);
  lines.push('');
  lines.push(`- ${m.medicineAccuracyAfterChecking.exact} medicines were read exactly (name, strength, how often and whether it is still taken).`);
  lines.push(`- ${m.medicineAccuracyAfterChecking.caughtByCheck} more were read wrongly but marked "check carefully", so the person checking would catch them.`);
  lines.push(`- ${m.medicineAccuracyAfterChecking.missed} medicines were missed or read wrongly without a warning. These are the ones that matter most.`);
  lines.push(`- Strict score (exactly right, no credit for warnings): ${pct(m.medicineAccuracyStrict.value)}.`);
  lines.push(`- Medicines with the right name, strength and how often but a different status (for example "stopped" read as current): ${report.medicineStatusDisagreements}. These are not counted as exact; unless marked "check carefully" they are missed.`);
  lines.push(`- Unsupported items compared with the text-reading step alone (the AI adding things the scan did not say): ${m.unsupportedItems.unsupportedVsOcrText}.`);
  lines.push('');
  if (Object.keys(report.traps).length > 0) {
    lines.push('## Look-alike traps', '');
    lines.push('| Trap | Medicines | Right after checking | Exactly right |', '|---|---|---|---|');
    const names = { lookalike: 'Look-alike names (e.g. hydroxyzine / hydralazine)', strength: 'Look-alike strengths (5 mg / 50 mg)',
      negation: 'Stopped medicines', allergy_conflict: 'Medicines the documented allergy should warn about',
      future_date: 'Medicines on a page dated after the set was made' };
    for (const [trap, t] of Object.entries(report.traps)) {
      lines.push(`| ${names[trap] ?? trap} | ${t.expected} | ${pct(t.credited / t.expected)} | ${pct(t.exact / t.expected)} |`);
    }
    lines.push('');
  }
  lines.push('## Each kind of item', '');
  lines.push('Found = share of the answer key the reading found. Correct = of the items found, share whose details were all right. Extra = share of what was read that matched nothing in the answer key.', '');
  lines.push('| Kind | In answer key | Read | Found | Correct | Extra |', '|---|---|---|---|---|---|');
  const label = { medicine: 'Medicines', diagnosis: 'Diagnoses', allergy: 'Allergies', lab_result: 'Lab results', vital: 'Vital signs', note: 'Notes' };
  for (const [kind, k] of Object.entries(report.perKind)) {
    lines.push(`| ${label[kind]} | ${k.expected} | ${k.produced} | ${pct(k.recall)} | ${pct(k.fieldsCorrectShare)} | ${pct(k.precision === null ? null : 1 - k.precision)} |`);
  }
  lines.push('');
  const d = report.dates;
  if (d && DATE_OUTCOMES.some((outcome) => d[outcome] > 0)) {
    lines.push('## Dates', '');
    lines.push('Each item found is compared with the date the page gives for it (not part of the two launch measures).', '');
    lines.push('| Same as written | Same date, other spelling | Day and month swapped | Another date on the page | Wrong | Not read | Read as a separate note | Date where the key has none |', '|---|---|---|---|---|---|---|---|');
    lines.push(`| ${DATE_OUTCOMES.map((outcome) => d[outcome]).join(' | ')} |`, '');
    if (d.swappedIds.length > 0) lines.push(`Day and month swapped: ${d.swappedIds.join(', ')}.`, '');
  }
  const alt = report.alternatives;
  if (alt && (alt.ivFluidsAsPastMedicine || alt.prescriptionDateAsNote)) {
    lines.push(`Other readings accepted: IV fluids read as a past medicine ${alt.ivFluidsAsPastMedicine}, prescription date read as a separate note ${alt.prescriptionDateAsNote}.`, '');
  }
  const id = report.identity;
  if (id.documents > 0) {
    lines.push(`Patient details read right: name ${pct(id.name / id.documents)}, date of birth or age ${pct(id.dateOfBirth / id.documents)}, folder number ${pct(id.folderNumber / id.documents)}, sex ${pct(id.sex / id.documents)}.`, '');
  }
  lines.push('## By how hard the document was', '');
  lines.push('| Difficulty | Documents | Medicines right after checking | Exactly right | Unsupported |', '|---|---|---|---|---|');
  for (const [difficulty, g] of Object.entries(report.byDifficulty).sort()) {
    lines.push(`| ${difficulty.replace(/_/g, ' ')} | ${g.documents} | ${pct(share(g.credited, g.medicines))} | ${pct(share(g.exact, g.medicines))} | ${pct(share(g.unsupported, g.produced))} |`);
  }
  lines.push('');
  const docs = report.documents;
  lines.push(`Documents read: ${docs.read} of ${docs.total}.${docs.missing.length ? ` No result for: ${docs.missing.join(', ')} (counted as missed; re-run to finish them).` : ''}${docs.notRead.length ? ` Read without items (AI off, failed or declined): ${docs.notRead.join(', ')}.` : ''}`, '');
  lines.push('## Documents to look at first', '');
  if (report.worstDocuments.length === 0) {
    lines.push('No document had a missed medicine, an unsupported item or a missed item.', '');
  } else {
    lines.push('Up to 20 documents with the most serious problems first (missed medicines, then unsupported items). Open the document image and its answer key line in `keys/keys.jsonl` to see what went wrong.', '');
    lines.push('| Document | Kind | Difficulty | Pages | Medicines missed | Medicines caught by check | Unsupported items | Other items missed |', '|---|---|---|---|---|---|---|---|');
    for (const doc of report.worstDocuments) {
      lines.push(`| ${doc.docId}${doc.status === 'read' ? '' : ` (${doc.status})`} | ${doc.documentKind.replace(/_/g, ' ')} | ${doc.difficulty.replace(/_/g, ' ')} | ${doc.pages} | ${doc.medicinesMissedAfterChecking} | ${doc.medicinesCaughtByCheck} | ${doc.unsupportedItems} | ${doc.otherItemsMissed} |`);
    }
    lines.push('');
  }
  lines.push('## What this means', '');
  lines.push(report.pass
    ? 'Both launch measures are met on this set of fictional documents.'
    : thresholdsMet(report)
      ? 'Both launch measures are met on the documents scored here, but this is not a launch result: a launch decision needs a full real run of every document.'
      : 'At least one launch measure is not met. Paper reading should not be switched on for patients until a re-run passes.');
  lines.push('');
  return lines.join('\n');
}

export function loadPayloads(resultsDir, keys) {
  const payloads = new Map();
  for (const key of keys) {
    const file = path.join(resultsDir, `${key.docId}.json`);
    if (existsSync(file)) payloads.set(key.docId, JSON.parse(readFileSync(file, 'utf8')));
  }
  return payloads;
}

/** How many scored payloads come from each run mode: 'real', 'fake', or 'none' (no done run record). */
export function runModes(resultsDir, keys) {
  const modes = {};
  for (const key of keys) {
    if (!existsSync(path.join(resultsDir, `${key.docId}.json`))) continue;
    let mode = 'none';
    try {
      const record = JSON.parse(readFileSync(path.join(resultsDir, `${key.docId}.run.json`), 'utf8'));
      if (record.status === 'done' && ['real', 'fake'].includes(record.mode)) mode = record.mode;
    } catch { mode = 'none'; }
    modes[mode] = (modes[mode] ?? 0) + 1;
  }
  return modes;
}

export function main(argv = process.argv.slice(2), log = (line) => process.stdout.write(line + '\n')) {
  let args;
  try {
    args = parseArgs(argv, { booleans: ['help', 'partial'], strings: ['results', 'keys', 'out-json', 'out-md'] });
  } catch (error) { log(error.message); return 2; }
  if (args.help || !args.results) {
    log('usage: node score.mjs --results DIR [--keys DIR] [--out-json FILE] [--out-md FILE] [--partial]');
    return args.help ? 0 : 2;
  }
  let kit;
  try { kit = loadKeys(args.keys ? path.resolve(args.keys) : DEFAULT_KEYS_DIR); } catch (error) {
    log(`cannot score: ${error instanceof KitError ? error.message : 'keys unreadable'}`); return 2;
  }
  const resultsDir = path.resolve(args.results);
  if (!existsSync(resultsDir)) { log(`cannot score: ${resultsDir} does not exist`); return 2; }
  const keys = args.partial
    ? kit.keys.filter((key) => existsSync(path.join(resultsDir, `${key.docId}.run.json`))) : kit.keys;
  if (keys.length === 0) { log('cannot score: no run records in the results directory'); return 2; }
  const modes = runModes(resultsDir, keys);
  if (Object.keys(modes).length > 1) {
    log(`cannot score: the results directory mixes run modes (${Object.entries(modes).map(([mode, count]) =>
      `${mode} ${count}`).join(', ')}); score fake and real runs from separate directories`);
    return 2;
  }
  const report = scoreRun(keys, loadPayloads(resultsDir, keys));
  report.seed = kit.manifest.seed;
  report.partial = Boolean(args.partial);
  report.mode = Object.keys(modes)[0] ?? 'none';
  report.thresholdsMet = report.pass;
  // A hand-labelled set (LABELLING.md, label.mjs seal) gives a first reading, never the launch pass: that is the
  // kit's own 200-document set.
  report.handLabelled = kit.manifest.handLabelled === true;
  report.launchResult = !report.partial && report.mode === 'real' && !report.handLabelled;
  report.pass = report.thresholdsMet && report.launchResult;
  const jsonFile = path.resolve(args['out-json'] ?? path.join(resultsDir, 'score-report.json'));
  const mdFile = path.resolve(args['out-md'] ?? path.join(resultsDir, 'score-summary.md'));
  writeFileSync(jsonFile, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(mdFile, renderMarkdown(report, { resultsDir: path.relative(process.cwd(), resultsDir) || '.' }));
  const m = report.launchMetrics;
  const why = [report.partial ? `partial run, ${keys.length} of ${kit.keys.length} documents` : null,
    report.mode === 'real' ? null : report.mode === 'fake' ? 'fake mode' : 'no real run records',
    report.handLabelled ? 'hand-labelled set' : null].filter(Boolean);
  log(`${verdict(report)}${!report.pass && report.thresholdsMet ? ` (${why.join('; ')}; thresholds met on what was scored)` : ''}`
    + `: medicines right after checking ${pct(m.medicineAccuracyAfterChecking.value)}`
    + ` (needs >= 99%), strict ${pct(m.medicineAccuracyStrict.value)}, unsupported items ${pct(m.unsupportedItems.value)}`
    + ` (needs < 1%).`);
  log(`report: ${jsonFile}`);
  log(`summary: ${mdFile}`);
  return report.pass ? 0 : report.thresholdsMet ? 3 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
