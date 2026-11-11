/**
 * The review outcome: how a person's review compared with the AI reading of the same paper, as counts and codes
 * only. It is stored in ocr.validations.provenance.reviewOutcome and in the ocr.validation.accept / .reject audit
 * details, so the reading can be measured (and later improved) without keeping any patient text: no names, values,
 * text, item ids or reviewer identifiers ever enter it. Text from the reading and the review is compared here, in
 * memory, and dropped.
 */
import { normFrequency, normName, normStrength, normText, onPage } from './normalise';

export const REVIEW_OUTCOME_SCHEMA = 'hid.ocr.review-outcome/v1';

/** The field classes a change is counted under (computed, or named by the reviewer in corrections[].fields). */
export const FIELD_CLASSES = ['name', 'strength', 'dose', 'frequency', 'route', 'duration', 'date', 'value',
  'unit'] as const;
export type FieldClass = (typeof FIELD_CLASSES)[number];

/** Why the reviewer left out an item the reading found. */
export const REMOVAL_REASONS = ['not_on_paper', 'duplicate', 'not_needed', 'unreadable', 'other_patient'] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

/** Why the reviewer changed an item: the reading got the paper wrong, or the paper is right but out of date. */
export const CHANGE_REASONS = ['misread', 'clinical_update'] as const;
export type ChangeReason = (typeof CHANGE_REASONS)[number];

/**
 * Why a whole document was rejected:
 * wrong_patient (the paper is another patient's), wrong_document (not the document it was filed as),
 * unreadable (the scan cannot be read by a person either), duplicate_document (already imported),
 * pages_missing (incomplete scan), reading_unusable (the AI reading was too wrong to correct),
 * not_clinical (nothing clinical to import), other.
 */
export const REJECTION_REASON_CODES = ['wrong_patient', 'wrong_document', 'unreadable', 'duplicate_document',
  'pages_missing', 'reading_unusable', 'not_clinical', 'other'] as const;
export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];

/**
 * kept_unchanged / kept_changed / removed / added_by_reviewer: an item linked by itemId (or typed by the reviewer).
 * unlinked: the reviewer saved whole text without item links (an EHR note, the legacy single medicine, a list with
 * no itemId), so per-item decisions are not known; the summary is marked estimated and carries `estimate` instead.
 * not_in_target: a reading item of a kind the review's domain does not take (a diagnosis in a Pharmacy review).
 * rejected_with_document: the whole document was rejected.
 */
export const DECISIONS = ['kept_unchanged', 'kept_changed', 'removed', 'added_by_reviewer', 'unlinked',
  'not_in_target', 'rejected_with_document'] as const;
export type Decision = (typeof DECISIONS)[number];

const KINDS = ['medicine', 'diagnosis', 'allergy', 'note', 'lab_result', 'vital'] as const;
type Kind = (typeof KINDS)[number] | 'other';

export interface OutcomeBucket {
  kind: Kind;
  decision: Decision;
  confidence: 'clear' | 'check_carefully' | 'none' | 'unknown';
  hardPage: boolean;
  readBy: 'first_pass' | 'reread' | 'none' | 'unknown';
  items: number;
  /** Items in this bucket carrying each check reason code (an item may carry several). */
  checkReasons: Record<string, number>;
  /** Items in this bucket with a change in each field class. */
  fieldChanges: Partial<Record<FieldClass, number>>;
}

export interface ReviewOutcome {
  schema: typeof REVIEW_OUTCOME_SCHEMA;
  disposition: 'validated' | 'rejected';
  targetDomain: string;
  promptVersion: string | null;
  processingContract: string | null;
  readingStatus: string | null;
  /** item_ids: decisions per linked item; estimated: whole text saved, see `estimate`; none: nothing to compare. */
  linkage: 'item_ids' | 'estimated' | 'none';
  estimated: boolean;
  totals: { read: number; keptUnchanged: number; keptChanged: number; removed: number; addedByReviewer: number;
    unlinked: number; notInTarget: number; rejectedWithDocument: number };
  /** With estimated: reading items of the target kinds whose words were / were not found in the saved text. */
  estimate?: { foundInSavedText: number; notFoundInSavedText: number };
  buckets: OutcomeBucket[];
  reviewer: {
    reviewConfirmed: boolean | null;
    missedItems: number | null;
    corrections: number;
    correctionFields: Partial<Record<FieldClass, number>>;
    changeReasons: Partial<Record<ChangeReason, number>>;
    removalReasons: Partial<Record<RemovalReason, number>>;
    rejectionReasonCode: RejectionReasonCode | null;
  };
}

export interface ReviewOutcomeFailure { schema: typeof REVIEW_OUTCOME_SCHEMA; error: 'summary_failed' }

export interface ReviewOutcomeInput {
  disposition: 'validated' | 'rejected';
  targetDomain: string;
  acceptedFields: Record<string, unknown>;
  corrections: readonly Record<string, unknown>[];
  reviewConfirmed?: boolean;
  missedItems?: number;
  removedItems?: readonly { itemId: string; removalReason: string }[];
  rejectionReasonCode?: string;
  /** ocr.extractions.structured_payload of the reviewed extraction (undefined when it could not be read). */
  structuredPayload: unknown;
  /** ocr.extractions.provenance of the reviewed extraction. */
  extractionProvenance: unknown;
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,119}$/;
const MAX_CODES_PER_BUCKET = 40;

const versionOrNull = (value: unknown): string | null =>
  typeof value === 'string' && VERSION.test(value) ? value : null;
const codeOrNull = (value: unknown): string | null => (typeof value === 'string' && CODE.test(value) ? value : null);
const has = (value: unknown): boolean => normText(value) !== '';

interface ReadItem {
  id: string | null; kind: Kind; page: number | null; confidence: OutcomeBucket['confidence'];
  readBy: OutcomeBucket['readBy']; checkReasons: string[]; fields: Rec; asWritten: unknown; plain: unknown;
  dateAsWritten: unknown;
}

function readItems(payload: unknown): ReadItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  return payload.items.filter(isRecord).map((item) => ({
    id: typeof item.id === 'string' ? item.id : null,
    kind: (KINDS as readonly string[]).includes(item.kind as string) ? item.kind as Kind : 'other',
    page: typeof item.page === 'number' && Number.isInteger(item.page) ? item.page : null,
    confidence: item.confidence === 'clear' || item.confidence === 'check_carefully' ? item.confidence : 'unknown',
    readBy: item.readBy === 'first_pass' || item.readBy === 'reread' ? item.readBy : 'unknown',
    checkReasons: Array.isArray(item.checkReasons)
      ? [...new Set(item.checkReasons.map((code) => (typeof code === 'string' && CODE.test(code) ? code : 'other')))]
      : [],
    fields: isRecord(item.fields) ? item.fields : {},
    asWritten: item.asWritten, plain: item.plain, dateAsWritten: item.dateAsWritten,
  }));
}

/** One reviewer entry taken from (or typed in place of) a reading item, in the shape the comparison needs. */
interface KeptEntry { itemId: string | null; page: number | null; compare: (item: ReadItem) => FieldClass[] }

function differs(normalise: (value: unknown) => string, read: unknown, kept: unknown): boolean {
  return normalise(read) !== normalise(kept);
}

interface KeptShape { linked: KeptEntry[] | null; wholeText: string[]; typed?: KeptEntry[] }

function medicineEntries(fields: Rec): KeptShape {
  if (!Array.isArray(fields.medications)) {
    // The legacy single medicine: five text fields, no item link.
    const text = ['medicationText', 'strengthText', 'doseText', 'frequencyText']
      .map((name) => fields[name]).filter((value): value is string => typeof value === 'string');
    return { linked: null, wholeText: text.length ? [text.join(' ')] : [] };
  }
  const entries = fields.medications.filter(isRecord);
  const linked = entries.map((entry): KeptEntry => ({
    itemId: typeof entry.itemId === 'string' ? entry.itemId : null,
    page: typeof entry.page === 'number' ? entry.page : null,
    compare: (item) => {
      const changes: FieldClass[] = [];
      if (differs(normName, item.fields.name, entry.medicationText)) changes.push('name');
      if (differs(normStrength, item.fields.strength, entry.strengthText)) changes.push('strength');
      if (differs(normFrequency, item.fields.frequency, entry.frequencyText)) changes.push('frequency');
      // The reading has no dose field: a dose the reviewer wrote is counted only when named in corrections[].fields.
      return changes;
    },
  }));
  if (entries.some((entry) => typeof entry.itemId === 'string')) return { linked, wholeText: [] };
  return { linked: null, typed: linked, wholeText: entries.map((entry) => [entry.medicationText, entry.strengthText,
    entry.frequencyText].filter((value) => typeof value === 'string').join(' ')) };
}

function labEntries(fields: Rec): KeptShape {
  const entries = Array.isArray(fields.observations) ? fields.observations.filter(isRecord) : [];
  const linked = entries.map((entry): KeptEntry => ({
    itemId: typeof entry.itemId === 'string' ? entry.itemId : null,
    page: typeof entry.page === 'number' ? entry.page : null,
    compare: (item) => {
      const changes: FieldClass[] = [];
      if (differs(normText, item.fields.test, entry.testName)) changes.push('name');
      if (differs(normStrength, item.fields.value, entry.value ?? entry.valueText)) changes.push('value');
      if (differs(normStrength, item.fields.unit, entry.unit)) changes.push('unit');
      const keptDate = entry.reportedAtAsWritten ?? entry.reportedAt;
      if ((has(keptDate) || has(item.dateAsWritten)) && differs(normText, item.dateAsWritten, keptDate)) {
        changes.push('date');
      }
      return changes;
    },
  }));
  if (entries.some((entry) => typeof entry.itemId === 'string')) return { linked, wholeText: [] };
  return { linked: null, typed: linked, wholeText: entries.map((entry) => [entry.testName, entry.value,
    entry.valueText, entry.unit].filter((value) => typeof value === 'string').join(' ')) };
}

/** The reading item kinds each domain takes, and what the reviewer kept of them. */
function keptFor(domain: string, fields: Rec): {
  kinds: readonly Kind[]; linked: KeptEntry[] | null; wholeText: string[]; typed: KeptEntry[];
} {
  if (domain === 'PHARMACY') {
    const result = medicineEntries(fields);
    return { kinds: ['medicine'], linked: result.linked, wholeText: result.wholeText, typed: result.typed ?? [] };
  }
  if (domain === 'LAB') {
    const result = labEntries(fields);
    return { kinds: ['lab_result'], linked: result.linked, wholeText: result.wholeText, typed: result.typed ?? [] };
  }
  if (domain === 'EHR') {
    // A note is saved as one block of text: every reading item could be in it, none is linked.
    const text = [fields.title, fields.content].filter((value): value is string => typeof value === 'string');
    return { kinds: [...KINDS, 'other'], linked: null, wholeText: text.join('\n').split(/\r?\n/), typed: [] };
  }
  return { kinds: [], linked: null, wholeText: [], typed: [] };
}

function bump<Key extends string>(record: Partial<Record<Key, number>>, key: Key, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

/** Computes the review outcome. Throws on nothing it is given; use safeReviewOutcome where a save must go on. */
export function computeReviewOutcome(input: ReviewOutcomeInput): ReviewOutcome {
  const provenance = isRecord(input.extractionProvenance) ? input.extractionProvenance : {};
  const reading = isRecord(provenance.reading) ? provenance.reading : {};
  const payload = isRecord(input.structuredPayload) ? input.structuredPayload : {};
  const payloadReading = isRecord(payload.reading) ? payload.reading : {};
  const hardPages = new Set((Array.isArray(reading.hardPages) ? reading.hardPages : [])
    .filter((page): page is number => typeof page === 'number'));
  const items = readItems(payload);
  const buckets = new Map<string, OutcomeBucket>();
  const totals = { read: items.length, keptUnchanged: 0, keptChanged: 0, removed: 0, addedByReviewer: 0,
    unlinked: 0, notInTarget: 0, rejectedWithDocument: 0 };
  const totalKey: Record<Decision, keyof typeof totals> = { kept_unchanged: 'keptUnchanged',
    kept_changed: 'keptChanged', removed: 'removed', added_by_reviewer: 'addedByReviewer', unlinked: 'unlinked',
    not_in_target: 'notInTarget', rejected_with_document: 'rejectedWithDocument' };

  const add = (kind: Kind, decision: Decision, item: ReadItem | null, page: number | null,
    changes: readonly FieldClass[] = []) => {
    const confidence = item ? item.confidence : 'none';
    const readBy = item ? item.readBy : 'none';
    const hardPage = page !== null && hardPages.has(page);
    const key = [kind, decision, confidence, hardPage, readBy].join('|');
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { kind, decision, confidence, hardPage, readBy, items: 0, checkReasons: {}, fieldChanges: {} };
      buckets.set(key, bucket);
    }
    bucket.items += 1;
    for (const code of item?.checkReasons ?? []) {
      const known = code in bucket.checkReasons || Object.keys(bucket.checkReasons).length < MAX_CODES_PER_BUCKET;
      bump(bucket.checkReasons, known ? code : 'other');
    }
    for (const field of new Set(changes)) bump(bucket.fieldChanges, field);
    totals[totalKey[decision]] += 1;
  };

  // Field classes the reviewer named against an item (corrections[].itemId + fields), and reviewer counts.
  const reviewer: ReviewOutcome['reviewer'] = {
    reviewConfirmed: typeof input.reviewConfirmed === 'boolean' ? input.reviewConfirmed : null,
    missedItems: typeof input.missedItems === 'number' ? input.missedItems : null,
    corrections: input.corrections.length, correctionFields: {}, changeReasons: {}, removalReasons: {},
    rejectionReasonCode: (REJECTION_REASON_CODES as readonly string[]).includes(input.rejectionReasonCode ?? '')
      ? input.rejectionReasonCode as RejectionReasonCode : null,
  };
  const namedChanges = new Map<string, FieldClass[]>();
  for (const correction of input.corrections) {
    const fields = Array.isArray(correction.fields) ? correction.fields
      .filter((field): field is FieldClass => (FIELD_CLASSES as readonly string[]).includes(field as string)) : [];
    for (const field of new Set(fields)) bump(reviewer.correctionFields, field);
    if ((CHANGE_REASONS as readonly string[]).includes(correction.changeReason as string)) {
      bump(reviewer.changeReasons, correction.changeReason as ChangeReason);
    }
    if (typeof correction.itemId === 'string' && fields.length) {
      namedChanges.set(correction.itemId, [...(namedChanges.get(correction.itemId) ?? []), ...fields]);
    }
  }
  for (const removed of input.removedItems ?? []) {
    if ((REMOVAL_REASONS as readonly string[]).includes(removed.removalReason)) {
      bump(reviewer.removalReasons, removed.removalReason as RemovalReason);
    }
  }

  let linkage: ReviewOutcome['linkage'] = 'none';
  let estimate: ReviewOutcome['estimate'];
  if (input.disposition === 'rejected') {
    for (const item of items) add(item.kind, 'rejected_with_document', item, item.page);
  } else {
    const kept = keptFor(input.targetDomain, isRecord(input.acceptedFields) ? input.acceptedFields : {});
    const inTarget = (item: ReadItem) => kept.kinds.includes(item.kind);
    for (const item of items.filter((candidate) => !inTarget(candidate))) {
      add(item.kind, 'not_in_target', item, item.page);
    }
    const targetItems = items.filter(inTarget);
    if (kept.linked) {
      linkage = 'item_ids';
      const byId = new Map(targetItems.filter((item) => item.id !== null).map((item) => [item.id as string, item]));
      const used = new Set<string>();
      for (const entry of kept.linked) {
        const item = entry.itemId === null ? undefined : byId.get(entry.itemId);
        if (!item || used.has(entry.itemId as string)) {
          add(kept.kinds[0] ?? 'other', 'added_by_reviewer', null, entry.page);
          continue;
        }
        used.add(entry.itemId as string);
        const changes = [...entry.compare(item), ...(namedChanges.get(entry.itemId as string) ?? [])];
        add(item.kind, changes.length ? 'kept_changed' : 'kept_unchanged', item, item.page, changes);
      }
      for (const item of targetItems) if (item.id === null || !used.has(item.id)) add(item.kind, 'removed', item, item.page);
    } else if (targetItems.length === 0) {
      // Nothing read of these kinds (AI reading off, failed, or it found none): every kept entry was typed.
      linkage = kept.typed.length ? 'item_ids' : 'none';
      for (const entry of kept.typed) add(kept.kinds[0] ?? 'other', 'added_by_reviewer', null, entry.page);
    } else {
      linkage = 'estimated';
      estimate = { foundInSavedText: 0, notFoundInSavedText: 0 };
      for (const item of targetItems) {
        const probe = item.kind === 'medicine' ? item.fields.name ?? item.asWritten
          : item.kind === 'lab_result' ? item.fields.test ?? item.asWritten : item.asWritten;
        const found = kept.wholeText.length > 0 && (onPage(probe, kept.wholeText) || onPage(item.plain, kept.wholeText));
        if (found) estimate.foundInSavedText += 1; else estimate.notFoundInSavedText += 1;
        add(item.kind, 'unlinked', item, item.page);
      }
    }
  }

  return {
    schema: REVIEW_OUTCOME_SCHEMA,
    disposition: input.disposition,
    targetDomain: input.targetDomain,
    promptVersion: versionOrNull(reading.promptVersion) ?? versionOrNull(payloadReading.promptVersion),
    processingContract: versionOrNull(provenance.processingContract),
    readingStatus: codeOrNull(reading.status) ?? codeOrNull(payloadReading.status),
    linkage,
    estimated: linkage === 'estimated',
    totals,
    ...(estimate ? { estimate } : {}),
    buckets: [...buckets.values()],
    reviewer,
  };
}

/** The review outcome, or a failure code: computing it must never stop a review being saved. */
export function safeReviewOutcome(input: ReviewOutcomeInput,
  compute: (value: ReviewOutcomeInput) => ReviewOutcome = computeReviewOutcome): ReviewOutcome | ReviewOutcomeFailure {
  try {
    return compute(input);
  } catch {
    return { schema: REVIEW_OUTCOME_SCHEMA, error: 'summary_failed' };
  }
}
