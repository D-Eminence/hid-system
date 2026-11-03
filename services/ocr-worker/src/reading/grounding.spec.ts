import { ambiguousDate, compact, has, partlyCovered, routes, segment, suspiciousUncited, together } from './grounding';
import { createMasker } from './masking';

describe('has: whole words and whole numbers', () => {
  it.each([
    ['Warfarin 50 mg', 'Warfarin 5', false],
    ['Morphine 5-10mg', 'Morphine 5', false],
    ['Paracetamol 2.5 mg', '5 mg', false],
    ['Ibuprofen 15mg/kg', '15mg', false],
    ['Amoxicillin-clavulanate 625mg', 'Amoxicillin', false],
    ['PMH: HTN/T2DM', 'HTN', true],
    ['PMH: HTN/T2DM', 'T2DM', true],
    ['Warfarin 5 mg nocte', 'Warfarin 5', true],
    ['  Amlodipine   5mg  OD ', 'amlodipine 5mg od', true],
    ['Lisinopril 10mg', 'Lisinopril 1', false],
    ['Hb 10.5 g/dL', '10.5', true],
    ['Hb 10.5 g/dL', '0.5', false],
    ['Malaria parasite: ++', 'malaria', true],
    ['Ọlá clinic', 'ọlá', true],
    ['anything', '   ', false],
  ])('%s contains %s: %s', (text, part, expected) => {
    expect(has(text, part)).toBe(expected);
  });

  it('compacts a number and its unit so 5 mg and 5mg read the same', () => {
    expect(compact('Amlodipine 5 mg')).toBe('amlodipine 5mg');
    expect(has(compact('Amlodipine 5 mg'), compact('5mg'))).toBe(true);
  });
});

describe('segment: a medicine keeps only its own part of a line', () => {
  it('splits a line of two medicines at the comma and keeps the named one', () => {
    expect(segment('Amlodipine 5mg od, Metformin 500mg bd', 'Metformin', ['Amlodipine'])).toBe('metformin 500mg bd');
    expect(segment('Amlodipine 5mg od, Metformin 500mg bd', 'Amlodipine', ['Metformin'])).toBe('amlodipine 5mg od');
  });

  it('keeps "Paracetamol 1g, tds" whole: only one side has a dose', () => {
    expect(segment('Paracetamol 1g, tds', 'Paracetamol', [])).toBe('paracetamol 1g, tds');
  });

  it('cuts where another medicine starts on the same part', () => {
    expect(segment('Amlodipine 5mg Losartan 50mg', 'Amlodipine', ['Losartan'])).toBe('amlodipine 5mg');
    expect(segment('Amlodipine 5mg Losartan 50mg', 'Losartan', ['Amlodipine'])).toBe('losartan 50mg');
  });

  it('keeps the whole text without a name, or with the name in more than one part', () => {
    expect(segment('Metformin 500mg; Metformin 1g', 'Metformin', [])).toBe('metformin 500mg; metformin 1g');
    expect(segment('Something 5mg', '', [])).toBe('something 5mg');
  });
});

describe('routes', () => {
  it('reads the ways a document writes a route, and no route inside a word', () => {
    expect([...routes('Ceftriaxone 1g IV bd')]).toEqual(['intravenous']);
    expect([...routes('Paracetamol 1g po tds')]).toEqual(['oral']);
    expect([...routes('Insulin 10 units s/c')]).toEqual(['subcutaneous']);
    expect(routes('Tab Amlodipine 5mg').size).toBe(0);
    expect(routes('Diclofenac 75mg im stat')).toEqual(new Set(['intramuscular']));
    expect(routes('pivmecillinam').size).toBe(0);
  });
});

describe('together: lines on one row or one wrapped block', () => {
  const order = new Map([['p1-l1', 0], ['p1-l2', 1], ['p1-l3', 2]]);
  it('accepts one visual row and a block wrapped directly below in the same column', () => {
    expect(together([{ id: 'p1-l1', box: { left: 0.1, top: 0.2, width: 0.2, height: 0.02 } },
      { id: 'p1-l2', box: { left: 0.5, top: 0.205, width: 0.2, height: 0.02 } }], order)).toBe(true);
    expect(together([{ id: 'p1-l1', box: { left: 0.1, top: 0.2, width: 0.4, height: 0.02 } },
      { id: 'p1-l2', box: { left: 0.1, top: 0.225, width: 0.3, height: 0.02 } }], order)).toBe(true);
  });

  it('refuses lines in different columns, far apart, with a line between, on other pages or without boxes', () => {
    expect(together([{ id: 'p1-l1', box: { left: 0.1, top: 0.2, width: 0.2, height: 0.02 } },
      { id: 'p1-l2', box: { left: 0.6, top: 0.225, width: 0.2, height: 0.02 } }], order)).toBe(false);
    expect(together([{ id: 'p1-l1', box: { left: 0.1, top: 0.2, width: 0.2, height: 0.02 } },
      { id: 'p1-l2', box: { left: 0.1, top: 0.6, width: 0.2, height: 0.02 } }], order)).toBe(false);
    expect(together([{ id: 'p1-l1', box: { left: 0.1, top: 0.2, width: 0.2, height: 0.02 } },
      { id: 'p1-l3', box: { left: 0.1, top: 0.225, width: 0.2, height: 0.02 } }], order)).toBe(false);
    expect(together([{ id: 'p1-l1', box: { left: 0.1, top: 0.2, width: 0.2, height: 0.02 } },
      { id: 'p2-l1', box: { left: 0.1, top: 0.2, width: 0.2, height: 0.02 } }], new Map([['p1-l1', 0], ['p2-l1', 1]]))).toBe(false);
    expect(together([{ id: 'p1-l1', box: null }, { id: 'p1-l2', box: null }], order)).toBe(false);
  });
});

describe('coverage: possible missed items', () => {
  const lines = [
    { id: 'p1-l1', text: 'Test Patient Adaeze Example' },
    { id: 'p1-l2', text: 'Dx: Malaria' },
    { id: 'p1-l3', text: 'Amlodipine 5mg od, Metformin 500mg bd' },
    { id: 'p1-l4', text: 'Review in two weeks' },
  ];

  it('names uncited lines that look like a diagnosis or medicine', () => {
    expect(suspiciousUncited(lines, new Set(['p1-l1', 'p1-l3']))).toEqual(['p1-l2']);
  });

  it('names cited lines that still hold a medicine no item took', () => {
    expect(partlyCovered(lines, [{ lineIds: ['p1-l3'], asWritten: 'Amlodipine 5mg od' }])).toEqual(['p1-l3']);
    expect(partlyCovered(lines, [{ lineIds: ['p1-l3'], asWritten: 'Amlodipine 5mg od' },
      { lineIds: ['p1-l3'], asWritten: 'Metformin 500mg bd' }])).toEqual([]);
  });
});

describe('dates and masking', () => {
  it('finds dd/mm vs mm/dd ambiguity only where both readings are possible', () => {
    expect(ambiguousDate('03/04/2026')).toBe(true);
    expect(ambiguousDate('13/04/2026')).toBe(false);
    expect(ambiguousDate('04/04/26')).toBe(false);
    expect(ambiguousDate('3rd April 2026')).toBe(false);
  });

  it('hides NIN-like numbers and Nigerian phone numbers, and restores them', () => {
    const masker = createMasker();
    const masked = masker.mask('NIN 12345678901, tel +234 803 000 0000 or 08030000000; BP 120/80');
    expect(masked).toBe('NIN [hidden-number-3], tel [hidden-number-1] or [hidden-number-2]; BP 120/80');
    expect(masker.restore('tel [hidden-number-1]')).toBe('tel +234 803 000 0000');
    expect(masker.count).toBe(3);
  });
});

describe('partlyCovered with characters outside the BMP', () => {
  it('blanks the covered part by code unit, so an astral character does not shift it', () => {
    const lines = [{ id: 'p1-l1', text: '\u{1D7CE}\u{1D7CE}\u{1D7CE}\u{1D7CE} 1g Paracetamol' }];
    expect(partlyCovered(lines, [{ lineIds: ['p1-l1'], asWritten: '1g Paracetamol' }])).toEqual([]);
  });
});
