import { DomainProblem } from '../common/problem';
import { assertCandidateClassification, clinicalNoteCandidate,
  expectedPublicationOperation, importedLabCandidate, importedMedicationCandidate,
  publicationCanRetry } from './ocr-publication-policy';

describe('governed OCR publication policy', () => {
  it('keeps validation and publication separate and blocks unclassified candidates', () => {
    expect(() => assertCandidateClassification({ disposition: 'validated',
      targetDomain: 'UNCLASSIFIED', candidateType: 'unclassified' }))
      .toThrow(expect.objectContaining({ code: 'OCR_UNCLASSIFIED_CANDIDATE' }));
    expect(() => assertCandidateClassification({ disposition: 'rejected',
      targetDomain: 'UNCLASSIFIED', candidateType: 'unclassified' })).not.toThrow();
  });

  it('routes owning-domain imports without fabricating Pharmacy dispensing operations', () => {
    expect(expectedPublicationOperation('LAB')).toBe('create_imported_lab_evidence');
    expect(expectedPublicationOperation('PHARMACY')).toBe('create_imported_medication_evidence');
    expect(expectedPublicationOperation('EHR')).toBe('create_imported_clinical_note');
    expect(expectedPublicationOperation('DOCUMENT_ONLY')).toBe('retain_validated_document');
  });

  it('requires bounded historical medication text without active or dispensed state', () => {
    expect(importedMedicationCandidate({ medicationText: 'Metformin', strengthText: '500 mg' }))
      .toEqual({ medicationText: 'Metformin', strengthText: '500 mg', doseText: undefined,
        frequencyText: undefined, historicalContext: undefined });
    expect(() => importedMedicationCandidate({ medicationText: '' }))
      .toThrow(expect.objectContaining({ code: 'OCR_INVALID_MEDICATION_EVIDENCE' }));
  });

  it('requires explicit imported Lab observations without native execution claims', () => {
    expect(importedLabCandidate({ observations: [{ testName: 'Haemoglobin', value: '12.5', unit: 'g/dL' }] }))
      .toEqual(expect.objectContaining({ observations: [expect.objectContaining({ testName: 'Haemoglobin', value: '12.5' })] }));
    expect(() => importedLabCandidate({ observations: [] }))
      .toThrow(expect.objectContaining({ code: 'OCR_INVALID_LAB_EVIDENCE' }));
  });

  it('accepts only a bounded canonical clinical-note candidate', () => {
    expect(clinicalNoteCandidate({ encounterId: '90000000-0000-4000-8000-000000000001',
      noteType: 'historical-record', title: 'Imported source note', content: 'Reviewed content' }))
      .toMatchObject({ noteType: 'historical-record', content: 'Reviewed content' });
    expect(() => clinicalNoteCandidate({ content: 'missing ownership context' }))
      .toThrow(DomainProblem);
  });

  it('bounds retries and never retries terminal publication failure', () => {
    expect(publicationCanRetry(1, 3, 'transient')).toBe(true);
    expect(publicationCanRetry(3, 3, 'transient')).toBe(false);
    expect(publicationCanRetry(1, 3, 'terminal')).toBe(false);
  });
});

