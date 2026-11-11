/**
 * OCR learning, phase 2 (owner decision Q43 of 2026-11-11; migrations 0118 and 0119). From an accepted review,
 * ocr-api derives one observation per corrected field of a linked reading item: a digest of the value the reading
 * gave (the text never leaves this process) and the value the reviewer saved when it is a value of a closed list
 * (else NULL: a conflict). The database switches a rule on by itself after 5 identical corrections from 3 staff with
 * no conflict, and ocr-api shows an active rule as a plain suggestion beside the field, "Possibly X? Check the paper".
 * The saved value never changes, the suggestion never goes into the reader's prompt, and a document holding a
 * sensitive item (sensitive-classes.ts) neither teaches nor shows anything.
 *
 * Only linked items teach: Pharmacy medicines (name, strength, frequency) and Lab results (test name, unit) saved
 * with their itemId. An item saved unchanged is neither support nor conflict and is not sent. EHR notes (whole
 * text) and unlinked entries teach nothing. 'diagnosis' is reserved: no review links a diagnosis yet.
 */
import { createHash } from 'node:crypto';
import { matchDrugName } from './lists/drug-list';
import { matchLabTestName } from './lists/lab-list';
import { FREQUENCY_TABLE, normFrequency, normName, normStrength, normText } from '../quality/normalise';
import { readingIsSensitive, valueIsSensitive } from './sensitive-classes';

export const LEARNING_DIGEST_PREFIX = 'hid.ocr.learning/v1';
export const LEARNING_FIELDS = ['name', 'strength', 'frequency', 'test', 'unit', 'diagnosis'] as const;
export type LearningField = (typeof LEARNING_FIELDS)[number];

/** 0118's constraint on a stored value. */
const STORED_VALUE = /^[A-Za-z0-9][A-Za-z0-9 .,+/%()'-]*$/;
const STRENGTH = /^\d+(?:\.\d+)?(?:mcg|mg|g|ml|iu|%)(?:\/\d*(?:\.\d+)?(?:mcg|mg|g|ml))?$/;
/** Lab units a value may be saved in (after normStrength's unit spellings; spaces removed). */
export const LAB_UNITS: ReadonlySet<string> = new Set(['g/dl', 'g/l', 'mg/dl', 'mg/l', 'mmol/l', 'umol/l', 'iu/l',
  'u/l', 'iu/ml', '%', 'fl', 'pg', 'x10^9/l', 'x10^12/l', 'cells/ul', '/ul', '/hpf', 'mm/hr', 'mm/h', 'meq/l',
  'ng/ml', 'pg/ml', 'miu/ml', 'uiu/ml', 'mg', 'g', 'ml', 'sec', 's', 'ratio']);

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The value a reading gave, normalised for the field (what the digest is made of). */
export function readKey(field: LearningField, value: unknown): string {
  if (typeof value !== 'string') return '';
  switch (field) {
    case 'name': return normName(value);
    case 'strength': return normStrength(value).replace(/\s+/g, '');
    case 'frequency': return normFrequency(value);
    case 'unit': return normStrength(value).replace(/\s+/g, '');
    default: return normText(value);
  }
}

/** SHA-256 hex of the prefix, the field and the normalised value read (0118's read_digest). */
export function readDigest(field: LearningField, key: string): string {
  return createHash('sha256').update(`${LEARNING_DIGEST_PREFIX}|${field}|${key}`, 'utf8').digest('hex');
}

/**
 * The closed-list value a saved field stands for, or null when it is not one (then the observation is a conflict).
 * Exact list matches only: a value the reviewer typed is never respelled into another.
 */
export function listValue(field: LearningField, saved: unknown): string | null {
  if (typeof saved !== 'string' || !saved.trim()) return null;
  let value: string | null = null;
  switch (field) {
    case 'name': {
      const match = matchDrugName(saved);
      value = match?.exact ? capitalise(match.brand ?? match.generic) : null;
      break;
    }
    case 'strength': {
      const strength = normStrength(saved).replace(/\s+/g, '');
      value = STRENGTH.test(strength) ? strength : null;
      break;
    }
    case 'frequency': {
      const code = normFrequency(saved);
      value = Object.hasOwn(FREQUENCY_TABLE, code) ? code : null;
      break;
    }
    case 'test': {
      const match = matchLabTestName(saved);
      value = match?.exact ? capitalise(match.title) : null;
      break;
    }
    case 'unit': {
      const unit = normStrength(saved).replace(/\s+/g, '');
      value = LAB_UNITS.has(unit) ? unit : null;
      break;
    }
    default: value = null;
  }
  return value !== null && value.length <= 120 && STORED_VALUE.test(value) ? value : null;
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ReadingItemLike { id: string | null; kind: string; fields: Rec }

/** The reading items of a stored payload, as far as learning needs them. */
export function learningItems(payload: unknown): (ReadingItemLike & { raw: Rec })[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  return payload.items.filter(isRecord).map((item) => ({ raw: item,
    id: typeof item.id === 'string' ? item.id : null, kind: typeof item.kind === 'string' ? item.kind : 'other',
    fields: isRecord(item.fields) ? item.fields : {} }));
}

/** The reading fields learning looks at, per item kind: [field class, reading field name]. */
const READ_FIELDS: Readonly<Record<string, readonly (readonly [LearningField, string])[]>> = {
  medicine: [['name', 'name'], ['strength', 'strength'], ['frequency', 'frequency']],
  lab_result: [['test', 'test'], ['unit', 'unit']],
};

/** One field of a linked item: what the reading gave and what the reviewer saved. */
export interface FieldPair { itemId: string; field: LearningField; read: unknown; saved: unknown }

/** The linked field pairs of a review (Pharmacy medicines and Lab results with their itemId). */
export function linkedFieldPairs(targetDomain: string, acceptedFields: unknown, payload: unknown): FieldPair[] {
  const fields = isRecord(acceptedFields) ? acceptedFields : {};
  const items = new Map(learningItems(payload).filter((item) => item.id !== null)
    .map((item) => [item.id as string, item]));
  const pairs: FieldPair[] = [];
  const entries = (list: unknown) => (Array.isArray(list) ? list.filter(isRecord) : []);
  if (targetDomain === 'PHARMACY') {
    for (const entry of entries(fields.medications)) {
      const item = typeof entry.itemId === 'string' ? items.get(entry.itemId) : undefined;
      if (!item || item.kind !== 'medicine') continue;
      pairs.push({ itemId: item.id as string, field: 'name', read: item.fields.name, saved: entry.medicationText },
        { itemId: item.id as string, field: 'strength', read: item.fields.strength, saved: entry.strengthText },
        { itemId: item.id as string, field: 'frequency', read: item.fields.frequency, saved: entry.frequencyText });
    }
  } else if (targetDomain === 'LAB') {
    for (const entry of entries(fields.observations)) {
      const item = typeof entry.itemId === 'string' ? items.get(entry.itemId) : undefined;
      if (!item || item.kind !== 'lab_result') continue;
      pairs.push({ itemId: item.id as string, field: 'test', read: item.fields.test, saved: entry.testName },
        { itemId: item.id as string, field: 'unit', read: item.fields.unit, saved: entry.unit });
    }
  }
  return pairs;
}

export interface Observation { field: LearningField; readDigest: string; suggestValue: string | null }

/**
 * Whether anything a review saved is sensitive: any text in its accepted fields, linked or not (an ARV the reviewer
 * typed in as a new line makes the whole document sensitive). Then the review teaches nothing.
 */
export function acceptedFieldsAreSensitive(acceptedFields: unknown): boolean {
  const texts: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (texts.length > 2000 || depth > 6) return;
    if (typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) value.forEach((entry) => walk(entry, depth + 1));
    else if (isRecord(value)) Object.values(value).forEach((entry) => walk(entry, depth + 1));
  };
  walk(acceptedFields, 0);
  return texts.some(valueIsSensitive);
}

/** Whether any value of a review is sensitive (what was read or what was saved): then the review teaches nothing. */
export function pairsAreSensitive(pairs: readonly FieldPair[]): boolean {
  return pairs.some((pair) => valueIsSensitive(pair.read) || valueIsSensitive(pair.saved));
}

/**
 * The observations of a review: each corrected field once per key. Not sent: a field saved unchanged (also when the
 * saved value is another spelling of the same list entry, a synonym), and a field where a suggestion was shown (an
 * accepted suggestion is a showing, not new evidence, so a rule never feeds itself). Two items with one key saved to
 * different values (or one to a value off the lists) are one conflict.
 */
export function observationsFor(pairs: readonly FieldPair[],
  shown: ReadonlyMap<string, ItemSuggestion> = new Map()): Observation[] {
  const byKey = new Map<string, Observation>();
  for (const pair of pairs) {
    if (shown.get(pair.itemId)?.field === pair.field) continue;
    const key = readKey(pair.field, pair.read);
    if (!key) continue;
    if (readKey(pair.field, pair.saved) === key) continue;
    const readList = listValue(pair.field, pair.read);
    const suggestValue = listValue(pair.field, pair.saved);
    if (readList !== null && readList === suggestValue) continue;
    const digest = readDigest(pair.field, key);
    const previous = byKey.get(`${pair.field}|${digest}`);
    if (previous) {
      if (previous.suggestValue !== suggestValue) previous.suggestValue = null;
      continue;
    }
    byKey.set(`${pair.field}|${digest}`, { field: pair.field, readDigest: digest, suggestValue });
  }
  return [...byKey.values()].slice(0, 200);
}

/** One key of a reading to look a suggestion up for, with the item and field it belongs to. */
export interface SuggestionKey { itemId: string; field: LearningField; readDigest: string }

/** The suggestion keys of a reading's items (medicines and lab results). */
export function suggestionKeys(payload: unknown): SuggestionKey[] {
  const keys: SuggestionKey[] = [];
  for (const item of learningItems(payload)) {
    if (item.id === null) continue;
    for (const [field, name] of READ_FIELDS[item.kind] ?? []) {
      const key = readKey(field, item.fields[name]);
      if (key) keys.push({ itemId: item.id, field, readDigest: readDigest(field, key) });
    }
  }
  return keys.slice(0, 500);
}

/** An active rule for a key, as ocr.reading_suggestions (0119) answers it. */
export interface RuleSuggestion { field: LearningField; readDigest: string; ruleId: string; scope: 'facility' | 'platform';
  value: string }

/** The suggestion an item shows: one field, the list value, the sentence. */
export interface ItemSuggestion { field: LearningField; value: string; text: string; ruleId: string;
  scope: 'facility' | 'platform' }

const SHOW_ORDER: readonly LearningField[] = ['name', 'test', 'strength', 'frequency', 'unit', 'diagnosis'];

/** The one suggestion each item shows (name first, then test, strength, frequency, unit), by item id. */
export function itemSuggestions(keys: readonly SuggestionKey[], rules: readonly RuleSuggestion[]):
  Map<string, ItemSuggestion> {
  const byKey = new Map(rules.map((rule) => [`${rule.field}|${rule.readDigest}`, rule]));
  const shown = new Map<string, ItemSuggestion>();
  const ordered = [...keys].sort((a, b) => SHOW_ORDER.indexOf(a.field) - SHOW_ORDER.indexOf(b.field));
  for (const key of ordered) {
    if (shown.has(key.itemId)) continue;
    const rule = byKey.get(`${key.field}|${key.readDigest}`);
    // A sensitive value is never suggested, whatever a rule holds.
    if (rule && !valueIsSensitive(rule.value)) {
      shown.set(key.itemId, { field: rule.field, value: rule.value, ruleId: rule.ruleId, scope: rule.scope,
        text: `Possibly ${rule.value}? Check the paper` });
    }
  }
  return shown;
}

/**
 * Whether staff took each suggestion that was shown on a linked item: taken when the saved value is the suggested
 * list value. One outcome per rule (not taken wins: the database records one showing per rule and validation).
 */
export function showingsFor(pairs: readonly FieldPair[], shown: ReadonlyMap<string, ItemSuggestion>):
  { ruleId: string; outcome: 'accepted' | 'rejected' }[] {
  const outcomes = new Map<string, 'accepted' | 'rejected'>();
  for (const pair of pairs) {
    const suggestion = shown.get(pair.itemId);
    if (!suggestion || suggestion.field !== pair.field) continue;
    const taken = listValue(pair.field, pair.saved) === suggestion.value;
    if (outcomes.get(suggestion.ruleId) !== 'rejected') {
      outcomes.set(suggestion.ruleId, taken ? 'accepted' : 'rejected');
    }
  }
  return [...outcomes].map(([ruleId, outcome]) => ({ ruleId, outcome })).slice(0, 200);
}

/** The text of a reading's page lines (and page text), for the sensitive-word check. */
function pageTexts(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.pages)) return [];
  return payload.pages.filter(isRecord).flatMap((page) => [
    ...(typeof page.text === 'string' ? [page.text] : []),
    ...(Array.isArray(page.lines) ? page.lines.filter(isRecord).map((line) => line.text)
      .filter((text): text is string => typeof text === 'string') : []),
  ]);
}

/** Whether a reading may teach and show suggestions (no sensitive item or page line on it). */
export function readingMayLearn(payload: unknown): boolean {
  return !readingIsSensitive(learningItems(payload).map((item) => item.raw), pageTexts(payload));
}
