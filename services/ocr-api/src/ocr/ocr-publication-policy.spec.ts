import { DomainProblem } from '../common/problem';
import { assertCandidateClassification, assertPublishableCandidate, clinicalNoteCandidate,
  expectedPublicationOperation, importedLabCandidate, importedMedicationCandidate,
  importedMedicationCandidates, MAX_IMPORTED_MEDICATIONS, paperRecordDraftNote, publicationCanRetry } from './ocr-publication-policy';

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

// Fictional test data only.
const medicine = (index: number, overrides: Record<string, unknown> = {}) => ({
  itemId: `it-${index.toString(16).padStart(16, '0')}`, page: 1 + (index % 3),
  medicationText: 'Amlodipine', strengthText: '5mg', frequencyText: 'once daily',
  historicalContext: `From a paper record, page ${1 + (index % 3)}. As written: Amlodipine 5mg od. Dated 12/03/2019`,
  ...overrides,
});
const medicationRefusal = expect.objectContaining({ code: 'OCR_INVALID_MEDICATION_EVIDENCE' });

describe('several medicines in one review', () => {
  it('keeps the legacy single-medicine shape unchanged', () => {
    expect(importedMedicationCandidates({ medicationText: 'Metformin', strengthText: '500 mg' })).toEqual({
      legacy: true, entries: [], items: [{ medicationText: 'Metformin', strengthText: '500 mg', doseText: undefined,
        frequencyText: undefined, historicalContext: undefined }] });
  });

  it('takes a list of one, two or fifty medicines, each its own record in reading order', () => {
    expect(importedMedicationCandidates({ medications: [medicine(1)] }).items).toHaveLength(1);
    const two = importedMedicationCandidates({ items: { kept: true }, medications: [medicine(1),
      medicine(2, { medicationText: 'Metformin', strengthText: '500mg', doseText: '1 tablet' })] });
    expect(two.legacy).toBe(false);
    expect(two.items).toEqual([
      { medicationText: 'Amlodipine', strengthText: '5mg', doseText: undefined, frequencyText: 'once daily',
        historicalContext: medicine(1).historicalContext },
      { medicationText: 'Metformin', strengthText: '500mg', doseText: '1 tablet', frequencyText: 'once daily',
        historicalContext: medicine(2).historicalContext },
    ]);
    // itemId and page stay in the review; Pharmacy receives only the medicine text.
    expect(two.entries.map(({ itemId, page }) => ({ itemId, page })))
      .toEqual([{ itemId: medicine(1).itemId, page: 2 }, { itemId: medicine(2).itemId, page: 3 }]);
    const fifty = Array.from({ length: MAX_IMPORTED_MEDICATIONS }, (_v, index) => medicine(index + 1));
    expect(importedMedicationCandidates({ medications: fifty }).items).toHaveLength(50);
  });

  it('takes medicines typed from the page, without an item id, each its own record', () => {
    // A paper read with AI reading off has no items: the reviewer types every medicine.
    const typed = importedMedicationCandidates({ medications: [medicine(1, { itemId: undefined }),
      medicine(2, { itemId: undefined, medicationText: 'Metformin' }), medicine(3, { itemId: null })] });
    expect(typed.items.map((item) => item.medicationText)).toEqual(['Amlodipine', 'Metformin', 'Amlodipine']);
    expect(typed.entries.map(({ itemId, page }) => ({ itemId, page })))
      .toEqual([{ itemId: undefined, page: 2 }, { itemId: undefined, page: 3 }, { itemId: undefined, page: 1 }]);
    // Read items and typed ones may be mixed (the reading missed one); identical typed lines stay separate.
    const same = { itemId: undefined, medicationText: 'Metformin' };
    expect(importedMedicationCandidates({ medications: [medicine(1), medicine(2, same), medicine(3, same)] }).items)
      .toHaveLength(3);
  });

  it('never merges identical lines', () => {
    const same = { medicationText: 'Metformin', strengthText: '500mg' };
    expect(importedMedicationCandidates({ medications: [medicine(1, same), medicine(2, same)] }).items)
      .toHaveLength(2);
  });

  it.each([
    ['an empty list', { medications: [] }],
    ['51 medicines', { medications: Array.from({ length: 51 }, (_v, index) => medicine(index + 1)) }],
    ['a list that is not a list', { medications: { 0: medicine(1) } }],
    ['both shapes at once', { medicationText: 'Amlodipine', medications: [medicine(1), medicine(2)] }],
    ['a list with a top-level context', { historicalContext: 'x', medications: [medicine(1), medicine(2)] }],
    ['a repeated item', { medications: [medicine(1), medicine(1)] }],
    ['a medicine without a page', { medications: [medicine(1), medicine(2, { page: undefined })] }],
    ['a page of 0', { medications: [medicine(1), medicine(2, { page: 0 })] }],
    ['a page that is not whole', { medications: [medicine(1), medicine(2, { page: 1.5 })] }],
    ['a malformed item id', { medications: [medicine(1), medicine(2, { itemId: 'item-2' })] }],
    ['a medicine without as-written context', { medications: [medicine(1), medicine(2, { historicalContext: '' })] }],
    ['a medicine without a name', { medications: [medicine(1), medicine(2, { medicationText: ' ' })] }],
    ['a name over 500 characters', { medications: [medicine(1), medicine(2, { medicationText: 'A'.repeat(501) })] }],
    ['a strength over 240 characters', { medications: [medicine(1), medicine(2, { strengthText: 'A'.repeat(241) })] }],
    ['a context over 2000 characters', { medications: [medicine(1), medicine(2, { historicalContext: 'A'.repeat(2001) })] }],
    ['an entry that is not an object', { medications: [medicine(1), 'Metformin'] }],
    ['a typed medicine without as-written context', { medications: [medicine(1, { itemId: undefined }),
      medicine(2, { itemId: undefined, historicalContext: undefined })] }],
    ['a typed medicine without a page', { medications: [medicine(1, { itemId: undefined, page: undefined })] }],
  ])('refuses the whole review for %s', (_name, fields) => {
    expect(() => importedMedicationCandidates(fields as Record<string, unknown>)).toThrow(medicationRefusal);
    expect(() => assertPublishableCandidate('PHARMACY', fields as Record<string, unknown>)).toThrow(medicationRefusal);
  });
});

describe('dates written on paper lab results', () => {
  const today = '2026-11-05';
  const observation = (overrides: Record<string, unknown> = {}) => ({ testName: 'Haemoglobin', value: '12.5',
    unit: 'g/dL', ...overrides });
  const lab = (fields: Record<string, unknown>) => importedLabCandidate(fields, today);
  const allowedObservationKeys = ['abnormalFlag', 'referenceRange', 'reportedAt', 'testCode', 'testName', 'unit',
    'value', 'valueText'];
  const allowedTopKeys = ['collectedAt', 'externalLabName', 'externalReference', 'observations', 'reportedAt'];

  it('sends a real date when the text on paper is unambiguous', () => {
    const result = lab({ collectedAtAsWritten: '11/03/2025', reportedAtAsWritten: '12th March 2025',
      observations: [observation({ reportedAtAsWritten: '12/03/2025', page: 2, itemId: 'it-00000000000000aa' })] });
    expect(result.collectedAt).toBe('2025-03-11T00:00:00.000Z');
    expect(result.reportedAt).toBe('2025-03-12T00:00:00.000Z');
    expect(result.observations[0]?.reportedAt).toBe('2025-03-12T00:00:00.000Z');
  });

  it.each(['March 2025', '12/03/25', '06/11/2026', '29/02/2023', 'about a year ago'])(
    'leaves the date out when the text is %s, and the review still passes', (text) => {
      const result = lab({ reportedAtAsWritten: text, observations: [observation({ reportedAtAsWritten: text })] });
      expect(result.reportedAt).toBeUndefined();
      expect(result.observations[0]?.reportedAt).toBeUndefined();
      expect(() => assertPublishableCandidate('LAB',
        { reportedAtAsWritten: text, observations: [observation({ reportedAtAsWritten: text })] }, today)).not.toThrow();
    });

  it('sends only the keys Lab accepts, never the as-written text, page or item id', () => {
    const result = lab({ collectedAtAsWritten: '11/03/2025', reportedAtAsWritten: 'Mar 2025',
      externalLabName: 'Fictional Lab', observations: [observation({ reportedAtAsWritten: '12/03/2025', page: 1,
        itemId: 'it-00000000000000aa' })] });
    const sent = JSON.parse(JSON.stringify(result)) as Record<string, unknown> & { observations: object[] };
    expect(Object.keys(sent).every((key) => allowedTopKeys.includes(key))).toBe(true);
    expect(Object.keys(sent.observations[0] ?? {}).every((key) => allowedObservationKeys.includes(key))).toBe(true);
    expect(JSON.stringify(sent)).not.toMatch(/AsWritten|itemId|"page"/);
  });

  it('converts a legacy reportedAt that is not ISO instead of failing at send time', () => {
    expect(lab({ observations: [observation({ reportedAt: '12/03/2025' })] }).observations[0]?.reportedAt)
      .toBe('2025-03-12T00:00:00.000Z');
    expect(lab({ reportedAt: 'Mar 2025', observations: [observation({ reportedAt: 'Mar 2025' })] }))
      .toMatchObject({ reportedAt: undefined, observations: [expect.objectContaining({ reportedAt: undefined })] });
  });

  it('passes a legacy ISO date through unchanged, but refuses one that is not a real day', () => {
    expect(lab({ reportedAt: '2025-03-12T09:30:00.000Z', observations: [observation({ reportedAt: '2025-03-12' })] }))
      .toMatchObject({ reportedAt: '2025-03-12T09:30:00.000Z',
        observations: [expect.objectContaining({ reportedAt: '2025-03-12' })] });
    expect(() => lab({ observations: [observation({ reportedAt: '2025-02-30' })] }))
      .toThrow(expect.objectContaining({ code: 'OCR_INVALID_LAB_EVIDENCE' }));
  });

  it('refuses a reviewer date that disagrees with, or sharpens, the text on paper', () => {
    expect(() => lab({ observations: [observation({ reportedAtAsWritten: '12/03/2025', reportedAt: '2025-12-03' })] }))
      .toThrow(expect.objectContaining({ code: 'OCR_LAB_DATE_CONFLICT', status: 400 }));
    expect(() => lab({ reportedAtAsWritten: 'March 2025', reportedAt: '2025-03-01', observations: [observation()] }))
      .toThrow(expect.objectContaining({ code: 'OCR_LAB_DATE_CONFLICT' }));
    expect(lab({ observations: [observation({ reportedAtAsWritten: '12/03/2025', reportedAt: '2025-03-12' })] })
      .observations[0]?.reportedAt).toBe('2025-03-12T00:00:00.000Z');
  });

  it('refuses a report date before the collection date', () => {
    expect(() => lab({ collectedAtAsWritten: '12/03/2025', reportedAtAsWritten: '11/03/2025',
      observations: [observation()] })).toThrow(expect.objectContaining({ code: 'OCR_LAB_DATE_ORDER', status: 400 }));
    expect(() => lab({ collectedAtAsWritten: '12/03/2025', reportedAtAsWritten: 'Mar 2025',
      observations: [observation()] })).not.toThrow();
  });

  it('passes a legacy ISO date-time without a zone unchanged, as Lab accepts it, instead of dropping it', () => {
    expect(lab({ collectedAt: '2025-03-12T10:00', reportedAt: '2025-03-12T15:00:00',
      observations: [observation({ reportedAt: '2025-03-12T15:00:00.000' })] }))
      .toMatchObject({ collectedAt: '2025-03-12T10:00', reportedAt: '2025-03-12T15:00:00',
        observations: [expect.objectContaining({ reportedAt: '2025-03-12T15:00:00.000' })] });
    expect(() => lab({ reportedAt: '2025-03-12T25:00', observations: [observation()] }))
      .toThrow(expect.objectContaining({ code: 'OCR_INVALID_LAB_EVIDENCE' }));
  });

  it('accepts a slip collected at a time and reported the same day, without making up a time', () => {
    // Collected 05/06/2024 09:00, reported 05/06/2024 (no time on the paper).
    const sameDay = lab({ collectedAt: '2024-06-05T09:00:00+01:00', reportedAtAsWritten: '05/06/2024',
      observations: [observation()] });
    expect(sameDay.collectedAt).toBe('2024-06-05T09:00:00+01:00');
    // The report day cannot be placed after 09:00 without inventing a time, so it is not sent;
    // its as-written text stays in the stored review.
    expect(sameDay.reportedAt).toBeUndefined();
    // Collected on a day only, reported at 00:30 Lagos time the same day (23:30 UTC the day before).
    const early = lab({ collectedAtAsWritten: '12/03/2025', reportedAt: '2025-03-12T00:30+01:00',
      observations: [observation()] });
    expect(early).toMatchObject({ collectedAt: undefined, reportedAt: '2025-03-12T00:30+01:00' });
    // A later day keeps both dates.
    expect(lab({ collectedAt: '2024-06-05T09:00:00+01:00', reportedAtAsWritten: '06/06/2024',
      observations: [observation()] })).toMatchObject({ collectedAt: '2024-06-05T09:00:00+01:00',
      reportedAt: '2024-06-06T00:00:00.000Z' });
    // Midnight to midnight on the same day passes as before.
    expect(lab({ collectedAtAsWritten: '12/03/2025', reportedAtAsWritten: '12/03/2025',
      observations: [observation()] })).toMatchObject({ collectedAt: '2025-03-12T00:00:00.000Z',
      reportedAt: '2025-03-12T00:00:00.000Z' });
  });

  it('every date sent satisfies Lab\'s reported_at >= collected_at', () => {
    const cases: Record<string, unknown>[] = [
      { collectedAt: '2024-06-05T09:00:00+01:00', reportedAtAsWritten: '05/06/2024' },
      { collectedAtAsWritten: '12/03/2025', reportedAt: '2025-03-12T00:30+01:00' },
      { collectedAt: '2025-03-12T10:00', reportedAt: '2025-03-12' },
      { collectedAt: '2025-03-12', reportedAt: '2025-03-12T10:00+01:00' },
      { collectedAtAsWritten: '2025-03-12T08:00Z', reportedAtAsWritten: '12/03/2025' },
    ];
    for (const fields of cases) {
      const result = lab({ ...fields, observations: [observation()] });
      if (result.collectedAt && result.reportedAt) {
        const asUtc = (value: string) => Date.parse(/T.*(Z|[+-]\d{2}:?\d{2})$/.test(value) || !value.includes('T')
          ? value : `${value}Z`);
        expect(asUtc(result.reportedAt)).toBeGreaterThanOrEqual(asUtc(result.collectedAt));
      }
    }
  });

  it('sends the reviewer\'s time on the day written on paper rather than midnight', () => {
    expect(lab({ collectedAt: '2025-03-12T09:00:00+01:00', reportedAtAsWritten: '12/03/2025',
      reportedAt: '2025-03-12T15:00+01:00', observations: [observation()] }))
      .toMatchObject({ collectedAt: '2025-03-12T09:00:00+01:00', reportedAt: '2025-03-12T15:00+01:00' });
  });

  it('still refuses a report day before the collection day, and a report time before the collection time', () => {
    expect(() => lab({ collectedAt: '2024-06-05T09:00:00+01:00', reportedAtAsWritten: '04/06/2024',
      observations: [observation()] })).toThrow(expect.objectContaining({ code: 'OCR_LAB_DATE_ORDER' }));
    expect(() => lab({ collectedAt: '2024-06-05T09:00:00+01:00', reportedAt: '2024-06-05T08:00:00+01:00',
      observations: [observation()] })).toThrow(expect.objectContaining({ code: 'OCR_LAB_DATE_ORDER' }));
  });

  it('refuses as-written text over 120 characters and a malformed page or item id', () => {
    const invalid = expect.objectContaining({ code: 'OCR_INVALID_LAB_EVIDENCE' });
    expect(() => lab({ observations: [observation({ reportedAtAsWritten: 'A'.repeat(121) })] })).toThrow(invalid);
    expect(() => lab({ observations: [observation({ page: 0 })] })).toThrow(invalid);
    expect(() => lab({ observations: [observation({ itemId: 'lab-1' })] })).toThrow(invalid);
  });
});

describe('clinicalNoteCandidate visit (0113)', () => {
  const fields = { noteType: 'progress', title: 'Clinic card', content: 'Fictional clinical text' };
  it('accepts a reading that names no visit (the imported paper records take it as a draft)', () => {
    expect(clinicalNoteCandidate(fields)).toEqual(fields);
  });
  it('keeps a named visit', () => {
    expect(clinicalNoteCandidate({ ...fields, encounterId: 'c0000000-0000-4000-8000-000000000001' }))
      .toEqual({ ...fields, encounterId: 'c0000000-0000-4000-8000-000000000001' });
  });
  it.each(['not-a-visit', 42, null])('refuses a visit that is not a uuid (%p)', (encounterId) => {
    expect(() => clinicalNoteCandidate({ ...fields, encounterId })).toThrow('Validated clinical-note candidate is incomplete or invalid');
  });
});

// 0113: a Lab, Pharmacy or document-only reading under the dedicated grant is a
// draft note labelled by kind, built from the reviewed fields only.
describe('paperRecordDraftNote', () => {
  it('writes every Lab field that was reviewed, in reading order, and nothing else', () => {
    const note = paperRecordDraftNote('LAB', { externalLabName: 'Example Lab', collectedAt: '2026-10-01',
      observations: [
        { testName: 'Haemoglobin', value: '12.5', unit: 'g/dL', referenceRange: '12-16', abnormalFlag: 'N' },
        { testName: 'Malaria parasite', valueText: 'Not seen' }] }, '2026-11-11');
    expect(note).toEqual({ noteType: 'imported_paper_record', title: 'Lab results',
      content: 'Laboratory: Example Lab\nCollected: 2026-10-01\n'
        + '- Haemoglobin: 12.5 g/dL (reference 12-16) [N]\n- Malaria parasite: Not seen' });
  });

  it('writes every paper date as written, never a converted date or a time that is not on the paper', () => {
    const note = paperRecordDraftNote('LAB', { collectedAtAsWritten: '05/06/2024', reportedAtAsWritten: 'Jun 2024',
      observations: [{ testName: 'PCV', testCode: 'PCV-1', value: '36', unit: '%', reportedAtAsWritten: '6/6/24' }] },
    '2026-11-11');
    expect(note.content).toBe('Collected: 05/06/2024\nReported: Jun 2024\n- PCV (PCV-1): 36 % reported 6/6/24');
    expect(note.content).not.toMatch(/T00:00/);
  });

  it('a document-only reading keeps every reviewed value; the fixed sentence only when none was kept', () => {
    expect(paperRecordDraftNote('DOCUMENT_ONLY', { note: ' Seen ', pages: 2, flags: ['a'] }, '2026-11-11').content)
      .toBe('note: Seen\npages: 2\nflags: ["a"]');
    expect(paperRecordDraftNote('DOCUMENT_ONLY', { note: '  ', other: null }, '2026-11-11').content)
      .toBe('A paper record kept as a document; the reviewer typed no text from it.');
  });

  it('refuses at validation a document-only reading too long for a draft note', () => {
    expect(() => assertPublishableCandidate('DOCUMENT_ONLY', { note: 'x'.repeat(100_001) }))
      .toThrow(expect.objectContaining({ code: 'OCR_INVALID_CLINICAL_NOTE' }));
    expect(() => assertPublishableCandidate('DOCUMENT_ONLY', { note: 'Fictional text' })).not.toThrow();
  });

  it('keeps the as-written line of each medicine and never merges two', () => {
    const note = paperRecordDraftNote('PHARMACY', { medicationText: 'Paracetamol', strengthText: '500 mg' }, '2026-11-11');
    expect(note).toMatchObject({ title: 'Medicines', content: '- Paracetamol 500 mg' });
  });

  it('refuses a Lab or Pharmacy reading the structured check refuses, with the same code', () => {
    expect(() => paperRecordDraftNote('LAB', { observations: [] }, '2026-11-11'))
      .toThrow(expect.objectContaining({ code: 'OCR_INVALID_LAB_EVIDENCE' }));
    expect(() => paperRecordDraftNote('PHARMACY', {}, '2026-11-11')).toThrow(DomainProblem);
  });

  it('is never used for a clinical note or an unclassified reading', () => {
    for (const domain of ['EHR', 'UNCLASSIFIED'] as const) {
      expect(() => paperRecordDraftNote(domain, {}, '2026-11-11'))
        .toThrow(expect.objectContaining({ code: 'OCR_TARGET_UNAVAILABLE' }));
    }
  });
});
