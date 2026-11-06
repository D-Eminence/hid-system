import type { Box, FlagReason, PaperItem } from './contract';
import { diagnosisLookalike, matchDiagnosisName, type ListMatch } from './diagnosis-list';
import { drugLookalike, matchDrugName, normaliseDrugName, type DrugMatch } from './drug-list';
import { withoutCrossedOut } from './grounding';
import { checkReasonSentence, itemId, mergeIdentity, unionBox, uniqueItemIds, type PageCheck } from './items';
import { labTestLookalike, matchLabTestName } from './lab-list';
import { ALTERNATIVE_OPEN, BASIS_FIELDS, CROSSED_OUT_OPEN, HARD_PAGE_FREQUENCIES, NO_LETTERS, type BasisField,
  type FieldBasis, type HardItemExtras, type ModelItem, type ModelPage } from './prompt';
import { hasSign } from './signs';

/**
 * Hard pages (owner decision of 2026-11-05, about 18:40 UTC): a page flagged handwriting or low_confidence that goes
 * to the image re-read is read twice, with the same best-guess request (prompt.ts hardPageMessage), and the two
 * readings are compared here. Everything here is codes, counts and the page's own readings: nothing is logged.
 *
 * Clean reading (owner decision of 2026-11-06, about 10:13 UTC, relayed by the coordinator: "i want the output clean
 * ... doctor no get time", after comparing with a chat reading of the same fictional page that gave rows like
 * "IV Flagyl? 500mg? 8hrly?", "Transfer to the ward", "Switch to IV Ceftriaxone 1g"): a best guess for every word,
 * "?" straight after each uncertain one, and the item's plain reading (what the check screen shows as the item) is
 * the reading itself, never a sentence about it. The tokens (prompt.ts): "[?]" (NO_LETTERS) only for writing with no
 * letter shapes at all; "(? on paper)" (PAPER_QUERY) for a question mark written on the paper; "A? (or B?)" where the
 * two readings differ; "(crossed out: X?)" for struck-out writing on its item. Nothing becomes "[?]" because the
 * readings disagree, and a drug name not on the list is shown as read with "?" (before, "[unreadable]"): safety
 * rests on every hard-page item being check_carefully, so a person keeps or changes each one.
 *
 * 1. prepareHardAnswer, on each answer before it is held to the page: the old "[unreadable]" becomes "[?]"; an
 *    item whose asWritten is a description of the writing ("handwritten entry that cannot be read"; isDescription)
 *    becomes a "[?]" note, and such a field becomes "[?]" (description_replaced); an item that is crossed out as a
 *    whole becomes a note (never an active medicine); the model's plain is dropped (built in finish). Frequency is
 *    one of HARD_PAGE_FREQUENCIES where it is one ("?" kept), else as read; dose a number where it is one, else as
 *    read; strength rebuilt from dose and unit ("500mg?"). The drug name is checked against the
 *    drug list (drug-list.ts): a listed name is shown in its list spelling (a brand as "Brand (generic)"), with "?"
 *    where the model was unsure, the name came from context or the list respelled it; a name near a real unlisted
 *    look-alike is shown as read with the listed one as the other option, "Arteether? (or Artemether?)"; any other
 *    name is shown as read, every word with "?". asWritten keeps what the model read, marks and all. Every filled
 *    text field whose basis is "context" gets "?" in the field itself (markGuess, GUESSABLE_TEXT_FIELDS).
 * 2. Each answer is held to the page by checkPage (items.ts), unchanged: #194's placement rules apply to every item.
 *    Every check is made with the "?" marks and crossed-out writing taken off (grounding.ts forMatching).
 * 3. mergeHardReadings pairs the kept items of the two readings and keeps what they agree on; where they differ,
 *    read A's guess is shown with read B's after it, "A? (or B?)" (see pair).
 * 4. Each kept item (finish): a diagnosis name and a lab test name are grounded to their lists (diagnosis-list.ts:
 *    ICD-11 titles and our own synonyms; lab-list.ts: our own test names): a listed one is shown as read with the
 *    listed name after it ("HTN? (Hypertensive diseases)"), or as read where it is the listed name; one near an
 *    unlisted look-alike as "As read? (or Listed?)"; any other is left as read. This comes after the checks and the
 *    comparison of the two readings, so both are made on the names as read. The plain reading is built from the
 *    final fields (hardPlain). An item holding a handwritten sign mark gets sign_read; one with crossed-out writing
 *    crossed_out.
 * The result is then merged with the first pass by mergeReread, unchanged, so no first-pass item is lost.
 */

/** Reason codes added to hard-page items (sentences in items.ts REASON_SENTENCES). */
export const BEST_GUESS = 'best_guess_from_picture';
export const FROM_CONTEXT = 'field_from_context';
export const SINGLE_READING = 'single_reading_only';
export const READINGS_DISAGREE = 'readings_disagree';
/** A handwritten sign read as its meaning ("(sign)") or not read ("[sign?]") anywhere in the item (signs.ts). */
export const SIGN_READ = 'sign_read';
/** Writing crossed out on the paper, shown "(crossed out: X)" on the item. */
export const CROSSED_OUT = 'crossed_out';
/** The model described the writing instead of reading it; replaced by "[?]". */
export const DESCRIPTION_REPLACED = 'description_replaced';

const ALLOWED_FREQUENCIES = new Set<string>(HARD_PAGE_FREQUENCIES);
/** Marks holding a "?" that is not the reading's uncertainty: a query on the paper, no letter shapes, a sign not read. */
const NOT_GUESS_MARKS = /\(\? on paper\)|\[\?\]|\[sign\?\]/g;
const guessMarks = (text: string) => text.replace(NOT_GUESS_MARKS, ' ').match(/\?/g)?.length ?? 0;
const unsure = (text: string) => guessMarks(text) > 0;
/** Whether a text has a letter or digit outside the reading marks (else it is only "[?]", "[sign?]" or the like). */
const hasLetters = (text: string) => /[\p{L}\p{N}]/u.test(text.replace(NOT_GUESS_MARKS, ' ').replace(/\(sign\)/g, ' '));
/** A reading's text without its "?" marks, normalised (case, spacing, "5 mg" = "5mg"), for comparing two readings. */
export const bare = (text: string | null | undefined) => (text ?? '').replace(/\?/g, ' ').replace(/\s+/g, ' ').trim()
  .toLowerCase().replace(/(\d)\s+(?=\p{L})/gu, '$1');
/** The old "[unreadable]" (hard-page prompt 2 to 4) as the clean token "[?]". */
const cleanTokens = (text: string) => text.replace(/\[unreadable\]/gi, NO_LETTERS);

/**
 * A text split into words, a bracketed group ("(metronidazole)", "(? on paper)", "(crossed out: 400mg?)", "[?]",
 * "[sign?]") counting as one word even with spaces inside.
 */
function words(text: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index]!)) { index += 1; continue; }
    let end = index;
    if (text[index] === '(' || text[index] === '[') {
      let depth = 0;
      for (; end < text.length; end += 1) {
        if (text[end] === '(' || text[end] === '[') depth += 1;
        else if (text[end] === ')' || text[end] === ']') { depth -= 1; if (depth === 0) { end += 1; break; } }
      }
    } else {
      while (end < text.length && !/\s/.test(text[end]!)) end += 1;
    }
    out.push(text.slice(index, end));
    index = end;
  }
  return out;
}

/**
 * Every word of the text marked a guess: "?" after each word or number that has none yet ("Ceftriaxone 1g" is
 * "Ceftriaxone? 1g?"), before any trailing punctuation. A bracketed group (a listed generic, a reading mark) and a
 * word already holding a "?" are left as they are.
 */
export function markWords(text: string): string {
  return words(text).map((word) => /^[([]/.test(word) || word.includes('?') || !/[\p{L}\p{N}]/u.test(word) ? word
    : word.replace(/([.,;:]*)$/, '?$1')).join(' ');
}

/**
 * Two readings of one field: "A? (or B?)", every word of both marked a guess; the one with letter shapes first where
 * the other has none; one alone (marked) where the other is blank. The rendering of a disagreement (pair).
 */
export function alternatives(first: string | null, second: string | null): string {
  if (isBlank(second)) return isBlank(first) ? (first ?? '') : markWords(first!);
  if (isBlank(first)) return markWords(second!);
  const [a, b] = !hasLetters(first!) && hasLetters(second!) ? [second!, first!] : [first!, second!];
  return `${markWords(a)} ${ALTERNATIVE_OPEN}${markWords(b)})`;
}

/** "A (or B)" split into A and B where the text ends with an alternative (alternatives), else null. */
export function splitAlternative(text: string): [string, string] | null {
  if (!text.endsWith(')')) return null;
  let depth = 0;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] === ')') depth += 1;
    else if (text[index] === '(') {
      depth -= 1;
      if (depth === 0) {
        if (index === 0 || !text.startsWith(ALTERNATIVE_OPEN, index)) return null;
        return [text.slice(0, index).trim(), text.slice(index + ALTERNATIVE_OPEN.length, -1).trim()];
      }
    }
  }
  return null;
}

/**
 * Whether a text describes the writing instead of reading it ("Handwritten treatment entry that cannot be read; check
 * the paper", "illegible", "appears to say ..."): never shown as a reading (owner decision of 2026-11-06). Run after
 * "[unreadable]" became "[?]". Deliberately narrow: words a clinician writes on a page ("unclear diagnosis", "faint
 * line" on a test) do not match.
 */
const DESCRIPTION_PATTERNS: readonly RegExp[] = [
  /\b(?:cannot|can ?not|can't|could ?not|couldn't|unable to)\s+(?:be\s+)?(?:read|made out|make out|deciphered|decipher|interpreted)\b/i,
  /\b(?:illegible|indecipherable|undecipherable|unintelligible|unreadable)\b/i,
  /\bcheck\s+(?:it\s+|this\s+)?(?:against\s+)?the\s+(?:paper|original|chart)\b/i,
  /\b(?:handwritten|illegible|scribbled)\s+(?:\p{L}+\s+)?(?:entry|text|writing|scribble|item)\b/iu,
  /\b(?:entry|writing|text)\s+(?:is|was)\s+(?:not\s+)?(?:legible|readable)\b/i,
  /\b(?:appears|seems)\s+to\s+(?:be|say|read)\b/i,
  /\bnot\s+(?:legible|readable)\b/i,
];
export function isDescription(text: string): boolean {
  return DESCRIPTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * How often: one of HARD_PAGE_FREQUENCIES where it is one ("?" kept), "" where none is given, else as read, with the
 * model's own "?" marks ("alternate (sign) days", "x5/7"); "[unreadable]" is "[?]".
 */
export function normaliseFrequency(text: string): string {
  const written = cleanTokens(text).trim();
  if (written === '') return '';
  const compacted = written.toLowerCase().replace(/[\s.\-]/g, '').replace('hourly', 'hrly');
  const base = compacted.replace(/\?/g, '');
  return ALLOWED_FREQUENCIES.has(base) ? `${base}${unsure(compacted) ? '?' : ''}` : written;
}

/** A dose: a number where it is one ("400", "0.5"; "?" kept), "" where none is given, else as read ("1/2", "[?]"). */
export function normaliseDose(text: string): string {
  const written = cleanTokens(text).trim();
  const compacted = written.replace(/\s/g, '');
  const base = compacted.replace(/\?/g, '');
  if (base === '') return '';
  return /^\d+(?:\.\d+)?$/.test(base) ? `${base}${unsure(compacted) ? '?' : ''}` : written;
}

/** Units written straight after the number in the strength shown ("500mg", "1g"). */
const JOINED_UNITS = /^(?:mg|mcg|µg|ug|g|kg|ml|l|iu|u|%)$/i;

/**
 * The strength shown: dose and unit as read, a number and a metric unit written together with one "?" where either
 * is unsure ("500mg?", "1g"); "[?] mg" where a unit is read without its dose; "" where neither is given.
 */
export function strengthOf(dose: string, unit: string): string {
  const doseText = dose.trim();
  const unitText = unit.trim();
  if (!doseText && !unitText) return '';
  if (!doseText) return `${NO_LETTERS} ${unitText}`;
  if (!unitText) return doseText;
  const doseBare = doseText.replace(/\?+$/, '');
  const unitBare = unitText.replace(/\?+$/, '');
  if (/^\d+(?:\.\d+)?$/.test(doseBare) && JOINED_UNITS.test(unitBare)) {
    return `${doseBare}${unitBare}${doseBare !== doseText || unitBare !== unitText ? '?' : ''}`;
  }
  return `${doseText} ${unitText}`;
}

/**
 * A filled field whose basis is "context" (filled from what is usual, not read) carries "?" in the field itself, so
 * the guess shows where it is shown, whichever reason sentence the item gets.
 */
export function markGuess(value: string, basis: FieldBasis | undefined): string {
  if (basis !== 'context' || isBlank(value) || !hasLetters(value) || unsure(value)) return value;
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
/** Every free-text field of an answer item that a description or the old "[unreadable]" may be written in. */
const TEXT_FIELDS = [...GUESSABLE_TEXT_FIELDS, 'strength', 'noteText', 'dateAsWritten', 'prescriberAsWritten',
  'prescriptionDate'] as const;

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** A listed drug as shown: "Generic" or "Brand (generic)", with "?" after the name where it is a guess. */
function drugDisplay(match: DrugMatch, guess: boolean): string {
  const mark = guess ? '?' : '';
  return match.brand === null ? `${capitalise(match.generic)}${mark}` : `${capitalise(match.brand)}${mark} (${match.generic})`;
}

/** The answer item replaced by a "[?]" note: the model described the writing instead of reading it. */
function describedNote(item: ModelItem): ModelItem {
  const empty = Object.fromEntries(TEXT_FIELDS.map((field) => [field, ''])) as Record<(typeof TEXT_FIELDS)[number], string>;
  return { ...item, ...empty, kind: 'note', asWritten: NO_LETTERS, noteText: NO_LETTERS, plain: '', unsure: true,
    status: 'none', severity: 'none', measure: 'none', noKnownAllergies: false,
    hard: { dose: '', doseUnit: '', crossedOut: '', described: true,
      basis: Object.fromEntries(BASIS_FIELDS.map((key) => [key, key === 'other' ? 'letters' : 'empty'])) as
        Record<BasisField, FieldBasis> } };
}

/** An item whose writing is all crossed out (rule G): a note holding the crossed-out writing, never an active item. */
function crossedOutNote(item: ModelItem): ModelItem {
  const empty = Object.fromEntries(TEXT_FIELDS.map((field) => [field, ''])) as Record<(typeof TEXT_FIELDS)[number], string>;
  return { ...item, ...empty, kind: 'note', noteText: item.asWritten, status: 'none', severity: 'none', measure: 'none',
    noKnownAllergies: false, dateAsWritten: item.dateAsWritten,
    hard: { ...item.hard!, dose: '', doseUnit: '' } };
}

/** Step 1 (see the header). Items without hard-page extras are left as they are. */
export function prepareHardAnswer(answer: ModelPage): ModelPage {
  return { ...answer, items: answer.items.map((original): ModelItem => {
    if (!original.hard) return original;
    let item: ModelItem = { ...original, asWritten: cleanTokens(original.asWritten), plain: '',
      hard: { ...original.hard, dose: cleanTokens(original.hard.dose), doseUnit: cleanTokens(original.hard.doseUnit),
        crossedOut: cleanTokens(original.hard.crossedOut ?? '').trim() } };
    if (isDescription(item.asWritten)) return describedNote(item);
    let described = false;
    for (const field of TEXT_FIELDS) {
      const value = cleanTokens(item[field]);
      if (isDescription(value)) {
        described = true;
        item[field] = field === 'noteText' ? '' : NO_LETTERS;
      } else item[field] = value;
    }
    if (isDescription(item.hard!.dose)) { described = true; item.hard!.dose = NO_LETTERS; }
    if (isDescription(item.hard!.doseUnit)) { described = true; item.hard!.doseUnit = NO_LETTERS; }
    if (isDescription(item.hard!.crossedOut ?? '')) { described = true; item.hard!.crossedOut = NO_LETTERS; }
    if (described) item.hard = { ...item.hard!, described: true };
    // Crossed out as a whole: never an active item, whatever kind the model gave it.
    if (item.kind !== 'note' && item.asWritten.includes(CROSSED_OUT_OPEN) && !hasLetters(withoutCrossedOut(item.asWritten))) {
      item = crossedOutNote(item);
    }
    const { basis } = item.hard!;
    const proposed = item.name.trim();
    const match = item.kind === 'medicine' && proposed ? matchDrugName(proposed) : null;
    const prepared: ModelItem = { ...item, frequency: normaliseFrequency(item.frequency) };
    if (item.kind === 'medicine') {
      if (!proposed) prepared.name = '';
      else if (match) prepared.name = drugDisplay(match, unsure(proposed) || !match.exact || basis.name === 'context');
      else {
        const other = drugLookalike(proposed);
        prepared.name = other ? alternatives(proposed, other.display) : hasLetters(proposed) ? markWords(proposed) : proposed;
      }
    }
    for (const field of GUESSABLE_TEXT_FIELDS) {
      if (item.kind === 'medicine' && field === 'unit') continue;
      prepared[field] = markGuess(prepared[field], basis[basisKey(item.kind, field)]);
    }
    if (item.kind !== 'medicine') return prepared;
    const dose = markGuess(normaliseDose(item.hard!.dose), basis.dose);
    const doseUnit = markGuess(item.hard!.doseUnit.trim(), basis.unit);
    return { ...prepared, strength: strengthOf(dose, doseUnit),
      hard: { ...item.hard!, dose, doseUnit, generic: match?.generic ?? null, nameExact: match?.exact ?? false,
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
 * stretch where they differ written as the first reading's words, marked, then the second's: "IV Flagyl? 500mg?
 * (or 250mg?) 8hrly" (a stretch only the second has is "(or B?)" on its own). Nothing is dropped for disagreeing.
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
  let fromLeft: string[] = [];
  let fromRight: string[] = [];
  const closeGap = () => {
    if (fromLeft.length > 0 || fromRight.length > 0) {
      const shown = alternatives(fromLeft.join(' '), fromRight.join(' '));
      out.push(fromLeft.length === 0 ? `${ALTERNATIVE_OPEN}${shown})` : shown);
    }
    fromLeft = [];
    fromRight = [];
  };
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && key(left[i]!) === key(right[j]!)) {
      closeGap();
      out.push(keepUnsure(left[i]!, right[j]!)!);
      i += 1; j += 1;
    } else if (j >= right.length || (i < left.length && table[i + 1]![j]! >= table[i]![j + 1]!)) {
      fromLeft.push(left[i]!); i += 1;
    } else {
      fromRight.push(right[j]!); j += 1;
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

/**
 * What each hard-page frequency code means, for the plain reading. "od" is not here: it is "once a day", but also
 * "oculus dexter" (the right eye) on an eye-drop prescription, and normaliseFrequency lower-cases "OD", so it is
 * kept as written, never put in words.
 */
export const FREQUENCY_WORDS: Readonly<Partial<Record<(typeof HARD_PAGE_FREQUENCIES)[number], string>>> = {
  bd: 'twice a day', tds: 'three times a day', qds: 'four times a day', '6hrly': 'every 6 hours',
  '8hrly': 'every 8 hours', '12hrly': 'every 12 hours', nocte: 'at night', mane: 'in the morning', stat: 'at once',
  prn: 'when needed',
};
const DURATION_UNITS: Readonly<Record<string, string>> = { 7: 'days', 52: 'weeks', 12: 'months' };

/**
 * Dose shorthand in words, only where the read is certain (the field carries no "?" and no "[?]" or
 * "[sign?]"): a frequency code as "tds (three times a day)" ("od" kept as written: see FREQUENCY_WORDS), a duration written "5/7" as "5/7 (5 days)" ("/52"
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
 * The plain reading of a hard-page medicine, built only from its final fields (never the model's own wording), in the
 * order a prescription is written: route, drug, strength, how often, how long ("IV Flagyl? (metronidazole) 500mg?
 * 8hrly?"), with a certain frequency or duration shorthand in words (shorthandInWords).
 */
function medicinePlain(fields: Record<string, unknown>): string {
  return ['route', 'name', 'strength', 'frequency', 'duration'].map((key) => {
    const value = fields[key];
    if (typeof value !== 'string' || value.trim() === '') return null;
    return key === 'frequency' || key === 'duration' ? shorthandInWords(key, value) : value;
  }).filter((value): value is string => value !== null).join(' ');
}

const firstWordKey = (text: string) => (words(text)[0] ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The words written before a medicine's route or drug name, as read, where they are an instruction in words ("Switch
 * to" in "Switch to IV Ceftriaxone 1g"): one to four words, none a number. "" otherwise.
 */
export function leadIn(asWritten: string, anchors: readonly (string | null | undefined)[]): string {
  const keys = anchors.filter((anchor): anchor is string => !isBlank(anchor)).map(firstWordKey).filter(Boolean);
  const written = withoutCrossedOut(asWritten).split(/\s+/).filter(Boolean);
  const index = written.findIndex((word) => keys.includes(firstWordKey(word)));
  if (index <= 0 || index > 4) return '';
  const lead = written.slice(0, index);
  return lead.some((word) => /\d/.test(word)) || !lead.some((word) => /\p{L}/u.test(word)) ? '' : lead.join(' ');
}

/** The crossed-out writing an item shows: the reading's crossedOut, else what asWritten writes as "(crossed out: X)". */
function crossedOutOf(asWritten: string, given: string | undefined): string {
  if (!isBlank(given)) return given!.trim();
  return words(asWritten).filter((word) => word.startsWith(CROSSED_OUT_OPEN))
    .map((word) => word.slice(CROSSED_OUT_OPEN.length, -1).trim()).filter(Boolean).join('; ');
}

/**
 * The item's plain reading on a hard page: what the check screen shows as the item, the reading itself as on the
 * paper, never a sentence about it. A medicine: the lead-in words, then route, drug, strength, how often, how long; a
 * diagnosis: its (grounded) name; a lab result: test, value, unit and flag; a note: its text; an allergy or a vital:
 * its asWritten. asWritten where that is empty. Crossed-out writing is added as "(crossed out: X)" where not shown.
 */
export function hardPlain(item: PaperItem, fields: PaperItem['fields'], crossed: string, lead: string): string {
  const values = fields as Record<string, unknown>;
  const join = (keys: readonly string[]) => keys.map((key) => values[key]).filter((value): value is string =>
    typeof value === 'string' && value.trim() !== '').join(' ');
  let text = item.kind === 'medicine' ? [lead, medicinePlain(values)].filter(Boolean).join(' ')
    : item.kind === 'diagnosis' ? join(['name'])
      : item.kind === 'lab_result' ? join(['test', 'value', 'unit', 'flag'])
        : item.kind === 'note' ? join(['text']) : item.asWritten;
  if (!text.trim()) text = item.asWritten;
  if (!isBlank(crossed) && !text.includes(CROSSED_OUT_OPEN)) text = `${text} ${CROSSED_OUT_OPEN}${crossed})`;
  return text.trim();
}

/**
 * A name grounded to its list (step 4 of the header): "As read? (listed name)" where listed and changed, as read
 * where it is the listed name, "As read? (or Listed?)" where a real unlisted look-alike is as near, as read
 * otherwise. Each side of "A (or B)" is grounded on its own; both standing for one listed name, it is said once after
 * them. "[?]", "[sign?]" and "(sign)" never match.
 */
function groundName(text: string, match: (name: string) => ListMatch | null, lookalike: (name: string) => string | null): string {
  const split = splitAlternative(text);
  if (split) {
    const [x, y] = split;
    const mx = match(x);
    const my = match(y);
    if (mx && my && mx.title === my.title) return `${x} ${ALTERNATIVE_OPEN}${y}) (${mx.title})`;
    return `${groundName(x, match, lookalike)} ${ALTERNATIVE_OPEN}${groundName(y, match, lookalike)})`;
  }
  const found = match(text);
  if (found) return found.display;
  const other = lookalike(text);
  return other ? alternatives(text, other) : text;
}

/** A hard-page item's fields with a diagnosis name or a lab test name grounded to its list (groundName). */
function groundedFields(item: PaperItem): PaperItem['fields'] {
  if (item.kind === 'diagnosis' && item.fields.name) {
    return { ...item.fields, name: groundName(item.fields.name, matchDiagnosisName, diagnosisLookalike) };
  }
  if (item.kind === 'lab_result' && item.fields.test) {
    return { ...item.fields, test: groundName(item.fields.test, matchLabTestName, labTestLookalike) };
  }
  return item.fields;
}

/** Whether the item holds a handwritten sign mark (signs.ts) in its asWritten or in any text field. */
function holdsSign(item: PaperItem): boolean {
  return hasSign(item.asWritten) || Object.values(item.fields as Record<string, unknown>)
    .some((value) => typeof value === 'string' && hasSign(value));
}

/** Whether any text of the item (plain, asWritten, a field, a date or prescriber) holds a "?" of any kind. */
export function hasQuestionMark(item: PaperItem): boolean {
  const texts = [item.plain, item.asWritten, item.dateAsWritten, item.prescription?.prescriberAsWritten,
    item.prescription?.dateAsWritten, ...Object.values(item.fields as Record<string, unknown>)];
  return texts.some((value) => typeof value === 'string' && value.includes('?'));
}

/** What finish shows besides the fields: the crossed-out writing and the lead-in words of a medicine. */
interface Shown { crossed: string; lead: string; described: boolean }

function shownOf(side: Side): Shown {
  const fields = side.item.fields as Record<string, unknown>;
  return { crossed: crossedOutOf(side.item.asWritten, side.extras?.crossedOut),
    lead: side.item.kind === 'medicine' ? leadIn(side.item.asWritten, [fields.route as string | null,
      side.extras?.proposedName, fields.name as string | null]) : '',
    described: side.extras?.described === true };
}

function finish(item: PaperItem, codes: readonly string[], sourceSha256Hex: string, shown: Shown): PaperItem {
  const checkReasons = [...item.checkReasons];
  const signs = holdsSign(item) ? [SIGN_READ] : [];
  const crossed = !isBlank(shown.crossed) || item.asWritten.includes(CROSSED_OUT_OPEN) ? [CROSSED_OUT] : [];
  const described = shown.described ? [DESCRIPTION_REPLACED] : [];
  const fields = groundedFields(item);
  for (const code of [...codes, ...described, ...crossed, ...signs, BEST_GUESS, 'read_from_image']) {
    if (!checkReasons.includes(code)) checkReasons.push(code);
  }
  // Every hard-page item, and so every item showing a "?", goes to a person to keep or change (owner decision of
  // 2026-11-06): check_carefully, whatever the reasons.
  return { ...item, fields, plain: hardPlain(item, fields, shown.crossed, shown.lead),
    id: itemId(sourceSha256Hex, item.kind, item.lineIds, item.asWritten), readBy: 'reread',
    confidence: 'check_carefully', checkReasons, checkReason: checkReasonSentence(checkReasons) } as PaperItem;
}

/** An item only one reading found (it passed every placement rule in its own reading). */
function single(side: Side, sourceSha256Hex: string): PaperItem {
  const item = { ...side.item, fields: { ...side.item.fields } } as PaperItem;
  return finish(item, [SINGLE_READING, ...(anyFromContext(side) ? [FROM_CONTEXT] : [])], sourceSha256Hex, shownOf(side));
}

/**
 * Two readings of one item, field by field after normalisation (bare: "?" marks, case and spacing aside):
 * - agreeing: the best guess, keeping "?" where either reading was unsure, and basis "context" where either said so;
 * - disagreeing (any text field: a drug name, a number, unit, route, frequency, any text): read A's guess, then read
 *   B's, "A? (or B?)", every word of both marked (alternatives); nothing becomes "[?]" for disagreeing. Read A is,
 *   field by field, the reading whose basis for that field is "letters" where the other's is not (so a guess from
 *   what is usual is only ever the second option), else the first reading. A field only one reading filled is that
 *   reading's, marked. The same listed medicine under two spellings respelled by the list is that medicine, marked
 *   "?", and still readings_disagree;
 * - a disagreeing medicine status becomes 'unknown', an allergy severity none (null), and a diagnosis keeps the
 *   first reading's status with readings_disagree.
 * The dose and unit of a medicine are compared apart (each counts as a field); the strength is rebuilt from the two
 * where they agree, else shown as each reading's strength, "500mg? (or 250mg?)". asWritten is merged word by word
 * (mergeAsWritten); crossed-out writing is kept from either reading ("A (or B)" where they differ; not tallied).
 */
function pair(a: Side, b: Side, sourceSha256Hex: string, tally: HardPageAgreement): PaperItem {
  let disagree = false;
  let context = false;
  const compare = (equal: boolean) => { tally.fieldsCompared += 1; if (equal) tally.fieldsAgreed += 1; else disagree = true; };
  /** Whether read B is read A for this field: its basis is "letters" where the first reading's is not. */
  const bLeads = (field: string) => {
    const key = basisKey(a.item.kind, field);
    return b.extras?.basis[key] === 'letters' && a.extras?.basis[key] !== 'letters';
  };
  const shownApart = (field: string, x: string | null, y: string | null) => bLeads(field) ? alternatives(y, x)
    : alternatives(x, y);
  const textField = (field: string, x: string | null, y: string | null): string | null => {
    if (fromContext(a, field, x) || fromContext(b, field, y)) context = true;
    if (isBlank(x) && isBlank(y)) { compare(true); return x; }
    const equal = bare(x) === bare(y);
    compare(equal);
    return equal ? keepUnsure(x, y) : shownApart(field, x, y);
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
      // by the fuzzy match: the readings disagree on the letters, but both stand for that one listed medicine, so it
      // is shown once, marked a guess (a real unlisted look-alike never matches: drug-list.ts UNLISTED_LOOKALIKES).
      const listedA = a.extras?.generic ?? null;
      const listedB = b.extras?.generic ?? null;
      const sameWriting = (a.extras?.nameExact === true && b.extras?.nameExact === true)
        || (a.extras?.proposedName !== undefined && a.extras.proposedName === b.extras?.proposedName);
      if (listedA !== null && listedA === listedB) {
        compare(sameWriting);
        if (fromContext(a, field, x) || fromContext(b, field, y)) context = true;
        const kept = keepUnsure(x as string | null, y as string | null);
        fields[field] = sameWriting ? kept : bare(x as string) === bare(y as string) ? markWords(kept ?? '')
          : shownApart(field, x as string | null, y as string | null);
      } else {
        fields[field] = textField(field, x as string | null, y as string | null);
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
    fields[field] = textField(field, x as string | null, y as string | null);
  }
  if (a.item.kind === 'medicine') {
    const doseA = a.extras?.dose ?? '';
    const doseB = b.extras?.dose ?? '';
    const unitA = a.extras?.doseUnit ?? '';
    const unitB = b.extras?.doseUnit ?? '';
    if (fromContext(a, 'strength', doseA) || fromContext(b, 'strength', doseB)
      || fromContext(a, 'unit', unitA) || fromContext(b, 'unit', unitB)) context = true;
    const doseAgrees = bare(doseA) === bare(doseB);
    const unitAgrees = bare(unitA) === bare(unitB);
    compare(doseAgrees);
    compare(unitAgrees);
    fields.strength = (doseAgrees && unitAgrees
      ? strengthOf(keepUnsure(doseA, doseB) ?? '', keepUnsure(unitA, unitB) ?? '')
      : shownApart('strength', strengthOf(doseA, unitA), strengthOf(doseB, unitB))) || null;
  }
  // A date or prescriber either reading filled from context is said by field_from_context (it carries no "?").
  if (anyFromContextOutside(a) || anyFromContextOutside(b)) context = true;
  const mergeText = (x: string | null, y: string | null) => isBlank(x) && isBlank(y) ? x
    : bare(x) === bare(y) ? keepUnsure(x, y) : alternatives(x, y);
  const prescriptionA = a.item.prescription;
  const prescriptionB = b.item.prescription;
  const prescription = prescriptionA === null && prescriptionB === null ? null : {
    prescriberAsWritten: mergeText(prescriptionA?.prescriberAsWritten ?? null, prescriptionB?.prescriberAsWritten ?? null),
    dateAsWritten: mergeText(prescriptionA?.dateAsWritten ?? null, prescriptionB?.dateAsWritten ?? null) };
  const asWritten = bare(a.item.asWritten) === bare(b.item.asWritten) ? keepUnsure(a.item.asWritten, b.item.asWritten)!
    : mergeAsWritten(a.item.asWritten, b.item.asWritten);
  const shownA = shownOf(a);
  const shownB = shownOf(b);
  const crossed = isBlank(shownA.crossed) && isBlank(shownB.crossed) ? ''
    : bare(shownA.crossed) === bare(shownB.crossed) ? keepUnsure(shownA.crossed, shownB.crossed) ?? ''
      : alternatives(shownA.crossed, shownB.crossed);
  if (bare(shownA.crossed) !== bare(shownB.crossed)) disagree = true;
  const lineIds = [...new Set([...a.item.lineIds, ...b.item.lineIds])].sort((x, y) => lineNumber(x) - lineNumber(y));
  const reasons = [...a.item.checkReasons, ...b.item.checkReasons.filter((code) => !a.item.checkReasons.includes(code))];
  const merged = { ...a.item, asWritten, lineIds, box: unionBox([a.item.box, b.item.box]) ?? a.item.box,
    dateAsWritten: mergeText(a.item.dateAsWritten, b.item.dateAsWritten), fields,
    prescription: a.item.kind === 'medicine' ? prescription : null, checkReasons: reasons } as PaperItem;
  const lead = merged.kind === 'medicine' ? shownA.lead || shownB.lead : '';
  tally.itemsPaired += 1;
  return finish(merged, [...(disagree ? [READINGS_DISAGREE] : []), ...(context ? [FROM_CONTEXT] : [])], sourceSha256Hex,
    { crossed, lead, described: shownA.described || shownB.described });
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
 * single_reading_only items (a safe duplicate: merging them would show every field the other half fills as a
 * disagreement, and a lone name beside a full order would swallow that order).
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
