import {
  ambiguousDate, combinedStrengths, compact, has, partlyCovered, routes, sameCombined, segment, suspiciousUncited, together,
  unitAfter, withoutNumberedUnit,
} from './grounding';
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

describe('units written straight after a number', () => {
  it.each([
    ['SpO2: 97%', '97%', true],
    ['SpO2: 97 %', '97%', true],
    ['SpO2: 97%', '97 %', true],
    ['T 36.1°C', '36.1°C', true],
    ['T 36.1 °C', '36.1°C', true],
    ['SpO2: 197%', '97%', false],
    ['SpO2: 9.7%', '97%', false],
    ['T 36.1°F', '36.1°C', false],
  ])('%s contains %s: %s', (text, part, expected) => {
    expect(has(text, part)).toBe(expected);
  });

  it.each([
    ['SpO2: 97%', '97', '%', true],
    ['SpO2: 97 %', '97', '%', true],
    ['PCV: 32%', '32', '%', true],
    ['T 36.1°C', '36.1', '°C', true],
    ['T 36.1°C', '36.1', 'C', true],
    ['T 36.1C', '36.1', '°C', true],
    ['T 36.1 C', '36.1', 'C', true],
    ['SpO2: 197%', '97', '%', false],
    ['SpO2: 9.7%', '97', '%', false],
    ['SpO2: 9.7%', '7', '%', false],
    ['SpO2 97 PCV 32%', '97', '%', false],
    ['T 36.1°F', '36.1', '°C', false],
    ['T 36.1°C', '36.1', 'F', false],
    ['Hb 12.5 g/dL', '12.5', 'g', false],
    ['BP 120/80 mmHg', '80', 'mmHg', false],
    ['BP 120/80 mmHg', '120/80', 'mmHg', true],
    ['SpO2 97%', '97', '%', true],
    ['SpO2: 1 97%', '97', '%', false],
    ['T 3 6.1°C', '6.1', '°C', false],
    ['PCV: 3 2%', '2', '%', false],
    ['SpO2 9. 7%', '7', '%', false],
    ['T 36. 1°C', '1', '°C', false],
    ['SpO2 92–97%', '97', '%', false],
    ['SpO2 92 - 97%', '97', '%', false],
    ['PCV 30 – 32%', '32', '%', false],
    ['T 36·1°C', '1', '°C', false],
    ['T 36·1°C', '36', '°C', false],
    ['SpO2 97% HR 97', '97', '%', false],
    ['SpO2 97% (97%)', '97', '%', true],
  ])('in %s, %s is followed by %s: %s', (text, value, unit, expected) => {
    expect(unitAfter(text, value, unit)).toBe(expected);
  });

  it('takes out a unit written after a number, and keeps one written on its own', () => {
    expect(has(withoutNumberedUnit('SpO2 97 PCV 32%', '%'), '%')).toBe(false);
    expect(has(withoutNumberedUnit('SpO2 (%): 97', '%'), '%')).toBe(true);
    expect(has(withoutNumberedUnit('Temp (°C) 36.1°C', '°C'), '°C')).toBe(true);
  });
});

describe('combined strengths', () => {
  it('reads "a/b unit" as one strength, however it is spaced', () => {
    for (const text of ['80/480mg', '80/480 mg', '80 / 480 mg', '80 mg/480 mg', '80mg/480mg']) {
      expect(combinedStrengths(`Artemether/Lumefantrine ${text} bd`).map((found) => found.canonical))
        .toEqual(['80mg/480mg']);
    }
    expect(combinedStrengths('Coartem 20/120mg').map((found) => found.canonical)).toEqual(['20mg/120mg']);
    expect(combinedStrengths('1.80/480mg').map((found) => found.canonical)).toEqual(['1.80mg/480mg']);
    expect(combinedStrengths('BP 120/80 mmHg')).toEqual([]);
    expect(combinedStrengths('Ibuprofen 15mg/kg')).toEqual([]);
  });

  it('matches the same combined strength only', () => {
    expect(sameCombined('Artemether/Lumefantrine 80/480mg', '80 mg/480 mg')).toBe(true);
    expect(sameCombined('Artemether/Lumefantrine 80/480mg', '80/480 mg')).toBe(true);
    expect(sameCombined('Artemether/Lumefantrine 80/480mg', '20/120mg')).toBe(false);
    expect(sameCombined('Artemether/Lumefantrine 80/480mg', '480 mg')).toBe(false);
    expect(sameCombined('Artemether/Lumefantrine 180/480mg', '80/480mg')).toBe(false);
  });

  it('keeps refusing a part of a longer number', () => {
    expect(has('Artemether/Lumefantrine 80/480mg', '480mg')).toBe(false);
    expect(has('Drug 1480 mg', '480 mg')).toBe(false);
    expect(has('Drug 2.5 mg', '5 mg')).toBe(false);
  });

  it('refuses one part of a combined strength written with a unit on each part', () => {
    for (const text of ['Artemether/Lumefantrine 80 mg/480 mg', 'Artemether/Lumefantrine 80mg/480mg',
      'Artemether/Lumefantrine 80 mg / 480 mg']) {
      for (const part of ['80 mg', '80mg', '480 mg', '480mg']) expect(has(text, part)).toBe(false);
      expect(sameCombined(text, '80/480mg')).toBe(true);
    }
    expect(has('Ibuprofen 15mg/kg', '15mg')).toBe(false);
    expect(has('Paracetamol 500mg, Ibuprofen 400mg', '400mg')).toBe(true);
  });
});
