import { BRAND_NAMES, editDistance, matchDrugName, MAX_EDIT_DISTANCE, MIN_FUZZY_LETTERS, MIN_SIMILARITY, NEML_GENERICS,
  normaliseDrugName, SYNONYMS } from './drug-list';

describe('drug list (hard pages only)', () => {
  it('shows a listed generic in its list spelling, marked as a guess', () => {
    expect(matchDrugName('metronidazole')).toEqual({ generic: 'metronidazole', brand: null, display: 'Metronidazole?' });
    expect(matchDrugName('PARACETAMOL?')?.display).toBe('Paracetamol?');
    expect(matchDrugName('Pyrimethamine')?.display).toBe('Pyrimethamine?');
    // Salt and form words do not change the medicine.
    expect(matchDrugName('Metformin HCl tab')?.generic).toBe('metformin');
    expect(matchDrugName('Amoxicillin/Clavulanic acid')?.generic).toBe('amoxicillin + clavulanic acid');
  });

  it('shows a brand as "Brand? (generic)"', () => {
    expect(matchDrugName('Plasil')).toEqual({ generic: 'metoclopramide', brand: 'plasil', display: 'Plasil? (metoclopramide)' });
    expect(matchDrugName('flagyl?')?.display).toBe('Flagyl? (metronidazole)');
    expect(matchDrugName('Augmentin')?.display).toBe('Augmentin? (amoxicillin + clavulanic acid)');
    expect(matchDrugName('Rocephin')?.generic).toBe('ceftriaxone');
    expect(matchDrugName('Zinnat')?.generic).toBe('cefuroxime');
  });

  it('maps the list\'s own other names and a few marked British names to the shown name', () => {
    expect(matchDrugName('Adrenaline')?.display).toBe('Epinephrine?');
    expect(matchDrugName('Frusemide')?.display).toBe('Furosemide?');
    expect(matchDrugName('Co-trimoxazole')?.generic).toBe('sulfamethoxazole + trimethoprim');
  });

  it('corrects a misspelling within the thresholds, and no further', () => {
    // Distance 1 and 2 on names of six letters or more.
    expect(matchDrugName('Metronidazol')?.display).toBe('Metronidazole?');
    expect(matchDrugName('Metrondazol')?.display).toBe('Metronidazole?');
    expect(matchDrugName('Ceftriaxon')?.generic).toBe('ceftriaxone');
    expect(matchDrugName('Plasill')?.display).toBe('Plasil? (metoclopramide)');
    // Distance 3: no match.
    expect(matchDrugName('Metrnidzol')).toBeNull();
    // Under MIN_FUZZY_LETTERS letters: exact only ("zinc", "urea" are listed).
    expect(matchDrugName('Zinc')?.generic).toBe('zinc');
    expect(matchDrugName('Zink')).toBeNull();
    // Ratio: a 6-letter name 2 edits away is 0.67 similar, below MIN_SIMILARITY.
    expect(matchDrugName('Quinin')?.generic).toBe('quinine');
    expect(matchDrugName('Qunnin')).toBeNull();
    expect([MIN_FUZZY_LETTERS, MAX_EDIT_DISTANCE, MIN_SIMILARITY]).toEqual([6, 2, 0.8]);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('never shows an unlisted name, an unreadable one, or one of two lookalikes', () => {
    expect(matchDrugName('Fictionalmab')).toBeNull();
    expect(matchDrugName('Hydroxyzine')).toBeNull();
    expect(matchDrugName('[unreadable]')).toBeNull();
    expect(matchDrugName('Metro[unreadable]')).toBeNull();
    expect(matchDrugName('??')).toBeNull();
    expect(matchDrugName('')).toBeNull();
    // Equally close (one letter) to two different medicines, albendazole and mebendazole: no match.
    expect(matchDrugName('Mlbendazole')).toBeNull();
    expect(matchDrugName('Albendazol')?.generic).toBe('albendazole');
  });

  it('only checks a proposed name: the list never adds a drug', () => {
    // A listed name is returned for exactly the medicine proposed; nothing else is ever produced.
    for (const name of ['Paracetamol', 'Artesunate', 'Amlodipine']) {
      expect(matchDrugName(name)?.generic).toBe(name.toLowerCase());
    }
    expect(matchDrugName('Tab 1 bd')).toBeNull();
  });

  it('keeps every entry normalised, unique and every brand and synonym mapped to listed generics', () => {
    const generics = new Set(NEML_GENERICS);
    expect(generics.size).toBe(NEML_GENERICS.length);
    for (const name of NEML_GENERICS) expect(normaliseDrugName(name)).toBe(name);
    for (const generic of Object.values(SYNONYMS)) expect(generics.has(generic)).toBe(true);
    for (const generic of Object.values(BRAND_NAMES)) {
      for (const part of generic.split(' + ')) expect(generics.has(part) || generics.has(generic)).toBe(true);
    }
  });
});
