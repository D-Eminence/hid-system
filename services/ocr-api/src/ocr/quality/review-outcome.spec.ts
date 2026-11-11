import { computeReviewOutcome, MAX_ESTIMATE_ITEMS, MAX_OUTCOME_BYTES, REVIEW_OUTCOME_SCHEMA, safeReviewOutcome,
  type OutcomeBucket,
  type ReviewOutcome, type ReviewOutcomeInput } from './review-outcome';

// Fictional fixtures only: invented names, medicines and values.
const box = { left: 0.1, top: 0.1, width: 0.5, height: 0.02 };
const id = (n: number) => `it-${n.toString(16).padStart(16, '0')}`;
const medicine = (n: number, fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: id(n), kind: 'medicine', asWritten: `${fields.name} ${fields.strength} ${fields.frequency}`, plain: 'x',
  dateAsWritten: null, page: 1, lineIds: ['p1-l1'], box, confidence: 'clear', checkReasons: [], checkReason: null,
  readBy: 'first_pass', prescription: null,
  fields: { form: null, route: null, duration: null, status: 'current', ...fields }, ...extra });
const lab = (n: number, fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: id(n), kind: 'lab_result', asWritten: `${fields.test} ${fields.value}`, plain: 'x', dateAsWritten: '03/11/26',
  page: 2, lineIds: ['p2-l1'], box, confidence: 'check_carefully', checkReasons: ['handwritten'],
  checkReason: 'Handwritten.', readBy: 'reread', prescription: null,
  fields: { referenceRange: null, flag: null, ...fields }, ...extra });
const diagnosis = (n: number) => ({ id: id(n), kind: 'diagnosis', asWritten: 'Fictional Fever Syndrome', plain: 'x',
  dateAsWritten: null, page: 1, lineIds: ['p1-l2'], box, confidence: 'clear', checkReasons: [], checkReason: null,
  readBy: 'first_pass', prescription: null, fields: { name: 'Fictional Fever Syndrome', status: 'confirmed' } });

const payload = (items: unknown[]) => ({ contract: 'hid-paper-reading-v2', pages: [], identity: {}, items,
  reading: { status: 'read', promptVersion: 'hid-paper-reading-prompt-13', itemCount: items.length } });
const provenance = { processingContract: 'hid-textract-v2',
  reading: { status: 'read', promptVersion: 'hid-paper-reading-prompt-13', hardPages: [2] } };

const MEDS = [
  medicine(1, { name: 'Zentoprilax', strength: '5 mg', frequency: 'od' }),
  medicine(2, { name: 'Quorvadine', strength: '50mg', frequency: 'bd' },
    { confidence: 'check_carefully', checkReasons: ['strength_unsure', 'handwritten'], readBy: 'reread' }),
  medicine(3, { name: 'Faxomirin', strength: '25mg', frequency: 'nocte' }),
];

const base = (overrides: Partial<ReviewOutcomeInput>): ReviewOutcomeInput => ({ disposition: 'validated',
  targetDomain: 'PHARMACY', acceptedFields: {}, corrections: [], structuredPayload: payload([...MEDS, diagnosis(9)]),
  extractionProvenance: provenance, ...overrides });
const kept = (n: number, fields: Record<string, unknown>) =>
  ({ itemId: id(n), page: 1, historicalContext: 'Fictional context', ...fields });
const find = (outcome: ReviewOutcome, match: Partial<OutcomeBucket>) => outcome.buckets
  .filter((bucket) => Object.entries(match).every(([key, value]) => bucket[key as keyof OutcomeBucket] === value));
const sum = (buckets: OutcomeBucket[]) => buckets.reduce((total, bucket) => total + bucket.items, 0);

describe('review outcome', () => {
  const pharmacy = () => computeReviewOutcome(base({
    acceptedFields: { medications: [
      // Same after normalisation: "5mg" == "5 mg", "once daily" == "od", "Tab X" == "X".
      kept(1, { medicationText: 'Tab Zentoprilax', strengthText: '5mg', frequencyText: 'once daily' }),
      // Strength and frequency changed.
      kept(2, { medicationText: 'Quorvadine', strengthText: '5mg', frequencyText: 'tds' }),
      // Typed by the reviewer (no itemId).
      { page: 1, medicationText: 'Plinavex', historicalContext: 'Fictional context' },
    ] },
    corrections: [{ itemId: id(2), fields: ['strength', 'dose'], changeReason: 'misread' }],
    removedItems: [{ itemId: id(3), removalReason: 'duplicate' }],
    reviewConfirmed: true, missedItems: 1,
  }));

  it('counts kept unchanged, kept changed, removed and added by the reviewer, with normalised comparison', () => {
    const outcome = pharmacy();
    expect(outcome.schema).toBe(REVIEW_OUTCOME_SCHEMA);
    expect(outcome.linkage).toBe('item_ids');
    expect(outcome.estimated).toBe(false);
    expect(outcome.promptVersion).toBe('hid-paper-reading-prompt-13');
    expect(outcome.totals).toEqual({ read: 4, keptUnchanged: 1, keptChanged: 1, removed: 1, addedByReviewer: 1,
      unlinked: 0, notInTarget: 1, rejectedWithDocument: 0 });
    const changed = find(outcome, { decision: 'kept_changed' });
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ kind: 'medicine', confidence: 'check_carefully', readBy: 'reread',
      hardPage: false, items: 1, checkReasons: { strength_unsure: 1, handwritten: 1 },
      fieldChanges: { strength: 1, frequency: 1, dose: 1 } });
    expect(find(outcome, { decision: 'kept_unchanged' })[0]).toMatchObject({ confidence: 'clear', fieldChanges: {} });
    expect(find(outcome, { decision: 'added_by_reviewer' })[0]).toMatchObject({ confidence: 'none', readBy: 'none' });
    expect(find(outcome, { decision: 'not_in_target' })[0]).toMatchObject({ kind: 'diagnosis' });
    expect(outcome.reviewer).toEqual({ reviewConfirmed: true, missedItems: 1, corrections: 1,
      correctionFields: { strength: 1, dose: 1 }, changeReasons: { misread: 1 }, removalReasons: { duplicate: 1 },
      rejectionReasonCode: null });
  });

  it('buckets lab results by confidence, readBy and hard page, comparing name, value, unit and date', () => {
    const outcome = computeReviewOutcome(base({ targetDomain: 'LAB',
      structuredPayload: payload([lab(4, { test: 'Fictional Index', value: '.5', unit: 'mg/dl' }),
        lab(5, { test: 'Sample Count', value: '12', unit: 'g/L' })]),
      acceptedFields: { observations: [
        { itemId: id(4), page: 2, testName: 'fictional index', value: '0.5', unit: 'mg / dl',
          reportedAtAsWritten: '03/11/26' },
        { itemId: id(5), page: 2, testName: 'Sample Count', value: '13', unit: 'g/L', reportedAtAsWritten: '04/11/26' },
      ] } }));
    expect(outcome.totals).toMatchObject({ read: 2, keptUnchanged: 1, keptChanged: 1 });
    const [changed] = find(outcome, { decision: 'kept_changed' });
    expect(changed).toMatchObject({ kind: 'lab_result', confidence: 'check_carefully', hardPage: true,
      readBy: 'reread', fieldChanges: { value: 1, date: 1 }, checkReasons: { handwritten: 1 } });
  });

  it('marks an EHR note (whole text, no item links) as estimated instead of deciding per item', () => {
    const outcome = computeReviewOutcome(base({ targetDomain: 'EHR', acceptedFields: {
      encounterId: 'c0000000-0000-4000-8000-000000000001', noteType: 'imported', title: 'Fictional clinic note',
      content: 'Zentoprilax 5 mg od\nQuorvadine 50mg bd\nFictional Fever Syndrome' } }));
    expect(outcome.linkage).toBe('estimated');
    expect(outcome.estimated).toBe(true);
    expect(outcome.estimate).toEqual({ foundInSavedText: 3, notFoundInSavedText: 1, notChecked: 0 });
    expect(outcome.totals).toMatchObject({ unlinked: 4, keptUnchanged: 0, keptChanged: 0, removed: 0 });
    expect(sum(find(outcome, { decision: 'unlinked' }))).toBe(4);
  });

  it('marks the legacy single medicine as estimated', () => {
    const outcome = computeReviewOutcome(base({ acceptedFields: { medicationText: 'Quorvadine',
      strengthText: '50mg', historicalContext: 'Fictional context' } }));
    expect(outcome.estimated).toBe(true);
    expect(outcome.estimate).toEqual({ foundInSavedText: 1, notFoundInSavedText: 2, notChecked: 0 });
    expect(outcome.totals).toMatchObject({ unlinked: 3, notInTarget: 1 });
  });

  it('counts every kept medicine as added when the reading found none (AI reading off)', () => {
    const outcome = computeReviewOutcome(base({ structuredPayload: { contract: 'hid-paper-reading-v2', items: [],
      pages: [{ page: 1 }], reading: { status: 'ai_off', promptVersion: 'hid-paper-reading-prompt-13' } },
    acceptedFields: { medications: [{ page: 1, medicationText: 'Plinavex', historicalContext: 'Fictional' }] } }));
    expect(outcome.estimated).toBe(false);
    expect(outcome.totals).toMatchObject({ read: 0, addedByReviewer: 1 });
  });

  it('counts a rejected document with its rejection reason code', () => {
    const outcome = computeReviewOutcome(base({ disposition: 'rejected', targetDomain: 'UNCLASSIFIED',
      rejectionReasonCode: 'wrong_patient' }));
    expect(outcome.totals).toMatchObject({ read: 4, rejectedWithDocument: 4 });
    expect(outcome.reviewer.rejectionReasonCode).toBe('wrong_patient');
  });

  it('keeps unknown or unsafe codes out: no free text can enter as a code or version', () => {
    const outcome = computeReviewOutcome(base({
      structuredPayload: payload([medicine(1, { name: 'Zentoprilax', strength: '5mg', frequency: 'od' },
        { checkReasons: ['Fictional Patient Name'], confidence: 'check_carefully' })]),
      extractionProvenance: { reading: { promptVersion: 'Fictional Patient Name', status: 'Some text' } },
      acceptedFields: { medications: [kept(1, { medicationText: 'Zentoprilax', strengthText: '5mg',
        frequencyText: 'od' })] } }));
    expect(outcome.promptVersion).toBe('hid-paper-reading-prompt-13');
    expect(outcome.readingStatus).toBe('read');
    expect(outcome.buckets[0]?.checkReasons).toEqual({ other: 1 });
  });

  it('never carries patient text, values or item ids', () => {
    const serialized = JSON.stringify(pharmacy());
    for (const text of ['Zentoprilax', 'Quorvadine', 'Faxomirin', 'Plinavex', 'Fictional', '5 mg', '50mg', 'it-0']) {
      expect(serialized).not.toContain(text);
    }
  });

  it('answers summary_failed and does not throw when the computation fails', () => {
    expect(safeReviewOutcome(base({}), () => { throw new Error('boom Zentoprilax'); }))
      .toEqual({ schema: REVIEW_OUTCOME_SCHEMA, error: 'summary_failed' });
    // Hostile input is not a failure: it computes to counts.
    expect(safeReviewOutcome(base({ structuredPayload: 'not an object', extractionProvenance: [1, 2],
      acceptedFields: null as unknown as Record<string, unknown> }))).toMatchObject({ schema: REVIEW_OUTCOME_SCHEMA,
      linkage: 'none' });
  });
  it('bounds the estimate on a large note with many items, counting the rest notChecked', () => {
    const many = Array.from({ length: 400 }, (_, n) => medicine(100 + n,
      { name: `Fictionalmed${n.toString(36)}`, strength: `${n}mg`, frequency: 'od' }, { plain: `Fictional plain ${n}` }));
    const note = Array.from({ length: 2_000 }, (_, n) => `fictional line words ${n} sample text here`).join('\n');
    const started = Date.now();
    const outcome = computeReviewOutcome(base({ targetDomain: 'EHR', structuredPayload: payload(many),
      acceptedFields: { encounterId: 'c0000000-0000-4000-8000-000000000001', noteType: 'imported',
        title: 'Fictional', content: note.slice(0, 100_000) } }));
    expect(Date.now() - started).toBeLessThan(2_000);
    const estimate = outcome.estimate!;
    expect(estimate.foundInSavedText + estimate.notFoundInSavedText + estimate.notChecked).toBe(400);
    expect(estimate.notChecked).toBeGreaterThanOrEqual(400 - MAX_ESTIMATE_ITEMS);
    expect(outcome.totals.unlinked).toBe(400);
  });

  it('does not count an item whose text has no words as found in the saved text', () => {
    const outcome = computeReviewOutcome(base({ targetDomain: 'EHR',
      structuredPayload: payload([{ ...diagnosis(9), kind: 'note', asWritten: '...', plain: '' }]),
      acceptedFields: { encounterId: 'c0000000-0000-4000-8000-000000000001', noteType: 'imported',
        title: 'Fictional', content: 'Fictional clinic note' } }));
    expect(outcome.estimate).toEqual({ foundInSavedText: 0, notFoundInSavedText: 1, notChecked: 0 });
  });

  it('stores an inherited-looking check code as a plain count', () => {
    const outcome = computeReviewOutcome(base({
      structuredPayload: payload([medicine(1, { name: 'Zentoprilax', strength: '5mg', frequency: 'od' },
        { checkReasons: ['constructor', 'handwritten'] })]),
      acceptedFields: { medications: [kept(1, { medicationText: 'Zentoprilax', strengthText: '5mg',
        frequencyText: 'od' })] } }));
    expect({ ...outcome.buckets[0]?.checkReasons }).toEqual({ constructor: 1, handwritten: 1 });
  });

  it('counts the legacy single medicine typed with nothing read as added by the reviewer, linkage none', () => {
    const outcome = computeReviewOutcome(base({ structuredPayload: payload([]),
      acceptedFields: { medicationText: 'Plinavex', strengthText: '5mg' } }));
    expect(outcome.linkage).toBe('none');
    expect(outcome.totals).toMatchObject({ read: 0, addedByReviewer: 1 });
  });

  it(`keeps the stored outcome under ${MAX_OUTCOME_BYTES} bytes: check reasons first, then summary_too_large`, () => {
    const normal = computeReviewOutcome(base({}));
    const bucket = (n: number, codes: number) => ({ ...normal.buckets[0]!, confidence: 'unknown' as const,
      decision: 'removed' as const, kind: 'medicine' as const, hardPage: n % 2 === 0,
      checkReasons: Object.fromEntries(Array.from({ length: codes }, (_, c) => [`code_${c}_padding_padding`, 1])) });
    const wide = { ...normal, buckets: Array.from({ length: 40 }, (_, n) => bucket(n, 40)) };
    const trimmed = safeReviewOutcome(base({}), () => wide) as ReviewOutcome;
    expect(trimmed.checkReasonsDropped).toBe(true);
    expect(trimmed.buckets.every((entry) => Object.keys(entry.checkReasons).length === 0)).toBe(true);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(MAX_OUTCOME_BYTES);
    const huge = { ...normal, buckets: Array.from({ length: 400 }, (_, n) => bucket(n, 0)) };
    expect(safeReviewOutcome(base({}), () => huge)).toEqual({ schema: REVIEW_OUTCOME_SCHEMA,
      error: 'summary_too_large' });
    expect(safeReviewOutcome(base({}))).toEqual(normal);
  });
});
