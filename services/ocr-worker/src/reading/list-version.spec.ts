import { DROP_REASONS } from './items';
import { canonicalJson, computeListVersion, LIST_VERSION, LIST_VERSION_ERROR, LIST_VERSION_PATTERN,
  READER_LISTS } from './list-version';
import { readingCountsSchema } from './contract';
import { TIDY_DROP_REASONS } from './tidy';

/** A deep, mutable copy of the reader's lists, for changing one entry. */
const copy = () => JSON.parse(JSON.stringify(READER_LISTS)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('listVersion', () => {
  it('is 16 hex characters, computed at load from the reader lists', () => {
    expect(LIST_VERSION_ERROR).toBeNull();
    expect(LIST_VERSION).toMatch(LIST_VERSION_PATTERN);
    expect(computeListVersion(READER_LISTS)).toBe(LIST_VERSION);
  });

  it('is stable: the same contents in another key order, or a fresh copy, give the same version', () => {
    expect(computeListVersion(copy())).toBe(LIST_VERSION);
    const reversed = Object.fromEntries(Object.entries(copy()).reverse()
      .map(([key, value]) => [key, value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse()) : value]));
    expect(computeListVersion(reversed)).toBe(LIST_VERSION);
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
  });

  it('changes when any one list changes', () => {
    const edits: Array<(lists: Record<string, any>) => void> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      (lists) => { lists.brandRows[0].brand += 'x'; },
      (lists) => { lists.drugGenerics.push('fictionalmab'); },
      (lists) => { lists.drugSynonyms.fictionalmabum = 'fictionalmab'; },
      (lists) => { lists.drugUnlistedLookalikes.pop(); },
      (lists) => { lists.diagnosisTitles[0][0] += 'x'; },
      (lists) => { lists.diagnosisSynonyms.zzz = 'Malaria'; },
      (lists) => { lists.diagnosisUngroundedAbbreviations.push('zz'); },
      (lists) => { lists.diagnosisUnlistedLookalikes.push('zz'); },
      (lists) => { lists.labTests.FictionalTest = []; },
      (lists) => { lists.labUnlistedLookalikes.push('zz'); },
      (lists) => { lists.signTable[0].meaning += 'x'; },
      (lists) => { lists.abbreviationTable[0][1] += 'x'; },
      (lists) => { lists.frequencyWords.bd = 'two times a day'; },
      (lists) => { lists.drugGenerics.reverse(); },
    ];
    const versions = new Set<string>([LIST_VERSION!]);
    for (const edit of edits) {
      const lists = copy();
      edit(lists);
      const version = computeListVersion(lists);
      expect(version).toMatch(LIST_VERSION_PATTERN);
      expect(version).not.toBe(LIST_VERSION);
      versions.add(version);
    }
    expect(versions.size).toBe(edits.length + 1);
  });

  it('refuses values that are not plain JSON (the module then records LIST_VERSION_UNAVAILABLE, never throws)', () => {
    expect(() => computeListVersion({ bad: Number.NaN })).toThrow('LIST_VERSION_NOT_JSON');
    expect(() => computeListVersion({ bad: () => 1 })).toThrow('LIST_VERSION_NOT_JSON');
  });
});

describe('readingCountsSchema', () => {
  it('accepts every drop reason code as a map key, and rejects text keys and negative counts', () => {
    const base = { version: 1, droppedByReason: {}, droppedByReasonFirstPass: {},
      hardPageAgreement: { fieldsCompared: 0, fieldsAgreed: 0, itemsPaired: 0, itemsSingle: 0, drugSplits: 0,
        alternativesDropped: 0 }, zoomCalls: 0, zoomLimited: 0, zoomFailed: 0, hardPageDeadlineHits: 0, hardReadFailures: {} };
    const all = Object.fromEntries([...DROP_REASONS, ...TIDY_DROP_REASONS].map((reason) => [reason, 1]));
    expect(readingCountsSchema.safeParse({ ...base, droppedByReason: all }).success).toBe(true);
    expect(readingCountsSchema.safeParse({ ...base, droppedByReason: { 'Fictionalmab 437mg': 1 } }).success).toBe(false);
    expect(readingCountsSchema.safeParse({ ...base, zoomCalls: -1 }).success).toBe(false);
    expect(readingCountsSchema.safeParse({ ...base, zoomCalls: 1.5 }).success).toBe(false);
    expect(readingCountsSchema.safeParse({ ...base, note: 'x' }).success).toBe(false);
  });
});
