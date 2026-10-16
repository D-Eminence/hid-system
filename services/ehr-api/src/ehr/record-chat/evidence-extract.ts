import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { PatientLabResult, PatientReleasedRecords } from '../patient-records/patient-release';
import { redactIdentifiers } from './identifiers';

/**
 * The minimised record extract patient record chat sends to the processor
 * (owner decision 1 of 2026-10-16). It is built only from
 * PatientRecordRelease.read, the patient's own release set, so it can hold
 * nothing the patient does not already see, and only the categories whose
 * release flags are on. Per kind, only the fields listed in EXTRACT_FIELDS
 * leave the system; every string value (free text, codes, units, routes and
 * enumerated statuses alike) is passed through redactIdentifiers. No name, Health ID, NIN, date of birth, contact detail,
 * staff or facility name, file name, storage location or internal id is ever
 * included: records are numbered (ref), facilities are ordinals (F1, F2) and
 * every timestamp is cut to its calendar date (UTC).
 */
export type SourceKind = 'encounter' | 'note' | 'diagnosis' | 'prescription' | 'lab_result' | 'vital' | 'document';
export const SOURCE_KINDS: readonly SourceKind[] = ['encounter', 'note', 'diagnosis', 'prescription', 'lab_result', 'vital',
  'document'];

/** The record categories chat may read: exactly the release set's categories (never lab requests). */
export const CHAT_SOURCE_CATEGORIES: Readonly<Record<SourceKind, string>> = {
  encounter: 'encounters', note: 'notes', diagnosis: 'diagnoses', prescription: 'prescriptions',
  lab_result: 'labResults', vital: 'vitals', document: 'documents',
};

/** Exactly the fields of each kind that are sent, besides ref, kind and encounterRef. */
export const EXTRACT_FIELDS: Readonly<Record<SourceKind, readonly string[]>> = {
  encounter: ['facility', 'type', 'status', 'startedOn', 'endedOn'],
  note: ['noteType', 'title', 'signedOn', 'text', 'excerpt'],
  diagnosis: ['code', 'display', 'clinicalStatus', 'verificationStatus', 'onsetOn', 'abatementOn'],
  prescription: ['medication', 'medicationCode', 'dose', 'doseUnit', 'route', 'frequency', 'instructions', 'startsOn',
    'endsOn', 'status'],
  lab_result: ['test', 'testCode', 'resultType', 'value', 'text', 'unit', 'referenceRange', 'flag', 'revisionKind',
    'releasedOn'],
  vital: ['recordedOn', 'measurements'],
  document: ['classification', 'mediaType', 'createdOn'],
};

/** What the patient receives about a cited source: what the released routes already show. */
export interface ChatSource {
  number: number;
  kind: SourceKind;
  id: string;
  recordedOn: string | null;
  effectiveOn: string | null;
  title: string;
}

/** A source as stored with the exchange (never returned): its record and the hash of its released content. */
export interface SourceBinding {
  kind: SourceKind;
  id: string;
  hash: string;
}

export interface ChatCoverage {
  complete: boolean;
  released: string[];
  withheld: string[];
  truncated: boolean;
  selectedCount: number;
  recordCount: number;
}

export interface LabComparison {
  test: string;
  unit: string | null;
  earlierRef: number;
  laterRef: number;
  earlier: string;
  later: string;
  difference: string;
}

export interface ExtractRecord {
  ref: number;
  kind: SourceKind;
  encounterRef?: number;
  [field: string]: unknown;
}

export interface PriorTurn {
  question: string;
  answer: string;
}

export interface PatientExtract {
  records: ExtractRecord[];
  sources: ChatSource[];
  bindings: SourceBinding[];
  coverage: ChatCoverage;
  labComparisons: LabComparison[];
  sourceCounts: Record<SourceKind, number>;
}

export interface ExtractLimits {
  maxSources: number;
  maxSourceChars: number;
  maxTotalChars: number;
}

export const EXTRACT_LIMITS = { maxSources: 40, maxSourceChars: 8000 } as const;

/** One released record before selection. */
interface Candidate {
  kind: SourceKind;
  id: string;
  encounterId: string | null;
  facilityId: string | null;
  date: string | null;
  effectiveOn: string | null;
  title: string;
  fields: Record<string, unknown>;
  searchable: string;
  hash: string;
}

// One space-separated list: a lone 'for' string literal reads as a row-lock fragment to the
// runtime locking check (scripts/verify-runtime-locking-privileges.mjs).
const STOPWORDS = new Set(('the and for are was were what when which who how why did does have has had with that this '
  + 'from there their about any all can could would should you your my mine me our his her its tell show please record '
  + 'records last latest recent been into than then them they not yes get').split(' '));

/** JSON with object keys sorted at every level: the same value always serializes to the same text. */
export function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** A calendar date (UTC) from a timestamp or date value; null when absent or unparseable. */
export function calendarDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const redacted = redactIdentifiers(String(value)).trim();
  return redacted === '' ? null : redacted;
}

/** A number as it is; any other value as redacted text (codes, units and routes are free-length columns too). */
function scalar(value: unknown): string | number | null {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'number' ? value : text(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The hash of a released record as the release returns it; any change to it changes the hash. */
export function releasedRecordHash(kind: SourceKind, row: QueryResultRow | PatientLabResult): string {
  return sha256(canonicalJson({ kind, row }));
}

function compact(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined));
}

/** Every released record as a candidate source, with only the allowlisted fields. */
function candidates(records: PatientReleasedRecords): Candidate[] {
  const list: Candidate[] = [];
  const add = (kind: SourceKind, row: QueryResultRow | PatientLabResult, values: {
    encounterId?: unknown; facilityId?: unknown; date: string | null; effectiveOn?: string | null; title: string;
    fields: Record<string, unknown>;
  }) => {
    const fields = compact(values.fields);
    list.push({
      kind, id: String(row.id), encounterId: values.encounterId ? String(values.encounterId) : null,
      facilityId: values.facilityId ? String(values.facilityId) : null, date: values.date,
      effectiveOn: values.effectiveOn ?? null, title: values.title.slice(0, 200),
      fields, searchable: Object.values(fields).map((value) => JSON.stringify(value)).join(' ').toLowerCase(),
      hash: releasedRecordHash(kind, row),
    });
  };
  for (const row of records.encounters) {
    add('encounter', row, { facilityId: row.facilityId, date: calendarDate(row.startedAt),
      effectiveOn: calendarDate(row.endedAt), title: String(row.encounterType ?? 'Encounter'), fields: {
        type: scalar(row.encounterType), status: scalar(row.status), startedOn: calendarDate(row.startedAt),
        endedOn: calendarDate(row.endedAt) } });
  }
  for (const row of records.notes) {
    add('note', row, { encounterId: row.encounterId, facilityId: row.facilityId, date: calendarDate(row.signedAt),
      title: String(text(row.title) ?? row.noteType ?? 'Clinical note'), fields: {
        noteType: scalar(row.noteType), title: text(row.title), signedOn: calendarDate(row.signedAt),
        text: text(row.content) } });
  }
  for (const row of records.diagnoses) {
    add('diagnosis', row, { encounterId: row.encounterId, facilityId: row.facilityId, date: calendarDate(row.onsetAt),
      effectiveOn: calendarDate(row.abatementAt), title: String(text(row.display) ?? row.code ?? 'Diagnosis'), fields: {
        code: scalar(row.code), display: text(row.display), clinicalStatus: scalar(row.clinicalStatus),
        verificationStatus: scalar(row.verificationStatus), onsetOn: calendarDate(row.onsetAt),
        abatementOn: calendarDate(row.abatementAt) } });
  }
  for (const row of records.prescriptions) {
    add('prescription', row, { encounterId: row.encounterId, facilityId: row.facilityId,
      date: calendarDate(row.startsOn), effectiveOn: calendarDate(row.endsOn),
      title: String(text(row.medicationDisplay) ?? 'Prescription'), fields: {
        medication: text(row.medicationDisplay), medicationCode: scalar(row.medicationCode),
        dose: scalar(row.doseQuantity), doseUnit: scalar(row.doseUnit), route: scalar(row.routeCode),
        frequency: text(row.frequency), instructions: text(row.instructions), startsOn: calendarDate(row.startsOn),
        endsOn: calendarDate(row.endsOn), status: scalar(row.status) } });
  }
  for (const row of records.labResults ?? []) {
    add('lab_result', row, { encounterId: row.encounterId, facilityId: row.facilityId,
      date: calendarDate(row.releasedAt), title: String(text(row.test.name) ?? row.test.code ?? 'Lab result'), fields: {
        test: text(row.test.name), testCode: scalar(row.test.code), resultType: scalar(row.resultType),
        value: row.numericValue, text: text(row.textValue), unit: scalar(row.unit),
        referenceRange: text(row.referenceRange), flag: scalar(row.abnormalFlag), revisionKind: scalar(row.revisionKind),
        releasedOn: calendarDate(row.releasedAt) } });
  }
  for (const row of records.vitals) {
    const measurements = compact({
      heightCm: scalar(row.heightCm), weightKg: scalar(row.weightKg), temperatureC: scalar(row.temperatureC),
      pulseBpm: scalar(row.pulseBpm), respiratoryRate: scalar(row.respiratoryRate),
      systolicMmhg: scalar(row.systolicMmhg), diastolicMmhg: scalar(row.diastolicMmhg),
      oxygenSaturationPercent: scalar(row.oxygenSaturationPercent),
    });
    add('vital', row, { encounterId: row.encounterId, facilityId: row.facilityId, date: calendarDate(row.recordedAt),
      title: 'Vital signs', fields: { recordedOn: calendarDate(row.recordedAt), measurements } });
  }
  for (const row of records.documents) {
    // Metadata only: never the file name, the content or the storage location.
    add('document', row, { encounterId: row.encounterId, facilityId: row.facilityId, date: calendarDate(row.createdAt),
      title: 'Document', fields: { classification: scalar(row.classification), mediaType: scalar(row.mediaType),
        createdOn: calendarDate(row.createdAt) } });
  }
  return list;
}

/** Lowercase terms of three or more letters or digits, without common words. */
export function questionTerms(question: string): string[] {
  return [...new Set((question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((term) => !STOPWORDS.has(term)))];
}

function newestFirst(left: Candidate, right: Candidate): number {
  return (right.date ?? '').localeCompare(left.date ?? '') || left.id.localeCompare(right.id);
}

/** Exact difference later - earlier of two decimal strings (no floating point). */
export function decimalDifference(earlier: string, later: string): string | null {
  const decimal = /^-?\d+(?:\.\d+)?$/;
  if (!decimal.test(earlier) || !decimal.test(later)) return null;
  const scale = Math.max((earlier.split('.')[1] ?? '').length, (later.split('.')[1] ?? '').length);
  const scaled = (value: string) => {
    const negative = value.startsWith('-');
    const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
    const digits = BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
    return negative ? -digits : digits;
  };
  const difference = scaled(later) - scaled(earlier);
  const negative = difference < 0n;
  const digits = (negative ? -difference : difference).toString().padStart(scale + 1, '0');
  const body = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return `${negative ? '-' : difference > 0n ? '+' : ''}${body}`;
}

function labComparisons(records: ExtractRecord[]): LabComparison[] {
  const groups = new Map<string, ExtractRecord[]>();
  for (const record of records) {
    if (record.kind !== 'lab_result' || typeof record.value !== 'number' || !Number.isFinite(record.value)) continue;
    const key = `${String(record.testCode ?? record.test)}|${String(record.unit ?? '')}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const comparisons: LabComparison[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => String(left.releasedOn ?? '').localeCompare(String(right.releasedOn ?? ''))
      || left.ref - right.ref);
    for (let index = 1; index < ordered.length; index += 1) {
      const earlier = ordered[index - 1]!;
      const later = ordered[index]!;
      const difference = decimalDifference(String(earlier.value), String(later.value));
      if (difference === null) continue;
      comparisons.push({ test: String(later.test ?? later.testCode ?? ''), unit: (later.unit as string | undefined) ?? null,
        earlierRef: earlier.ref, laterRef: later.ref, earlier: String(earlier.value), later: String(later.value),
        difference });
    }
  }
  return comparisons;
}

/**
 * The extract for one question: up to 40 released records, chosen by the
 * question's literal terms and then by recency (deterministic), each at most
 * 8,000 characters (a longer note is cut and marked as an excerpt) and all
 * together at most maxTotalChars. Coverage says whether every released record
 * was included and which categories were withheld.
 */
export function buildPatientExtract(records: PatientReleasedRecords, question: string,
  limits: ExtractLimits): PatientExtract {
  const all = candidates(records);
  const terms = questionTerms(question);
  const score = (candidate: Candidate) => terms.filter((term) => candidate.searchable.includes(term)).length;
  const ranked = [...all].sort((left, right) => score(right) - score(left) || newestFirst(left, right)
    || SOURCE_KINDS.indexOf(left.kind) - SOURCE_KINDS.indexOf(right.kind));
  const chosen: Array<{ candidate: Candidate; fields: Record<string, unknown> }> = [];
  let total = 0;
  let excerpted = false;
  for (const candidate of ranked) {
    if (chosen.length >= limits.maxSources) break;
    let fields = candidate.fields;
    let size = canonicalJson(fields).length;
    if (size > limits.maxSourceChars && typeof fields.text === 'string') {
      const room = Math.max(0, limits.maxSourceChars - (size - fields.text.length) - 32);
      fields = { ...fields, text: fields.text.slice(0, room), excerpt: true };
      size = canonicalJson(fields).length;
      excerpted = true;
    }
    if (size > limits.maxSourceChars || total + size > limits.maxTotalChars) continue;
    chosen.push({ candidate, fields });
    total += size;
  }
  // Numbered in a stable reading order: by kind, newest first.
  chosen.sort((left, right) => SOURCE_KINDS.indexOf(left.candidate.kind) - SOURCE_KINDS.indexOf(right.candidate.kind)
    || newestFirst(left.candidate, right.candidate));
  const facilities = new Map<string, string>();
  const facilityLabel = (id: string | null) => {
    if (!id) return null;
    if (!facilities.has(id)) facilities.set(id, `F${facilities.size + 1}`);
    return facilities.get(id)!;
  };
  const encounterRefs = new Map<string, number>();
  chosen.forEach(({ candidate }, index) => {
    if (candidate.kind === 'encounter') encounterRefs.set(candidate.id, index + 1);
  });
  const extractRecords: ExtractRecord[] = chosen.map(({ candidate, fields }, index) => {
    const encounterRef = candidate.encounterId ? encounterRefs.get(candidate.encounterId) : undefined;
    return {
      ref: index + 1, kind: candidate.kind, ...(encounterRef ? { encounterRef } : {}),
      ...(candidate.kind === 'encounter' ? { facility: facilityLabel(candidate.facilityId) } : {}),
      ...fields,
    };
  });
  const sources: ChatSource[] = chosen.map(({ candidate }, index) => ({
    number: index + 1, kind: candidate.kind, id: candidate.id, recordedOn: candidate.date,
    effectiveOn: candidate.effectiveOn, title: candidate.title,
  }));
  const sectionTruncated = Object.values(records.truncated).some(Boolean);
  const truncated = sectionTruncated || excerpted || chosen.length < all.length;
  const sourceCounts = Object.fromEntries(SOURCE_KINDS.map((kind) => [kind,
    chosen.filter(({ candidate }) => candidate.kind === kind).length])) as Record<SourceKind, number>;
  return {
    records: extractRecords,
    sources,
    bindings: chosen.map(({ candidate }) => ({ kind: candidate.kind, id: candidate.id, hash: candidate.hash })),
    coverage: { complete: !truncated, released: [...records.released], withheld: [...records.withheld], truncated,
      selectedCount: chosen.length, recordCount: all.length },
    labComparisons: labComparisons(extractRecords),
    sourceCounts,
  };
}

/** Every released record's binding key (kind:id) and hash, for the re-check before an answer is saved. */
export function releasedBindings(records: PatientReleasedRecords): Map<string, string> {
  return new Map(candidates(records).map((candidate) => [bindingKey(candidate), candidate.hash]));
}

export function bindingKey(binding: { kind: string; id: string }): string {
  return `${binding.kind}:${binding.id}`;
}

/**
 * Whether every record an exchange cites is still released with the content
 * it was answered from (same key and same hash). An exchange that fails this
 * is never sent again as context, replayed or shown in the history.
 */
export function bindingsStillReleased(bindings: readonly SourceBinding[], released: ReadonlyMap<string, string>): boolean {
  return bindings.every((binding) => released.get(bindingKey(binding)) === binding.hash);
}

/**
 * The user turn's text blocks: the extract, the earlier turns (context, not
 * evidence) and the question, each as JSON data with sorted keys.
 */
export function userTurnBlocks(extract: PatientExtract, priorTurns: readonly PriorTurn[], question: string): string[] {
  return [
    canonicalJson({ extract: { audience: 'patient', coverage: extract.coverage, labComparisons: extract.labComparisons,
      records: extract.records } }),
    ...(priorTurns.length ? [canonicalJson({ priorTurns: priorTurns.map((turn) => ({
      question: redactIdentifiers(turn.question), answer: redactIdentifiers(turn.answer) })) })] : []),
    canonicalJson({ question: redactIdentifiers(question) }),
  ];
}
