import { DomainProblem } from '../common/problem';

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

export function importedMedicationCandidate(fields: Record<string, unknown>) {
  const text = (name: string, maximum: number, required = false): string | undefined => {
    const value = fields[name];
    if (value === undefined || value === null || value === '') {
      if (required) {
        throw new DomainProblem(400, 'OCR_INVALID_MEDICATION_EVIDENCE',
          'Validated medication evidence requires medication text');
      }
      return undefined;
    }
    if (typeof value !== 'string' || value.trim().length < 1 || value.length > maximum) {
      throw new DomainProblem(400, 'OCR_INVALID_MEDICATION_EVIDENCE',
        `Imported medication field ${name} is invalid`);
    }
    return value.trim();
  };
  return {
    medicationText: text('medicationText', 500, true) as string,
    strengthText: text('strengthText', 240),
    doseText: text('doseText', 240),
    frequencyText: text('frequencyText', 240),
    historicalContext: text('historicalContext', 2_000),
  };
}

export function importedLabCandidate(fields: Record<string, unknown>) {
  if (!Array.isArray(fields.observations) || fields.observations.length < 1 || fields.observations.length > 200) {
    throw new DomainProblem(400, 'OCR_INVALID_LAB_EVIDENCE', 'Validated Lab candidate requires bounded imported observations');
  }
  const observations = fields.observations.map((item) => {
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
    return { testName, value: resultValue, valueText, testCode: text('testCode', 120), unit: text('unit', 80),
      referenceRange: text('referenceRange', 240), abnormalFlag: text('abnormalFlag', 20),
      reportedAt: text('reportedAt', 40) };
  });
  const optional = (name: string, maximum: number) => {
    const value = fields[name];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > maximum) {
      throw new DomainProblem(400, 'OCR_INVALID_LAB_EVIDENCE', `Imported Lab field ${name} is invalid`);
    }
    return value;
  };
  return { observations, externalLabName: optional('externalLabName', 240),
    externalReference: optional('externalReference', 240), collectedAt: optional('collectedAt', 40),
    reportedAt: optional('reportedAt', 40) };
}

export function clinicalNoteCandidate(fields: Record<string, unknown>) {
  const encounterId = fields.encounterId;
  const noteType = fields.noteType;
  const title = fields.title;
  const content = fields.content;
  if (typeof encounterId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(encounterId)
    || typeof noteType !== 'string' || noteType.trim().length < 1 || noteType.length > 80
    || typeof title !== 'string' || title.trim().length < 1 || title.length > 240
    || typeof content !== 'string' || content.trim().length < 1 || content.length > 100_000) {
    throw new DomainProblem(400, 'OCR_INVALID_CLINICAL_NOTE', 'Validated clinical-note candidate is incomplete or invalid');
  }
  return { encounterId, noteType: noteType.trim(), title: title.trim(), content };
}

export function publicationCanRetry(attemptCount: number, maxAttempts: number,
  failure: 'transient' | 'terminal'): boolean {
  return failure === 'transient' && attemptCount < maxAttempts;
}

