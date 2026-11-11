import { normDuration, normFrequency, normName, normStrength, normText, onPage, overlap, similarity,
  tokens } from './normalise';

// Test vectors copied from the OCR accuracy kit (tools/ocr-accuracy-kit/test/score.test.mjs). Fictional text only.
const LINES = ['DEMO HOSPITAL', 'Name: Adaeze Example   Sex: F', 'Tab Amlodipine 5 mg od, Losartan 50mg od',
  'Tab Hydroxyzine 25mg nocte', 'No evidence of Malaria', 'BP 140/90 mmHg'];

describe('review normalisers (accuracy kit vectors)', () => {
  it('normalisation: spacing, case, frequency mapping and names', () => {
    expect(normStrength('5 mg')).toBe(normStrength('5mg'));
    expect(normStrength('100 µg')).toBe(normStrength('100mcg'));
    expect(normStrength('5mg')).not.toBe(normStrength('50mg'));
    for (const spelling of ['tds', 'TDS', 'tid', 't.d.s.', 'three times a day', '8hrly', 'three times daily']) {
      expect(normFrequency(spelling)).toBe('tds');
    }
    for (const spelling of ['bd', 'b.d.', 'BID', 'twice daily', '12hrly']) expect(normFrequency(spelling)).toBe('bd');
    expect(normFrequency('od')).toBe(normFrequency('once daily'));
    expect(normFrequency('od')).not.toBe(normFrequency('bd'));
    expect(normName('Tab Amlodipine')).toBe('amlodipine');
    expect(normName('Artemether-Lumefantrine')).toBe(normName('Artemether/Lumefantrine'));
    expect(onPage('Amlodipine 5mg', LINES)).toBe(true);
    expect(onPage('Amlodipme 5 mg', LINES)).toBe(true);
    expect(onPage('Amlodipine 10mg', LINES)).toBe(false);
    expect(onPage('Hydralazine', LINES)).toBe(false);
  });

  it('a leading-dot strength is a different dose: ".5 mg" is never "5 mg"', () => {
    expect(normStrength('.5 mg')).not.toBe(normStrength('5 mg'));
    expect(normStrength('.5 mg')).toBe(normStrength('0.5mg'));
    expect(onPage('Amlodipine .5 mg', LINES)).toBe(false);
  });

  it('keeps the rest of the kit behaviour', () => {
    expect(normText(null)).toBe('');
    expect(normText('  (Hello,  World). ')).toBe('hello, world');
    expect(normDuration('x5/7')).toBe('5/7');
    expect(normDuration('for 5 days')).toBe('5/7');
    expect(normDuration('2 weeks')).toBe('2/52');
    expect(tokens('.5 mg')).toEqual(['0.5', 'mg']);
    expect(tokens('80/480')).toEqual(['80', '480']);
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('', 'abc')).toBe(0);
    expect(overlap('a b', 'a b')).toBe(1);
    expect(normFrequency('')).toBe('');
    expect(normFrequency('weekly')).toBe('weekly');
  });
});
