import type { Box, FlagReason, PaperItem } from './contract';
import { matchDrugName } from './drug-list';
import { checkReasonSentence, itemId, mergeIdentity, unionBox, uniqueItemIds, type PageCheck } from './items';
import { HARD_PAGE_FREQUENCIES, UNREADABLE, type BasisField, type HardItemExtras, type ModelItem,
  type ModelPage } from './prompt';

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
 *    be taken into the record, so only the field is held to the list.
 * 2. Each answer is held to the page by checkPage (items.ts), unchanged: #194's placement rules apply to every item.
 * 3. mergeHardReadings pairs the kept items of the two readings and keeps what they agree on (see there).
 * The result is then merged with the first pass by mergeReread, unchanged, so no first-pass item is lost.
 */

/** Reason codes added to hard-page items (sentences in items.ts REASON_SENTENCES). */
export const BEST_GUESS = 'best_guess_from_picture';
export const FROM_CONTEXT = 'field_from_context';
export const SINGLE_READING = 'single_reading_only';
export const READINGS_DISAGREE = 'readings_disagree';

const ALLOWED_FREQUENCIES = new Set<string>(HARD_PAGE_FREQUENCIES);
const unsure = (text: string) => text.includes('?');
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

/** Step 1 (see the header). Items without hard-page extras are left as they are. */
export function prepareHardAnswer(answer: ModelPage): ModelPage {
  return { ...answer, items: answer.items.map((item): ModelItem => {
    if (!item.hard) return item;
    const frequency = normaliseFrequency(item.frequency);
    if (item.kind !== 'medicine') return { ...item, frequency };
    const dose = normaliseDose(item.hard.dose);
    const doseUnit = item.hard.doseUnit.trim();
    const proposed = item.name.trim();
    const match = proposed ? matchDrugName(proposed) : null;
    return { ...item, frequency, strength: strengthOf(dose, doseUnit),
      name: proposed ? match?.display ?? UNREADABLE : '',
      hard: { ...item.hard, dose, doseUnit, generic: match?.generic ?? null } };
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
  return (b!.match(/\?/g)?.length ?? 0) > (a!.match(/\?/g)?.length ?? 0) ? b : a;
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

function anyFromContext(side: Side): boolean {
  const fields = side.item.fields as Record<string, unknown>;
  return Object.entries(fields).some(([field, value]) => fromContext(side, field, value));
}

/** The plain reading of a hard-page medicine, built only from its final fields (never the model's own guesses). */
function medicinePlain(fields: Record<string, unknown>): string {
  return ['name', 'strength', 'route', 'frequency', 'duration'].map((key) => fields[key])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '').join(' ');
}

function finish(item: PaperItem, codes: readonly string[], sourceSha256Hex: string): PaperItem {
  const checkReasons = [...item.checkReasons];
  for (const code of [...codes, BEST_GUESS, 'read_from_image']) if (!checkReasons.includes(code)) checkReasons.push(code);
  return { ...item, id: itemId(sourceSha256Hex, item.kind, item.lineIds, item.asWritten), readBy: 'reread',
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
      // The same listed medicine under two spellings (a brand and its generic) is agreement.
      const listedA = a.extras?.generic ?? null;
      const listedB = b.extras?.generic ?? null;
      if (listedA !== null && listedA === listedB) {
        compare(true);
        if (fromContext(a, field, x) || fromContext(b, field, y)) context = true;
        fields[field] = keepUnsure(x as string | null, y as string | null);
      } else {
        fields[field] = textField(field, x as string | null, y as string | null, listedA !== null && listedB !== null);
      }
      continue;
    }
    if (field === 'status' || field === 'severity' || field === 'measure' || field === 'noKnownAllergies') {
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

/**
 * The hard page's reading from its two readings (or from one, when the other failed or was declined: every item
 * then single_reading_only). Items are paired one to one by kind and place (a shared cited line, or boxes
 * overlapping by PAIR_BOX_OVERLAP of the smaller), best pairs first; each pair is merged by `pair`, and an item only
 * one reading found is kept with single_reading_only. Every item: check_carefully, readBy 'reread', read_from_image
 * and best_guess_from_picture, plus field_from_context where any field's basis was context. Identity is merged as in
 * mergeIdentity (a conflict flags the page ai_unsure); the page flags are both readings' flags; the dropped counts are
 * the first reading's (the one the page is held to first), or the only reading's.
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
