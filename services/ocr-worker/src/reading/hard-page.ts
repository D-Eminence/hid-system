import type { Box, FlagReason, PaperItem } from './contract';
import { matchDiagnosisName } from './diagnosis-list';
import { matchDrugName, normaliseDrugName } from './drug-list';
import { checkReasonSentence, itemId, mergeIdentity, unionBox, uniqueItemIds, type PageCheck } from './items';
import { matchLabTestName } from './lab-list';
import { HARD_PAGE_FREQUENCIES, UNREADABLE, type BasisField, type FieldBasis, type HardItemExtras, type ModelItem,
  type ModelPage } from './prompt';
import { hasSign } from './signs';

/**
 * Hard pages (owner decision of 2026-11-05, about 18:40 UTC): a page flagged handwriting or low_confidence that goes
 * to the image re-read is read twice, with the same best-guess request (prompt.ts hardPageMessage), and the two
 * readings are compared here. Everything here is codes, counts and the page's own readings: nothing is logged.
 *
 * 1. prepareHardAnswer, on each answer before it is held to the page: frequency only from HARD_PAGE_FREQUENCIES
 *    (else "[unreadable]"), dose a number (else "[unreadable]"), strength rebuilt from dose and unit, and the drug
 *    name checked against the drug list (drug-list.ts): a listed name is shown in its list spelling with "?" (a brand
 *    as "Brand? (generic)"); an unlisted one becomes "[unreadable]". asWritten keeps what the model read, "?" marks
 *    and all: it is the transcription the clinician compares with the paper, while the drug name field is what may
 *    be taken into the record, so only the field is held to the list. Every filled text field whose basis is
 *    "context" gets "?" in the field itself (markGuess, GUESSABLE_TEXT_FIELDS), whatever the item's kind.
 * 2. Each answer is held to the page by checkPage (items.ts), unchanged: #194's placement rules apply to every item.
 * 3. mergeHardReadings pairs the kept items of the two readings and keeps what they agree on (see there).
 * 4. Each kept item (finish): a diagnosis name and a lab test name are grounded to their lists (diagnosis-list.ts:
 *    ICD-11 titles and our own synonyms; lab-list.ts: our own test names): a listed one is shown as read with the
 *    listed name after it ("HTN? (Hypertensive diseases)"), or as read where it is the listed name; an unlisted one
 *    is left as read. This comes after the checks and the comparison of the two readings, so both are made on the
 *    names as read (a lab value is still bound to its test as written), and only the shown field changes. An item
 *    holding a handwritten sign mark gets sign_read.
 * The result is then merged with the first pass by mergeReread, unchanged, so no first-pass item is lost.
 */

/** Reason codes added to hard-page items (sentences in items.ts REASON_SENTENCES). */
export const BEST_GUESS = 'best_guess_from_picture';
export const FROM_CONTEXT = 'field_from_context';
export const SINGLE_READING = 'single_reading_only';
export const READINGS_DISAGREE = 'readings_disagree';
/** A handwritten sign read as its meaning ("(sign)") or not read ("[sign?]") anywhere in the item (signs.ts). */
export const SIGN_READ = 'sign_read';

const ALLOWED_FREQUENCIES = new Set<string>(HARD_PAGE_FREQUENCIES);
/** "[?]" is a question mark written on the paper (a query), not the reading's own uncertainty. */
const PAPER_QUERY = /\[\?\]/g;
const guessMarks = (text: string) => text.replace(PAPER_QUERY, ' ').match(/\?/g)?.length ?? 0;
const unsure = (text: string) => guessMarks(text) > 0;
/** A reading's text without its "?" marks, normalised (case, spacing, "5 mg" = "5mg"), for comparing two readings. */
export const bare = (text: string | null | undefined) => (text ?? '').replace(/\?/g, ' ').replace(/\s+/g, ' ').trim()
  .toLowerCase().replace(/(\d)\s+(?=\p{L})/gu, '$1');

/** How often, only as one of HARD_PAGE_FREQUENCIES ("?" kept), "" where none is given, else "[unreadable]". */
export function normaliseFrequency(text: string): string {
  const compacted = text.toLowerCase().replace(/[\s.\-]/g, '').replace('hourly', 'hrly');
  const base = compacted.replace(/\?/g, '');
  if (base === '') return '';
  return ALLOWED_FREQUENCIES.has(base) ? `${base}${unsure(compacted) ? '?' : ''}` : UNREADABLE;
}

/** A dose is a number only ("400", "0.5"; "?" kept), "" where none is given, else "[unreadable]". */
export function normaliseDose(text: string): string {
  const compacted = text.replace(/\s/g, '');
  const base = compacted.replace(/\?/g, '');
  if (base === '') return '';
  return /^\d+(?:\.\d+)?$/.test(base) ? `${base}${unsure(compacted) ? '?' : ''}` : UNREADABLE;
}

/** The strength shown: dose and unit as read ("400? mg"); "" where neither is given. */
export function strengthOf(dose: string, unit: string): string {
  const doseText = dose.trim();
  const unitText = unit.trim();
  if (!doseText && !unitText) return '';
  if (!doseText) return `${UNREADABLE} ${unitText}`;
  return unitText ? `${doseText} ${unitText}` : doseText;
}

/**
 * A filled field whose basis is "context" (filled from what is usual, not read) carries "?" in the field itself, so
 * the guess shows where it is shown, whichever reason sentence the item gets.
 */
export function markGuess(value: string, basis: FieldBasis | undefined): string {
  if (basis !== 'context' || isBlank(value) || value === UNREADABLE || unsure(value)) return value;
  return `${value.trimEnd()}?`;
}

/**
 * The free-text fields of an answer item that become an item's text fields, of any kind, and so carry "?" when
 * their basis (basisKey) is "context". Not here: the enum fields (status, severity, measure, noKnownAllergies),
 * which cannot carry a mark and raise field_from_context instead (anyFromContext, pair); a medicine's strength,
 * rebuilt from its marked dose and unit; and the fields checkPage keeps only where they are written on the page
 * exactly (noteText, dateAsWritten, prescriberAsWritten, prescriptionDate), where a "?" would make it discard what
 * was read. A medicine's "unit" is not its dose unit (that is hard.doseUnit), so it is left to the dose.
 */
export const GUESSABLE_TEXT_FIELDS = ['name', 'form', 'route', 'frequency', 'duration', 'substance', 'reaction',
  'test', 'value', 'unit', 'referenceRange', 'flag'] as const;

/** Step 1 (see the header). Items without hard-page extras are left as they are. */
export function prepareHardAnswer(answer: ModelPage): ModelPage {
  return { ...answer, items: answer.items.map((item): ModelItem => {
    if (!item.hard) return item;
    const { basis } = item.hard;
    const proposed = item.name.trim();
    const match = item.kind === 'medicine' && proposed ? matchDrugName(proposed) : null;
    const prepared: ModelItem = { ...item, frequency: normaliseFrequency(item.frequency) };
    // A medicine's name is the drug list's (already "?" when listed; markGuess leaves a marked name as it is).
    if (item.kind === 'medicine') prepared.name = proposed ? match?.display ?? UNREADABLE : '';
    for (const field of GUESSABLE_TEXT_FIELDS) {
      if (item.kind === 'medicine' && field === 'unit') continue;
      prepared[field] = markGuess(prepared[field], basis[basisKey(item.kind, field)]);
    }
    if (item.kind !== 'medicine') return prepared;
    const dose = markGuess(normaliseDose(item.hard.dose), basis.dose);
    const doseUnit = markGuess(item.hard.doseUnit.trim(), basis.unit);
    return { ...prepared, strength: strengthOf(dose, doseUnit),
      hard: { ...item.hard, dose, doseUnit, generic: match?.generic ?? null, nameExact: match?.exact ?? false,
        proposedName: normaliseDrugName(proposed) } };
  }) };
}

/** One reading of a hard page, held to the page: its check and the (prepared) answer the check was made from. */
export interface HardReading { check: PageCheck; answer: ModelPage }

/** Counts only, for the completion log. */
export interface HardPageAgreement { fieldsCompared: number; fieldsAgreed: number; itemsPaired: number; itemsSingle: number }
export const noAgreement = (): HardPageAgreement => ({ fieldsCompared: 0, fieldsAgreed: 0, itemsPaired: 0, itemsSingle: 0 });

/** Two items are on the same place when they share a cited line or their boxes overlap by half the smaller box. */
export const PAIR_BOX_OVERLAP = 0.5;

const span = (aStart: number, aSize: number, bStart: number, bSize: number) =>
  Math.max(0, Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart));
function overlapShare(a: Box, b: Box): number {
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  if (!(smaller > 0)) return 0;
  return span(a.left, a.width, b.left, b.width) * span(a.top, a.height, b.top, b.height) / smaller;
}

/** Which basis field a contract field's value comes under. */
function basisKey(kind: PaperItem['kind'], field: string): BasisField {
  if (field === 'name' || field === 'route' || field === 'frequency' || field === 'duration' || field === 'value') return field;
  if (field === 'unit') return 'unit';
  if (kind === 'medicine' && field === 'strength') return 'dose';
  return 'other';
}

const lineNumber = (id: string) => Number(/-l(\d+)$/.exec(id)?.[1] ?? 0);
/** A blank or absent field counts as none. */
const isBlank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && !value.trim());

/** Whichever of two agreeing texts keeps the "?" marks (a word either reading was unsure of stays marked). */
function keepUnsure(a: string | null, b: string | null): string | null {
  if (isBlank(a)) return b;
  if (isBlank(b)) return a;
  return guessMarks(b!) > guessMarks(a!) ? b : a;
}

/**
 * asWritten from two readings: the words both read the same (in order, "?" kept where either was unsure), with each
 * stretch where they differ written once as "[unreadable]", so two readings of a dose are never shown side by side.
 */
export function mergeAsWritten(a: string, b: string): string {
  const left = a.split(/\s+/).filter(Boolean);
  const right = b.split(/\s+/).filter(Boolean);
  const key = (word: string) => bare(word);
  const table = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = key(left[i]!) === key(right[j]!) ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  let gap = false;
  const closeGap = () => { if (gap) { out.push(UNREADABLE); gap = false; } };
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && key(left[i]!) === key(right[j]!)) {
      closeGap();
      out.push(keepUnsure(left[i]!, right[j]!)!);
      i += 1; j += 1;
    } else if (j >= right.length || (i < left.length && table[i + 1]![j]! >= table[i]![j + 1]!)) {
      gap = true; i += 1;
    } else {
      gap = true; j += 1;
    }
  }
  closeGap();
  return out.join(' ');
}

interface Side { item: PaperItem; extras: HardItemExtras | undefined }

function sidesOf(reading: HardReading): Side[] {
  return reading.check.items.map((item, index) => ({ item,
    extras: reading.answer.items[reading.check.rawIndexes?.[index] ?? -1]?.hard }));
}

/** A field's basis said "context" in this reading (and the field is filled). */
function fromContext(side: Side, field: string, value: unknown): boolean {
  return !isBlank(value) && side.extras?.basis[basisKey(side.item.kind, field)] === 'context';
}

/**
 * The item's values held outside its fields: its date and, for a medicine, the prescriber and prescription date.
 * They carry no "?" (checkPage keeps them only where written exactly on the page) and come under basis "other".
 */
function outsideFields(item: PaperItem): Array<[string, string | null]> {
  return [['dateAsWritten', item.dateAsWritten], ['prescriberAsWritten', item.prescription?.prescriberAsWritten ?? null],
    ['prescriptionDate', item.prescription?.dateAsWritten ?? null]];
}

const anyFromContextOutside = (side: Side) =>
  outsideFields(side.item).some(([field, value]) => fromContext(side, field, value));

function anyFromContext(side: Side): boolean {
  const fields = side.item.fields as Record<string, unknown>;
  if (Object.entries(fields).some(([field, value]) => fromContext(side, field, value))) return true;
  if (anyFromContextOutside(side)) return true;
  // A medicine's dose and unit are kept apart in the extras; the unit's basis is "unit" (as in pair).
  return side.item.kind === 'medicine' && (fromContext(side, 'strength', side.extras?.dose)
    || fromContext(side, 'unit', side.extras?.doseUnit));
}

/** What each hard-page frequency code means, for the plain reading. */
export const FREQUENCY_WORDS: Readonly<Record<(typeof HARD_PAGE_FREQUENCIES)[number], string>> = {
  od: 'once a day', bd: 'twice a day', tds: 'three times a day', qds: 'four times a day', '6hrly': 'every 6 hours',
  '8hrly': 'every 8 hours', '12hrly': 'every 12 hours', nocte: 'at night', mane: 'in the morning', stat: 'at once',
  prn: 'when needed',
};
const DURATION_UNITS: Readonly<Record<string, string>> = { 7: 'days', 52: 'weeks', 12: 'months' };

/**
 * Dose shorthand in words, only where the read is certain (the field carries no "?" and no "[unreadable]" or
 * "[sign?]"): a frequency code as "tds (three times a day)", a duration written "5/7" as "5/7 (5 days)" ("/52"
 * weeks, "/12" months). Anything else is kept as written.
 */
export function shorthandInWords(field: 'frequency' | 'duration', value: string): string {
  const text = value.trim();
  if (!text || /\?|\[/.test(text)) return value;
  if (field === 'frequency') {
    const words = FREQUENCY_WORDS[text.toLowerCase() as keyof typeof FREQUENCY_WORDS];
    return words ? `${text} (${words})` : value;
  }
  const fraction = /^(\d+) ?\/ ?(7|52|12)$/.exec(text);
  if (!fraction) return value;
  const count = Number(fraction[1]);
  const unit = DURATION_UNITS[fraction[2]!]!;
  return `${text} (${count} ${count === 1 ? unit.slice(0, -1) : unit})`;
}

/**
 * The plain reading of a hard-page medicine, built only from its final fields (never the model's own guesses), with
 * a certain frequency or duration shorthand in words (shorthandInWords).
 */
function medicinePlain(fields: Record<string, unknown>): string {
  return ['name', 'strength', 'route', 'frequency', 'duration'].map((key) => {
    const value = fields[key];
    if (typeof value !== 'string' || value.trim() === '') return null;
    return key === 'frequency' || key === 'duration' ? shorthandInWords(key, value) : value;
  }).filter((value): value is string => value !== null).join(' ');
}

/**
 * A hard-page item's fields with a diagnosis name or a lab test name grounded to its list (step 4 of the header):
 * "As read? (listed name)" where listed and changed, as read otherwise. "[unreadable]" and sign marks never match.
 */
function groundedFields(item: PaperItem): PaperItem['fields'] {
  if (item.kind === 'diagnosis' && item.fields.name) {
    return { ...item.fields, name: matchDiagnosisName(item.fields.name)?.display ?? item.fields.name };
  }
  if (item.kind === 'lab_result' && item.fields.test) {
    return { ...item.fields, test: matchLabTestName(item.fields.test)?.display ?? item.fields.test };
  }
  return item.fields;
}

/** Whether the item holds a handwritten sign mark (signs.ts) in its asWritten or in any text field. */
function holdsSign(item: PaperItem): boolean {
  return hasSign(item.asWritten) || Object.values(item.fields as Record<string, unknown>)
    .some((value) => typeof value === 'string' && hasSign(value));
}

function finish(item: PaperItem, codes: readonly string[], sourceSha256Hex: string): PaperItem {
  const checkReasons = [...item.checkReasons];
  const signs = holdsSign(item) ? [SIGN_READ] : [];
  const fields = groundedFields(item);
  for (const code of [...codes, ...signs, BEST_GUESS, 'read_from_image']) {
    if (!checkReasons.includes(code)) checkReasons.push(code);
  }
  return { ...item, fields, id: itemId(sourceSha256Hex, item.kind, item.lineIds, item.asWritten), readBy: 'reread',
    confidence: 'check_carefully', checkReasons, checkReason: checkReasonSentence(checkReasons) } as PaperItem;
}

/** An item only one reading found (it passed every placement rule in its own reading). */
function single(side: Side, sourceSha256Hex: string): PaperItem {
  const item = { ...side.item, fields: { ...side.item.fields } } as PaperItem;
  if (item.kind === 'medicine') item.plain = medicinePlain(item.fields as Record<string, unknown>);
  return finish(item, [SINGLE_READING, ...(anyFromContext(side) ? [FROM_CONTEXT] : [])], sourceSha256Hex);
}

/**
 * Two readings of one item, field by field after normalisation (bare: "?" marks, case and spacing aside):
 * - agreeing: the best guess, keeping "?" where either reading was unsure, and basis "context" where either said so;
 * - a disagreeing medicine name: "A? / B?" when both names are on the drug list and both were read from the letters,
 *   else "[unreadable]" (a name filled from what is usual is never offered as an alternative: on an unusual
 *   prescription that is exactly the guess that would be wrong);
 * - any other disagreeing field (a number, unit, route, frequency, or any text): "[unreadable]", so two doses are
 *   never shown; a disagreeing medicine status becomes 'unknown', an allergy severity none (null), and a diagnosis
 *   keeps the first reading's status with readings_disagree.
 * The dose and unit of a medicine are compared apart (each counts as a field) and the strength is rebuilt from the two.
 */
function pair(a: Side, b: Side, sourceSha256Hex: string, tally: HardPageAgreement): PaperItem {
  let disagree = false;
  let context = false;
  const compare = (equal: boolean) => { tally.fieldsCompared += 1; if (equal) tally.fieldsAgreed += 1; else disagree = true; };
  const textField = (field: string, x: string | null, y: string | null, allowAlternatives: boolean): string | null => {
    if (fromContext(a, field, x) || fromContext(b, field, y)) context = true;
    if (isBlank(x) && isBlank(y)) { compare(true); return x; }
    const equal = bare(x) === bare(y);
    compare(equal);
    if (equal) return keepUnsure(x, y);
    if (allowAlternatives && x !== UNREADABLE && y !== UNREADABLE && !isBlank(x) && !isBlank(y)
      && !fromContext(a, field, x) && !fromContext(b, field, y)) return `${x} / ${y}`;
    return UNREADABLE;
  };
  const fieldsA = a.item.fields as Record<string, unknown>;
  const fieldsB = b.item.fields as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const [field, x] of Object.entries(fieldsA)) {
    const y = fieldsB[field];
    if (a.item.kind === 'medicine' && field === 'strength') continue;
    if (a.item.kind === 'medicine' && field === 'name') {
      // The same listed medicine under two spellings (a brand and its generic) is agreement when each reading wrote
      // a listed name as such, or both proposed the same spelling. Two different spellings of which one was respelled
      // by the fuzzy match may be two different medicines (one unlisted): that is disagreement, and unreadable.
      const listedA = a.extras?.generic ?? null;
      const listedB = b.extras?.generic ?? null;
      const sameWriting = (a.extras?.nameExact === true && b.extras?.nameExact === true)
        || (a.extras?.proposedName !== undefined && a.extras.proposedName === b.extras?.proposedName);
      if (listedA !== null && listedA === listedB && !sameWriting) {
        compare(false);
        if (fromContext(a, field, x) || fromContext(b, field, y)) context = true;
        fields[field] = UNREADABLE;
      } else if (listedA !== null && listedA === listedB) {
        compare(true);
        if (fromContext(a, field, x) || fromContext(b, field, y)) context = true;
        fields[field] = keepUnsure(x as string | null, y as string | null);
      } else {
        fields[field] = textField(field, x as string | null, y as string | null, listedA !== null && listedB !== null);
      }
      continue;
    }
    if (field === 'status' || field === 'severity' || field === 'measure' || field === 'noKnownAllergies') {
      // An enum carries no "?": a value either reading filled from context is said by field_from_context.
      if (fromContext(a, field, x) || fromContext(b, field, y)) context = true;
      compare(x === y);
      fields[field] = x === y ? x : a.item.kind === 'medicine' && field === 'status' ? 'unknown'
        : field === 'severity' ? null : x;
      continue;
    }
    fields[field] = textField(field, x as string | null, y as string | null, false);
  }
  if (a.item.kind === 'medicine') {
    const dose = textField('strength', a.extras?.dose ?? '', b.extras?.dose ?? '', false) ?? '';
    // The unit's basis is "unit"; textField reads the basis of 'unit'.
    const unit = textField('unit', a.extras?.doseUnit ?? '', b.extras?.doseUnit ?? '', false) ?? '';
    fields.strength = strengthOf(dose, unit) || null;
  }
  // A date or prescriber either reading filled from context is said by field_from_context (it carries no "?").
  if (anyFromContextOutside(a) || anyFromContextOutside(b)) context = true;
  const mergeText = (x: string | null, y: string | null) => isBlank(x) && isBlank(y) ? x
    : bare(x) === bare(y) ? keepUnsure(x, y) : UNREADABLE;
  const prescriptionA = a.item.prescription;
  const prescriptionB = b.item.prescription;
  const prescription = prescriptionA === null && prescriptionB === null ? null : {
    prescriberAsWritten: mergeText(prescriptionA?.prescriberAsWritten ?? null, prescriptionB?.prescriberAsWritten ?? null),
    dateAsWritten: mergeText(prescriptionA?.dateAsWritten ?? null, prescriptionB?.dateAsWritten ?? null) };
  const asWritten = bare(a.item.asWritten) === bare(b.item.asWritten) ? keepUnsure(a.item.asWritten, b.item.asWritten)!
    : mergeAsWritten(a.item.asWritten, b.item.asWritten);
  const lineIds = [...new Set([...a.item.lineIds, ...b.item.lineIds])].sort((x, y) => lineNumber(x) - lineNumber(y));
  const reasons = [...a.item.checkReasons, ...b.item.checkReasons.filter((code) => !a.item.checkReasons.includes(code))];
  const merged = { ...a.item, asWritten, lineIds, box: unionBox([a.item.box, b.item.box]) ?? a.item.box,
    dateAsWritten: mergeText(a.item.dateAsWritten, b.item.dateAsWritten), fields,
    prescription: a.item.kind === 'medicine' ? prescription : null, checkReasons: reasons } as PaperItem;
  merged.plain = merged.kind === 'medicine' ? medicinePlain(fields)
    : disagree ? '' : a.item.plain;
  tally.itemsPaired += 1;
  return finish(merged, [...(disagree ? [READINGS_DISAGREE] : []), ...(context ? [FROM_CONTEXT] : [])], sourceSha256Hex);
}

/** Whether two items of the two readings may be the same writing: same kind, same place, nothing that rules it out. */
function pairScore(a: PaperItem, b: PaperItem): number | null {
  if (a.kind !== b.kind) return null;
  if (a.kind === 'vital' && b.kind === 'vital' && a.fields.measure !== b.fields.measure) return null;
  if (a.kind === 'allergy' && b.kind === 'allergy' && a.fields.noKnownAllergies !== b.fields.noKnownAllergies) return null;
  const shared = a.lineIds.filter((id) => b.lineIds.includes(id)).length;
  const overlap = overlapShare(a.box, b.box);
  if (shared === 0 && overlap < PAIR_BOX_OVERLAP) return null;
  return shared + overlap;
}

/** Two neighbouring medicines are in the same column when their boxes share this much of the narrower one's width. */
export const NEIGHBOUR_COLUMN_OVERLAP = 0.5;
/** Slack for comparing box fractions, so a share of exactly NEIGHBOUR_COLUMN_OVERLAP counts whatever the rounding. */
const BOX_EPSILON = 1e-9;

/**
 * Two medicines left unpaired by place that are the same listed medicine on neighbouring rows of one column: their
 * boxes share at least NEIGHBOUR_COLUMN_OVERLAP of the narrower one's width, and their cited lines are at most one
 * line apart or their boxes share part of their height. The smaller the gap the better; null when not neighbours.
 * Nothing pairs across columns or along one row: the same medicine at one height in two columns is two orders, and
 * two halves of one written line ("Metronidazole" | "400 mg tds"), each found by one reading, stay two
 * single_reading_only items (a safe duplicate: merging them would make every field the other half fills
 * "[unreadable]", and a lone name beside a full order would swallow that order).
 */
function neighbourGap(a: Side, b: Side): number | null {
  if (a.item.kind !== 'medicine' || b.item.kind !== 'medicine') return null;
  const generic = a.extras?.generic ?? null;
  if (generic === null || generic !== (b.extras?.generic ?? null)) return null;
  const boxA = a.item.box;
  const boxB = b.item.box;
  const narrower = Math.min(boxA.width, boxB.width);
  const across = span(boxA.left, boxA.width, boxB.left, boxB.width);
  if (!(narrower > 0) || across + BOX_EPSILON < NEIGHBOUR_COLUMN_OVERLAP * narrower) return null;
  const down = span(boxA.top, boxA.height, boxB.top, boxB.height);
  const linesA = a.item.lineIds.map(lineNumber);
  const linesB = b.item.lineIds.map(lineNumber);
  const lineGap = Math.min(...linesA.flatMap((x) => linesB.map((y) => Math.abs(x - y))));
  if (lineGap > 1 && down <= 0) return null;
  return down > 0 ? 0 : lineGap;
}

/**
 * The hard page's reading from its two readings (or from one, when the other failed or was declined: every item
 * then single_reading_only). Items are paired one to one by kind and place (a shared cited line, or boxes
 * overlapping by PAIR_BOX_OVERLAP of the smaller), best pairs first, then the same listed medicine on neighbouring
 * rows of one column (neighbourGap); each pair is merged by `pair`, and an item only
 * one reading found is kept with single_reading_only. Every item: check_carefully, readBy 'reread', read_from_image
 * and best_guess_from_picture, plus field_from_context where any field's basis was context. Identity is merged as in
 * mergeIdentity (a conflict flags the page ai_unsure); the page flags are both readings' flags; the dropped counts are
 * the first reading's (the one the page is held to first), or the only reading's. An item holding a handwritten
 * sign mark ("(sign)" or "[sign?]", signs.ts) in its asWritten or any field also gets sign_read.
 */
export function mergeHardReadings(readings: readonly HardReading[], sourceSha256Hex: string):
  { check: PageCheck; agreement: HardPageAgreement } {
  const tally = noAgreement();
  const [first, second] = readings;
  if (!first) throw new Error('mergeHardReadings needs a reading');
  if (!second) {
    const items = sidesOf(first).map((side) => single(side, sourceSha256Hex));
    tally.itemsSingle += items.length;
    return { check: { ...first.check, items: uniqueItemIds(items), rawIndexes: undefined }, agreement: tally };
  }
  const left = sidesOf(first);
  const right = sidesOf(second);
  const candidates: Array<{ i: number; j: number; score: number }> = [];
  left.forEach((a, i) => right.forEach((b, j) => {
    const score = pairScore(a.item, b.item);
    if (score !== null) candidates.push({ i, j, score });
  }));
  candidates.sort((x, y) => y.score - x.score || x.i - y.i || x.j - y.j);
  const usedLeft = new Map<number, number>();
  const usedRight = new Set<number>();
  for (const { i, j } of candidates) {
    if (usedLeft.has(i) || usedRight.has(j)) continue;
    usedLeft.set(i, j);
    usedRight.add(j);
  }
  // Then the same listed medicine read on neighbouring lines (the two readings cited different fragments of one
  // handwritten line): paired, so one medicine is never shown twice with two doses.
  const neighbours: Array<{ i: number; j: number; gap: number }> = [];
  left.forEach((a, i) => right.forEach((b, j) => {
    if (usedLeft.has(i) || usedRight.has(j)) return;
    const gap = neighbourGap(a, b);
    if (gap !== null) neighbours.push({ i, j, gap });
  }));
  neighbours.sort((x, y) => x.gap - y.gap || x.i - y.i || x.j - y.j);
  for (const { i, j } of neighbours) {
    if (usedLeft.has(i) || usedRight.has(j)) continue;
    usedLeft.set(i, j);
    usedRight.add(j);
  }
  const items: PaperItem[] = [];
  left.forEach((a, i) => {
    const j = usedLeft.get(i);
    items.push(j === undefined ? single(a, sourceSha256Hex) : pair(a, right[j]!, sourceSha256Hex, tally));
  });
  right.forEach((b, j) => { if (!usedRight.has(j)) items.push(single(b, sourceSha256Hex)); });
  tally.itemsSingle += items.length - tally.itemsPaired;
  const firstLine = (item: PaperItem) => Math.min(...item.lineIds.map(lineNumber));
  const ordered = items.map((item, index) => ({ item, index }))
    .sort((x, y) => firstLine(x.item) - firstLine(y.item) || x.index - y.index).map(({ item }) => item);
  const { identity, conflict } = mergeIdentity(first.check.identity, second.check.identity);
  const flags = new Set<FlagReason>([...first.check.flagReasons, ...second.check.flagReasons,
    ...(conflict ? ['ai_unsure' as const] : [])]);
  const order: readonly FlagReason[] = ['low_confidence', 'handwriting', 'many_dropped', 'ai_unsure',
    'possible_missed_item', 'ai_declined'];
  return { check: { ...first.check, items: uniqueItemIds(ordered), identity,
    pageUnsure: first.check.pageUnsure || second.check.pageUnsure,
    flagReasons: order.filter((flag) => flags.has(flag)), rawIndexes: undefined }, agreement: tally };
}
