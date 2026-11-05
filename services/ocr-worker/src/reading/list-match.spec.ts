import { DIAGNOSIS_ENTRIES, matchDiagnosisName } from './diagnosis-list';
import { DRUG_ENTRIES, matchDrugName } from './drug-list';
import { LAB_ENTRIES, matchLabTestName } from './lab-list';
import { fuzzyDistance, fuzzyListMatch, withinFuzzyThreshold, type ListEntry } from './list-match';

/**
 * Pairs of entries of one list that are within the fuzzy threshold of each other (list-match.ts) while standing for
 * different things. Each would let a one-letter slip of one be respelled into the other, so each must be handled
 * explicitly here, with a test that a name between them is no match. There are none: the short-word and digit rules
 * keep "vitamin c" / "vitamin e", "vitamin b1" / "vitamin b2", "type 1" / "type 2 diabetes mellitus" and "chronic
 * hepatitis b" / "chronic hepatitis c" apart.
 */
const HANDLED_CLOSE_PAIRS: ReadonlyArray<readonly [string, string]> = [];

function closePairs<T>(entries: readonly ListEntry<T>[]): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]!;
      const b = entries[j]!;
      if (a.target === b.target) continue;
      if (withinFuzzyThreshold(a.key, b.key) || withinFuzzyThreshold(b.key, a.key)) found.push([a.key, b.key]);
    }
  }
  return found;
}

describe('the reading lists share one strict match', () => {
  it('proves no two entries of a list (generics, synonyms and brands; diagnoses; lab tests) are within the threshold', () => {
    for (const entries of [DRUG_ENTRIES, DIAGNOSIS_ENTRIES, LAB_ENTRIES] as const) {
      expect(closePairs(entries as readonly ListEntry<unknown>[])).toEqual(HANDLED_CLOSE_PAIRS);
    }
    // The lists are what the matchers use, and every key is unique to one target.
    for (const entries of [DRUG_ENTRIES, DIAGNOSIS_ENTRIES, LAB_ENTRIES] as const) {
      const byKey = new Map<string, Set<string>>();
      for (const entry of entries) byKey.set(entry.key, (byKey.get(entry.key) ?? new Set()).add(entry.target));
      expect([...byKey].filter(([, targets]) => targets.size > 1)).toEqual([]);
    }
    expect(DRUG_ENTRIES.length).toBeGreaterThan(450);
    expect(DIAGNOSIS_ENTRIES.length).toBeGreaterThan(250);
    expect(LAB_ENTRIES.length).toBeGreaterThan(100);
  });

  it('corrects one slip only, at the same first letter, with the same short words and digits', () => {
    expect(fuzzyDistance('metronidazol', 'metronidazole')).toBe(1);
    expect(fuzzyDistance('metrnidazol', 'metronidazole')).toBeNull();
    // Short words and digits are never respelled.
    expect(fuzzyDistance('vitamin c', 'vitamin e')).toBeNull();
    expect(fuzzyDistance('vitamin b1', 'vitamin b2')).toBeNull();
    expect(fuzzyDistance('type 1 diabetes mellitus', 'type 2 diabetes mellitus')).toBeNull();
    expect(fuzzyDistance('chronic hepatitis b', 'chronic hepatitis c')).toBeNull();
    expect(matchDrugName('Vitamin e')?.generic).toBe('vitamin e');
    expect(matchDrugName('Vitamin f')).toBeNull();
    expect(matchDiagnosisName('Type 3 diabetes mellitus')).toBeNull();
    expect(matchDiagnosisName('Type 2 diabetes melitus')?.title).toBe('Type 2 diabetes mellitus');
    // Under six letters: exact only.
    expect(fuzzyDistance('fbcc', 'fbc')).toBeNull();
    expect(withinFuzzyThreshold('ceftriaxon', 'ceftriaxone')).toBe(true);
    expect(withinFuzzyThreshold('xeftriaxone', 'ceftriaxone')).toBe(false);
  });

  it('gives no match where two targets are equally near (ambiguous: no fuzzy correction)', () => {
    const entries: ListEntry<string>[] = [{ key: 'abcdefg', target: 'one', value: 'one' },
      { key: 'abcdefh', target: 'two', value: 'two' }];
    expect(fuzzyListMatch(['abcdefx'], entries)).toBeNull();
    expect(fuzzyListMatch(['abcdeg'], entries)?.entry.target).toBe('one');
    // Hyperthyroidism and hypothyroidism are two apart; a slip one from each is no match.
    expect(matchDiagnosisName('Hypethyroidism')).toBeNull();
    expect(matchDiagnosisName('Hyperthyroidism')?.title).toBe('Thyrotoxicosis');
  });

  it('never matches an unreadable stretch or a handwritten sign mark', () => {
    for (const name of ['[unreadable]', '[sign?]', 'alternate (sign)', 'Metro[unreadable]', '[sign?] fracture']) {
      expect([name, matchDrugName(name), matchDiagnosisName(name), matchLabTestName(name)]).toEqual([name, null, null, null]);
    }
  });
});
