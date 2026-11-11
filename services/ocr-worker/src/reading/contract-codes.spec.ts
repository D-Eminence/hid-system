import { HARD_READ_FAILURE_CODES, READING_DROP_REASON_CODES, readingCountsSchema } from './contract';
import { DROP_REASONS } from './items';
import { TIDY_DROP_REASONS } from './tidy';
import type { HardReadFailure } from './reader';

describe('reading counts: closed key lists', () => {
  it('the drop reason codes are exactly the reader\'s drop reasons', () => {
    expect([...READING_DROP_REASON_CODES].sort()).toEqual([...DROP_REASONS, ...TIDY_DROP_REASONS].sort());
  });

  it('the hard-read failure codes are exactly HardReadFailure', () => {
    // Compile-time: every listed code is a HardReadFailure and every HardReadFailure is listed.
    const listed: readonly HardReadFailure[] = HARD_READ_FAILURE_CODES;
    const exhaustive: Record<HardReadFailure, true> = Object.fromEntries(
      HARD_READ_FAILURE_CODES.map((code) => [code, true])) as Record<HardReadFailure, true>;
    expect(listed.length).toBe(Object.keys(exhaustive).length);
  });

  it('refuses any other key, such as a word from a document', () => {
    const base = { version: 1, droppedByReasonFirstPass: {}, hardPageAgreement: { fieldsCompared: 0, fieldsAgreed: 0,
      itemsPaired: 0, itemsSingle: 0, drugSplits: 0, alternativesDropped: 0 }, zoomCalls: 0, zoomLimited: 0,
      zoomFailed: 0, hardPageDeadlineHits: 0, hardReadFailures: {} };
    expect(readingCountsSchema.safeParse({ ...base, droppedByReason: { text_not_on_line: 1 } }).success).toBe(true);
    expect(readingCountsSchema.safeParse({ ...base, droppedByReason: { paracetamol: 1 } }).success).toBe(false);
    expect(readingCountsSchema.safeParse({ ...base, droppedByReason: {}, hardReadFailures: { malaria: 1 } }).success)
      .toBe(false);
  });
});
