import { DomainProblem } from '../common/problem';
import { isoDateFacts, isStrictIsoDate, lagosToday, paperDateToIso } from './paper-date';
import { ITEM_ID } from './reading/paper-reading.contract';

export type OcrTargetDomain = 'EHR' | 'LAB' | 'PHARMACY' | 'DOCUMENT_ONLY' | 'UNCLASSIFIED';
export type OcrCandidateType = 'clinical_note' | 'document_only' | 'lab_document'
  | 'historical_medication_evidence' | 'unclassified';

export function assertCandidateClassification(input: {
  disposition: 'validated' | 'rejected'; targetDomain: OcrTargetDomain; candidateType: OcrCandidateType;
}): void {
  const expected: Readonly<Record<OcrTargetDomain, OcrCandidateType>> = {
    EHR: 'clinical_note', LAB: 'lab_document', PHARMACY: 'historical_medication_evidence',
    DOCUMENT_ONLY: 'document_only', UNCLASSIFIED: 'unclassified',
  };
  if (expected[input.targetDomain] !== input.candidateType) {
    throw new DomainProblem(400, 'OCR_CLASSIFICATION_MISMATCH', 'Candidate type does not match its owning domain');
  }
  if (input.disposition === 'validated' && input.targetDomain === 'UNCLASSIFIED') {
    throw new DomainProblem(400, 'OCR_UNCLASSIFIED_CANDIDATE', 'Unclassified OCR data cannot be validated for publication');
  }
}

export function expectedPublicationOperation(domain: OcrTargetDomain):
  'create_imported_clinical_note' | 'create_imported_lab_evidence'
  | 'create_imported_medication_evidence' | 'retain_validated_document' | undefined {
  if (domain === 'EHR') return 'create_imported_clinical_note';
  if (domain === 'LAB') return 'create_imported_lab_evidence';
  if (domain === 'PHARMACY') return 'create_imported_medication_evidence';
  if (domain === 'DOCUMENT_ONLY') return 'retain_validated_document';
  return undefined;
}

export interface ImportedMedicationFields {
  medicationText: string;
  strengthText?: string;
  doseText?: string;
  frequencyText?: string;
  historicalContext?: string;
}

/** The most medicines one review may publish. Each one becomes its own Pharmacy record. */
export const MAX_IMPORTED_MEDICATIONS = 50;

const MEDICATION_TEXT_FIELDS = ['medicationText', 'strengthText', 'doseText', 'frequencyText',
  'historicalContext'] as const;

function medicationProblem(detail: string): DomainProblem {
  return new DomainProblem(400, 'OCR_INVALID_MEDICATION_EVIDENCE', detail);
}

function medicineFields(fields: Record<string, unknown>, path: string,
  contextRequired = false): ImportedMedicationFields {
  const text = (name: string, maximum: number, required = false): string | undefined => {
    const value = fields[name];
    if (value === undefined || value === null || value === '') {
      if (required) {
        throw medicationProblem(name === 'medicationText'
          ? `Validated medication evidence requires medication text${path ? ` (${path})` : ''}`
          : `Imported medication field ${path}${name} is required`);
      }
      return undefined;
    }
    if (typeof value !== 'string' || value.trim().length < 1 || value.length > maximum) {
      throw medicationProblem(`Imported medication field ${path}${name} is invalid`);
    }
    return value.trim();
  };
  return {
    medicationText: text('medicationText', 500, true) as string,
    strengthText: text('strengthText', 240),
    doseText: text('doseText', 240),
    frequencyText: text('frequencyText', 240),
    historicalContext: text('historicalContext', 2_000, contextRequired),
  };
}

/** One medicine in the legacy shape: the five text fields at the top of acceptedFields. */
export function importedMedicationCandidate(fields: Record<string, unknown>): ImportedMedicationFields {
  return medicineFields(fields, '');
}

export interface ImportedMedicationEntry extends ImportedMedicationFields {
  /**
   * Kept in ocr.validations.accepted_fields only; never sent to Pharmacy.
   * itemId is the reading item the entry was taken from; it is absent for a
   * medicine the reviewer typed from the page (no AI reading, or one it missed).
   */
  itemId?: string;
  page: number;
}

/**
 * Every medicine a review keeps. With no `medications` key this is the legacy
 * single medicine, unchanged. Otherwise `medications` holds 1 to 50 entries in
 * reading order, each with its own page and as-written context, and an itemId
 * when it was taken from a reading item (a medicine typed from the page has
 * none). Each becomes its own record: entries are never merged, even when
 * identical.
 * `items` carries only what Pharmacy accepts; `entries` adds itemId and page.
 */
export function importedMedicationCandidates(fields: Record<string, unknown>): {
  legacy: boolean; items: ImportedMedicationFields[]; entries: ImportedMedicationEntry[];
} {
  if (fields.medications === undefined) {
    return { legacy: true, items: [importedMedicationCandidate(fields)], entries: [] };
  }
  const list = fields.medications;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_IMPORTED_MEDICATIONS) {
    throw medicationProblem(`Imported medicines must be a list of 1 to ${MAX_IMPORTED_MEDICATIONS}`);
  }
  if (MEDICATION_TEXT_FIELDS.some((name) => fields[name] !== undefined)) {
    throw medicationProblem('Send the medicines either as a list or as one medicine, not both');
  }
  const seen = new Set<string>();
  const entries = list.map((entry, index): ImportedMedicationEntry => {
    const path = `medications[${index}].`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw medicationProblem(`Imported medicine ${index + 1} is invalid`);
    }
    const value = entry as Record<string, unknown>;
    const page = value.page;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 10_000) {
      throw medicationProblem(`Imported medication field ${path}page is invalid`);
    }
    const itemId = value.itemId;
    if (itemId === undefined || itemId === null) return { ...medicineFields(value, path, true), page };
    if (typeof itemId !== 'string' || !ITEM_ID.test(itemId)) {
      throw medicationProblem(`Imported medication field ${path}itemId is invalid`);
    }
    if (seen.has(itemId)) throw medicationProblem(`Imported medicine ${index + 1} repeats an earlier item`);
    seen.add(itemId);
    return { ...medicineFields(value, path, true), itemId, page };
  });
  return { legacy: false, entries,
    items: entries.map(({ itemId: _itemId, page: _page, ...item }) => item) };
}

function labProblem(code: string, detail: string): DomainProblem {
  return new DomainProblem(400, code, detail);
}

/** A date Lab receives, and whether it names a day only (no time of day). */
interface LabDate { value: string; dayOnly: boolean }

/**
 * The real date Lab receives for one date on the paper, or undefined. The
 * as-written text is kept in accepted_fields whatever happens here.
 */
function labDate(fields: Record<string, unknown>, name: 'reportedAt' | 'collectedAt', path: string,
  today: string): LabDate | undefined {
  const asWrittenName = `${name}AsWritten`;
  const asWrittenValue = fields[asWrittenName];
  let asWritten: string | undefined;
  if (asWrittenValue !== undefined && asWrittenValue !== null && asWrittenValue !== '') {
    if (typeof asWrittenValue !== 'string' || asWrittenValue.trim().length < 1 || asWrittenValue.length > 120) {
      throw labProblem('OCR_INVALID_LAB_EVIDENCE', `Imported Lab field ${path}${asWrittenName} is invalid`);
    }
    asWritten = asWrittenValue.trim();
  }
  const rawValue = fields[name];
  let raw: string | undefined;
  if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
    if (typeof rawValue !== 'string' || rawValue.trim().length < 1 || rawValue.length > 40) {
      throw labProblem('OCR_INVALID_LAB_EVIDENCE', `Imported Lab field ${path}${name} is invalid`);
    }
    raw = rawValue.trim();
  }
  if (asWritten !== undefined) {
    const converted = paperDateToIso(asWritten, today);
    if (raw !== undefined) {
      // A reviewer cannot turn text the rule refuses into a precise date.
      if (!isStrictIsoDate(raw) || converted.iso === null || paperDateToIso(raw, '9999-12-31').iso === null
        || raw.slice(0, 10) !== converted.iso.slice(0, 10)) {
        throw labProblem('OCR_LAB_DATE_CONFLICT',
          `Imported Lab field ${path}${name} does not match the date written on the paper`);
      }
      // The reviewer's ISO value on the same day may add the time of day the
      // paper shows; it is sent rather than midnight.
      if (raw.includes('T')) return { value: raw, dayOnly: false };
    }
    if (converted.iso === null) return undefined;
    // Forms (a)-(c) give midnight UTC and an ISO day passes unchanged: both
    // name a day only. An ISO value with a time (form (d)) passes unchanged.
    return { value: converted.iso, dayOnly: !isStrictIsoDate(asWritten) || !converted.iso.includes('T') };
  }
  if (raw === undefined) return undefined;
  if (isStrictIsoDate(raw)) {
    // As before, a reviewer's ISO value goes to Lab unchanged (with or without
    // a time or zone, as Lab's ISO 8601 check accepts), if it is a real day and time.
    const checked = paperDateToIso(raw, '9999-12-31');
    if (checked.iso === null) {
      throw labProblem('OCR_INVALID_LAB_EVIDENCE', `Imported Lab field ${path}${name} is not a real date`);
    }
    return { value: raw, dayOnly: !raw.includes('T') };
  }
  // Legacy text that is not ISO is a date as written: converted or left out.
  const legacy = paperDateToIso(raw, today).iso;
  return legacy === null ? undefined : { value: legacy, dayOnly: true };
}

/**
 * The Lab import for a review. Paper dates arrive as text (`*AsWritten`, or a
 * legacy `reportedAt`/`collectedAt` that is not ISO); Lab receives a real date
 * only when paperDateToIso converts the text, and otherwise no date. Only the
 * keys Lab accepts are returned: lab-api refuses unknown keys.
 */
export function importedLabCandidate(fields: Record<string, unknown>, today: string = lagosToday()) {
  if (!Array.isArray(fields.observations) || fields.observations.length < 1 || fields.observations.length > 200) {
    throw new DomainProblem(400, 'OCR_INVALID_LAB_EVIDENCE', 'Validated Lab candidate requires bounded imported observations');
  }
  const observations = fields.observations.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new DomainProblem(400, 'OCR_INVALID_LAB_EVIDENCE', 'An imported Lab observation is invalid');
    }
    const value = item as Record<string, unknown>;
    const text = (name: string, maximum: number): string | undefined => {
      const candidate = value[name];
      if (candidate === undefined || candidate === null || candidate === '') return undefined;
      if (typeof candidate !== 'string' || candidate.trim().length < 1 || candidate.length > maximum) {
        throw new DomainProblem(400, 'OCR_INVALID_LAB_EVIDENCE', `Imported Lab field ${name} is invalid`);
      }
      return candidate.trim();
    };
    const testName = text('testName', 240);
    const resultValue = text('value', 240);
    const valueText = text('valueText', 2_000);
    if (!testName || (!resultValue && !valueText)) {
      throw new DomainProblem(400, 'OCR_INVALID_LAB_EVIDENCE', 'Each imported Lab observation requires a test name and result');
    }
    if (value.page !== undefined && (typeof value.page !== 'number' || !Number.isInteger(value.page)
      || value.page < 1 || value.page > 10_000)) {
      throw new DomainProblem(400, 'OCR_INVALID_LAB_EVIDENCE', `Imported Lab field observations[${index}].page is invalid`);
    }
    if (value.itemId !== undefined && (typeof value.itemId !== 'string' || !ITEM_ID.test(value.itemId))) {
      throw new DomainProblem(400, 'OCR_INVALID_LAB_EVIDENCE', `Imported Lab field observations[${index}].itemId is invalid`);
    }
    return { testName, value: resultValue, valueText, testCode: text('testCode', 120), unit: text('unit', 80),
      referenceRange: text('referenceRange', 240), abnormalFlag: text('abnormalFlag', 20),
      reportedAt: labDate(value, 'reportedAt', `observations[${index}].`, today)?.value };
  });
  const optional = (name: string, maximum: number) => {
    const value = fields[name];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > maximum) {
      throw new DomainProblem(400, 'OCR_INVALID_LAB_EVIDENCE', `Imported Lab field ${name} is invalid`);
    }
    return value;
  };
  const collected = labDate(fields, 'collectedAt', '', today);
  const reported = labDate(fields, 'reportedAt', '', today);
  let collectedAt = collected?.value;
  let reportedAt = reported?.value;
  if (collected && reported) {
    // lab.imported_evidence has CHECK (reported_at >= collected_at) (0017), which
    // would refuse the publication after the review is stored, so the order is
    // settled here, the same way at validation and at publication.
    const collectedFacts = isoDateFacts(collected.value);
    const reportedFacts = isoDateFacts(reported.value);
    if (reportedFacts.day < collectedFacts.day) {
      throw labProblem('OCR_LAB_DATE_ORDER', 'The report date is before the collection date');
    }
    if (reportedFacts.instant < collectedFacts.instant) {
      // Same day. A date that names a day only (midnight UTC is not a time on
      // the paper) cannot be ordered against a time on that day, so it is not
      // sent; its as-written text stays in the review. No time is made up.
      if (reported.dayOnly) reportedAt = undefined;
      else if (collected.dayOnly) collectedAt = undefined;
      else throw labProblem('OCR_LAB_DATE_ORDER', 'The report time is before the collection time');
    }
  }
  return { observations, externalLabName: optional('externalLabName', 240),
    externalReference: optional('externalReference', 240), collectedAt, reportedAt };
}

export function clinicalNoteCandidate(fields: Record<string, unknown>) {
  const encounterId = fields.encounterId;
  const noteType = fields.noteType;
  const title = fields.title;
  const content = fields.content;
  // The visit is optional (0112): a reading without one is published as a
  // draft into the patient's "Imported paper records" encounter.
  if ((encounterId !== undefined && (typeof encounterId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(encounterId)))
    || typeof noteType !== 'string' || noteType.trim().length < 1 || noteType.length > 80
    || typeof title !== 'string' || title.trim().length < 1 || title.length > 240
    || typeof content !== 'string' || content.trim().length < 1 || content.length > 100_000) {
    throw new DomainProblem(400, 'OCR_INVALID_CLINICAL_NOTE', 'Validated clinical-note candidate is incomplete or invalid');
  }
  return { ...(typeof encounterId === 'string' ? { encounterId } : {}), noteType: noteType.trim(), title: title.trim(),
    content };
}

/**
 * Runs the owning domain's candidate check that publication runs on the same
 * accepted fields. Publication stores its refusal as terminal, and a validated
 * job cannot be validated again (0077), so validation must refuse first.
 */
export function assertPublishableCandidate(domain: OcrTargetDomain, fields: Record<string, unknown>,
  today: string = lagosToday()): void {
  if (domain === 'EHR') clinicalNoteCandidate(fields);
  else if (domain === 'LAB') importedLabCandidate(fields, today);
  else if (domain === 'PHARMACY') importedMedicationCandidates(fields);
}

export function publicationCanRetry(attemptCount: number, maxAttempts: number,
  failure: 'transient' | 'terminal'): boolean {
  return failure === 'transient' && attemptCount < maxAttempts;
}

