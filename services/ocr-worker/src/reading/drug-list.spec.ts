import { BRAND_NAMES, editDistance, LOOKALIKE_DISTANCE, matchDrugName, MAX_EDIT_DISTANCE, MIN_FUZZY_LETTERS,
  MIN_SIMILARITY, NEML_GENERICS, normaliseDrugName, SYNONYMS, UNLISTED_LOOKALIKES } from './drug-list';

describe('drug list (hard pages only)', () => {
  it('shows a listed generic in its list spelling, marked as a guess', () => {
    expect(matchDrugName('metronidazole')).toEqual({ generic: 'metronidazole', brand: null, display: 'Metronidazole?',
      exact: true });
    expect(matchDrugName('PARACETAMOL?')?.display).toBe('Paracetamol?');
    expect(matchDrugName('Pyrimethamine')?.display).toBe('Pyrimethamine?');
    // Salt and form words do not change the medicine.
    expect(matchDrugName('Metformin HCl tab')?.generic).toBe('metformin');
    expect(matchDrugName('Amoxicillin/Clavulanic acid')?.generic).toBe('amoxicillin + clavulanic acid');
  });

  it('shows a brand as "Brand? (generic)"', () => {
    expect(matchDrugName('Plasil')).toEqual({ generic: 'metoclopramide', brand: 'plasil', display: 'Plasil? (metoclopramide)',
      exact: true });
    expect(matchDrugName('flagyl?')?.display).toBe('Flagyl? (metronidazole)');
    expect(matchDrugName('Augmentin')?.display).toBe('Augmentin? (amoxicillin + clavulanic acid)');
    expect(matchDrugName('Rocephin')?.generic).toBe('ceftriaxone');
    expect(matchDrugName('Zinnat')?.generic).toBe('cefuroxime');
  });

  it('maps the list\'s own other names and a few marked British names to the shown name', () => {
    expect(matchDrugName('Adrenaline')?.display).toBe('Epinephrine?');
    expect(matchDrugName('Frusemide')?.display).toBe('Furosemide?');
    expect(matchDrugName('Co-trimoxazole')?.generic).toBe('sulfamethoxazole + trimethoprim');
    expect(matchDrugName('Phenobarbitone')?.display).toBe('Phenobarbital?');
    expect(matchDrugName('Glyburide')?.generic).toBe('glibenclamide');
  });

  it('corrects one slip within the thresholds, and no further', () => {
    // Distance 1 on names of six letters or more, same first letter.
    expect(matchDrugName('Metronidazol')).toMatchObject({ display: 'Metronidazole?', exact: false });
    expect(matchDrugName('Ceftriaxon')?.generic).toBe('ceftriaxone');
    expect(matchDrugName('Plasill')?.display).toBe('Plasil? (metoclopramide)');
    expect(matchDrugName('Gentamycin')?.generic).toBe('gentamicin');
    // Distance 2 or 3: no match.
    expect(matchDrugName('Metrondazol')).toBeNull();
    expect(matchDrugName('Metrnidzol')).toBeNull();
    // A slip at the first letter: no match.
    expect(matchDrugName('Netronidazole')).toBeNull();
    // Under MIN_FUZZY_LETTERS letters: exact only ("zinc", "urea" are listed).
    expect(matchDrugName('Zinc')?.generic).toBe('zinc');
    expect(matchDrugName('Zink')).toBeNull();
    // Ratio: a 6-letter name one letter changed is 0.83 similar, below MIN_SIMILARITY; one letter short of 7 passes.
    expect(matchDrugName('Quinin')?.generic).toBe('quinine');
    expect(matchDrugName('Flagyi')).toBeNull();
    expect([MIN_FUZZY_LETTERS, MAX_EDIT_DISTANCE, MIN_SIMILARITY, LOOKALIKE_DISTANCE]).toEqual([6, 1, 0.85, 2]);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('never respells a real medicine that is not on the list into a listed one', () => {
    // Each of these is a different real medicine, one or two letters from a listed one.
    for (const name of ['Ganciclovir', 'Lorazepam', 'Esomeprazole', 'Felodipine', 'Prednisone', 'Norfloxacin',
      'Pefloxacin', 'Gemifloxacin', 'Dicloxacillin', 'Arteether', 'Dihydralazine', 'Ornidazole', 'Econazole',
      'Bifonazole', 'Tioconazole', 'Methsuximide', 'Clobetasone', 'Valaciclovir', 'Oxazepam', 'Quinidine']) {
      expect([name, matchDrugName(name)]).toEqual([name, null]);
    }
    // The listed ones themselves still match exactly.
    for (const name of ['Aciclovir', 'Clonazepam', 'Omeprazole', 'Amlodipine', 'Prednisolone', 'Ofloxacin',
      'Gatifloxacin', 'Cloxacillin', 'Artemether', 'Hydralazine', 'Tinidazole', 'Miconazole', 'Ethosuximide',
      'Clobetasol']) {
      expect(matchDrugName(name)?.exact).toBe(true);
    }
    // The look-alike pairs on the list stay apart.
    expect(matchDrugName('Carbimazole')?.generic).toBe('carbimazole');
    expect(matchDrugName('Carbamazepine')?.generic).toBe('carbamazepine');
    expect(matchDrugName('Cefuroxime')?.generic).toBe('cefuroxime');
    expect(matchDrugName('Metformin')?.generic).toBe('metformin');
    expect(matchDrugName('Chlorpropamide')).toBeNull();
    // Every unlisted look-alike is really off the list and within LOOKALIKE_DISTANCE of a listed name.
    const keys = [...NEML_GENERICS, ...Object.keys(SYNONYMS), ...Object.keys(BRAND_NAMES)].map(normaliseDrugName);
    for (const name of UNLISTED_LOOKALIKES) {
      expect(keys).not.toContain(name);
      expect([name, Math.min(...keys.map((key) => editDistance(name, key))) <= LOOKALIKE_DISTANCE]).toEqual([name, true]);
    }
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
