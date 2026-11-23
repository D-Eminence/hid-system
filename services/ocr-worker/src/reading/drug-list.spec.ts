import { BRAND_ROWS, COORDINATOR_SOURCE, isActiveBrandRow, NAFDAC_SOURCE } from './brand-names';
import { BRAND_NAMES, BRANDS_WITH_UNLISTED_GENERIC, CHART_NAMES, DRUG_ENTRIES, drugLookalike, editDistance,
  LOOKALIKE_DISTANCE, matchDrugName, MAX_EDIT_DISTANCE, MIN_FUZZY_LETTERS, MIN_SIMILARITY, NEML_GENERICS,
  normaliseDrugName, SALT_OPEN_NAMES, SYNONYMS, UNLISTED_LOOKALIKES } from './drug-list';
import { SEVENTH_EDITION_NAMES } from './drug-list-7th-edition-fixtures';

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
    // The 7th edition list's names that the new list spells differently are still recognised.
    expect(matchDrugName('Chlorpheniramine')?.display).toBe('Chlorphenamine?');
    expect(matchDrugName('Benzhexol')?.generic).toBe('trihexyphenidyl');
    expect(matchDrugName('Sodium valproate')?.generic).toBe('valproic acid');
    expect(matchDrugName('Desferrioxamine')?.generic).toBe('deferoxamine');
    expect(matchDrugName('Ferrous sulphate')?.generic).toBe('ferrous sulfate');
    // Left unmapped on purpose (see the header): mapping would name a form the prescriber never wrote.
    for (const name of ['Fluticasone', 'Vitamin B12', 'Cyanocobalamin', 'Multivitamin', 'Vitamin E', 'Zinc']) {
      expect([name, matchDrugName(name)]).toEqual([name, null]);
    }
    expect(matchDrugName('Seretide')?.generic).toBe('salmeterol + fluticasone');
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
    // Under MIN_FUZZY_LETTERS letters: exact only ("urea" is listed).
    expect(matchDrugName('Urea')?.generic).toBe('urea');
    expect(matchDrugName('Urca')).toBeNull();
    // Ratio: a 6-letter name one letter changed is 0.83 similar, below MIN_SIMILARITY; one letter short of 7 passes.
    expect(matchDrugName('Quinin')?.generic).toBe('quinine');
    expect(matchDrugName('Flagyi')).toBeNull();
    expect([MIN_FUZZY_LETTERS, MAX_EDIT_DISTANCE, MIN_SIMILARITY, LOOKALIKE_DISTANCE]).toEqual([6, 1, 0.85, 2]);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('gives the listed medicine a look-alike would have been respelled into, for showing both (never picking one)', () => {
    // "Arteether" is one letter from the listed artemether: shown "Arteether? (or Artemether?)" on a hard page.
    expect(drugLookalike('Arteether')).toMatchObject({ generic: 'artemether', display: 'Artemether?' });
    // A listed name, a name too far from any listed one, and a name with no letter shapes: nothing to offer.
    for (const name of ['Artemether', 'Pefloxacin', 'Fictionalmab', '[?]', '[sign?]']) {
      expect([name, drugLookalike(name)]).toEqual([name, null]);
    }
    // No unlisted look-alike near: the strict match itself decides, and drugLookalike offers nothing.
    expect(matchDrugName('Metronidazol')?.generic).toBe('metronidazole');
    expect(drugLookalike('Metronidazol')).toBeNull();
  });

  it('never respells a real medicine that is not on the list into a listed one', () => {
    // Each of these is a different real medicine, one or two letters from a listed one.
    for (const name of ['Ganciclovir', 'Esomeprazole', 'Felodipine', 'Prednisone', 'Norfloxacin',
      'Pefloxacin', 'Gemifloxacin', 'Dicloxacillin', 'Arteether', 'Dihydralazine', 'Ornidazole', 'Econazole',
      'Bifonazole', 'Tioconazole', 'Methsuximide', 'Clobetasone', 'Oxazepam', 'Quinidine']) {
      expect([name, matchDrugName(name)]).toEqual([name, null]);
    }
    // The listed ones themselves still match exactly.
    for (const name of ['Aciclovir', 'Clonazepam', 'Omeprazole', 'Amlodipine', 'Prednisolone', 'Ofloxacin',
      'Cloxacillin', 'Artemether', 'Hydralazine', 'Tinidazole', 'Miconazole', 'Ethosuximide', 'Clobetasol',
      'Lorazepam', 'Valaciclovir', 'Folinic acid']) {
      expect(matchDrugName(name)?.exact).toBe(true);
    }
    // The look-alike pairs on the list stay apart.
    expect(matchDrugName('Carbimazole')?.generic).toBe('carbimazole');
    expect(matchDrugName('Carbamazepine')?.generic).toBe('carbamazepine');
    expect(matchDrugName('Cefuroxime')?.generic).toBe('cefuroxime');
    expect(matchDrugName('Metformin')?.generic).toBe('metformin');
    expect(matchDrugName('Chlorpropamide')).toBeNull();
    // Every unlisted look-alike is really off the list and within LOOKALIKE_DISTANCE of a listed name.
    const keys = DRUG_ENTRIES.map((entry) => entry.key);
    for (const name of UNLISTED_LOOKALIKES) {
      expect(keys).not.toContain(name);
      expect([name, Math.min(...keys.map((key) => editDistance(name, key))) <= LOOKALIKE_DISTANCE]).toEqual([name, true]);
    }
  });

  it('keeps each name the 7th edition list recognised: still recognised, or apart from the listed name it is near', () => {
    const keys = DRUG_ENTRIES.map((entry) => entry.key);
    const lookalikes = UNLISTED_LOOKALIKES.map(normaliseDrugName);
    for (const name of SEVENTH_EDITION_NAMES) {
      if (matchDrugName(name) !== null) continue;
      const key = normaliseDrugName(name);
      const near = keys.some((listed) => editDistance(key, listed) <= LOOKALIKE_DISTANCE);
      expect([name, near && !lookalikes.includes(key)]).toEqual([name, false]);
    }
    // Neomycin left the list and is two letters from bleomycin, a cytotoxic: a misreading of it is never bleomycin.
    for (const name of ['Beomycin', 'Bneomycin', 'Neomycin', 'Neomicin']) {
      expect([name, matchDrugName(name)]).toEqual([name, null]);
    }
    expect(drugLookalike('Beomycin')?.generic).toBe('bleomycin');
    expect(matchDrugName('Bleomycin')?.exact).toBe(true);
    for (const name of ['Vitamin B12', 'Vitamin E', 'Vitamin B 12']) {
      expect([name, matchDrugName(name)]).toEqual([name, null]);
    }
    expect(matchDrugName('Vitamin B1')?.generic).toBe('thiamine');
  });

  it('never makes a salt or product written on the chart less specific than the chart', () => {
    // Recognised as written, never as the list's broader name (lithium, calcium, ferrous salt,
    // intermediate-acting insulin).
    expect(matchDrugName('Lithium carbonate')?.display).toBe('Lithium carbonate?');
    expect(matchDrugName('Lithium citrate')?.display).toBe('Lithium citrate?');
    expect(matchDrugName('Ferrous sulfate')?.display).toBe('Ferrous sulfate?');
    expect(matchDrugName('Ferrous sulphate')?.display).toBe('Ferrous sulfate?');
    expect(matchDrugName('Calcium lactate')?.display).toBe('Calcium lactate?');
    expect(matchDrugName('Isophane insulin')?.display).toBe('Isophane insulin?');
    expect(matchDrugName('Lithum carbonate')?.display).toBe('Lithium carbonate?');
    // Another salt of a medicine the list leaves salt-open is shown as read, not as the bare name.
    for (const name of ['Lithium sulfate', 'Calcium phosphate', 'Calcium citrate', 'Calcium acetate', 'Lithium HCl']) {
      expect([name, matchDrugName(name), drugLookalike(name)]).toEqual([name, null, null]);
    }
    // The bare name, as written or with only form words, is still the listed one.
    expect(matchDrugName('Lithium')?.display).toBe('Lithium?');
    expect(matchDrugName('Lithium tabs')?.display).toBe('Lithium?');
    expect(matchDrugName('Calcium')?.display).toBe('Calcium?');
    // A salt word after any other medicine is still taken off, as before.
    expect(matchDrugName('Metformin hydrochloride')?.display).toBe('Metformin?');
    // Every salt word after a salt-open name: never the bare name.
    for (const listed of SALT_OPEN_NAMES) {
      expect(NEML_GENERICS).toContain(listed);
      for (const salt of ['hydrochloride', 'hcl', 'sodium', 'potassium', 'sulfate', 'sulphate', 'maleate', 'phosphate',
        'acetate', 'citrate']) {
        const found = matchDrugName(`${listed} ${salt}`);
        expect([listed, salt, found === null || CHART_NAMES.includes(found.generic)]).toEqual([listed, salt, true]);
      }
    }
    // Each chart name is its own name: not on the list, and no synonym or brand points at the broader name for it.
    for (const name of CHART_NAMES) {
      expect(NEML_GENERICS).not.toContain(name);
      expect(SYNONYMS[name]).toBeUndefined();
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
    for (const generic of Object.values(SYNONYMS)) {
      expect(generics.has(generic) || CHART_NAMES.includes(generic)).toBe(true);
    }
    for (const generic of Object.values(BRAND_NAMES)) {
      for (const part of generic.split(' + ')) expect(generics.has(part) || generics.has(generic)).toBe(true);
    }
  });

  it('keeps brands in a data table: active only with a NAFDAC Greenbook source or as one of the 23 curated before', () => {
    const columns = ['brand', 'generic', 'strength_forms', 'source', 'reviewed_by'];
    for (const row of BRAND_ROWS) {
      expect(Object.keys(row)).toEqual(columns);
      expect(['coordinator-curated', 'pending-pharmacist']).toContain(row.reviewed_by);
      expect(normaliseDrugName(row.brand)).toBe(row.brand);
      // A row is either NAFDAC-sourced (registration number and listing address) or one of the curated 23.
      expect([row.brand, NAFDAC_SOURCE.test(row.source) || row.source === COORDINATOR_SOURCE]).toEqual([row.brand, true]);
      if (row.reviewed_by === 'pending-pharmacist') expect(NAFDAC_SOURCE.test(row.source)).toBe(true);
      expect(isActiveBrandRow(row)).toBe(true);
    }
    const curated = BRAND_ROWS.filter((row) => row.reviewed_by === 'coordinator-curated');
    expect(curated).toHaveLength(23);
    expect(new Set(BRAND_ROWS.map((row) => row.brand)).size).toBe(BRAND_ROWS.length);
    // A row whose generic is not on the list is kept but not used.
    expect(BRANDS_WITH_UNLISTED_GENERIC).toEqual(['humulin']);
    expect(Object.keys(BRAND_NAMES)).toHaveLength(BRAND_ROWS.length - BRANDS_WITH_UNLISTED_GENERIC.length);
    expect(matchDrugName('Humulin')).toBeNull();
    // An unsourced new row, or a NAFDAC-looking source without a listing address, is not used.
    expect(isActiveBrandRow({ brand: 'fictionalbrand', generic: 'paracetamol', strength_forms: '', source: 'recalled',
      reviewed_by: 'pending-pharmacist' })).toBe(false);
    expect(isActiveBrandRow({ brand: 'fictionalbrand', generic: 'paracetamol', strength_forms: '',
      source: 'NAFDAC Greenbook, NRN 04-0000', reviewed_by: 'pending-pharmacist' })).toBe(false);
    expect(isActiveBrandRow({ brand: 'fictionalbrand', generic: 'paracetamol', strength_forms: '',
      source: COORDINATOR_SOURCE, reviewed_by: 'pending-pharmacist' })).toBe(false);
  });

  it('shows a NAFDAC-sourced brand as "Brand? (generic)", like the curated ones', () => {
    expect(matchDrugName('Lonart')).toEqual({ generic: 'artemether + lumefantrine', brand: 'lonart',
      display: 'Lonart? (artemether + lumefantrine)', exact: true });
    expect(matchDrugName('P-Alaxin')?.display).toBe('P-alaxin? (dihydroartemisinin + piperaquine)');
    expect(matchDrugName('Camosunate')?.generic).toBe('artesunate + amodiaquine');
    expect(matchDrugName('Mixtard')?.generic).toBe('biphasic isophane insulin');
    expect(matchDrugName('Piriton')?.display).toBe('Piriton? (chlorphenamine)');
    expect(matchDrugName('Epilim')?.generic).toBe('valproic acid');
    expect(matchDrugName('Tegretol')?.display).toBe('Tegretol? (carbamazepine)');
    expect(matchDrugName('Lpitr')).toBeNull();
    expect(matchDrugName('Lipittor')?.display).toBe('Lipitor? (atorvastatin)');
  });

  it('never takes a product sold under a brand name with other ingredients for that brand', () => {
    // On the Greenbook under these brand names with other active ingredients: never the single-generic brand.
    for (const name of ['Panadol Extra', 'Lofnac Plus', 'Piriton Expectorant', 'Ciprotab-TN', 'Galvusmet',
      'Co-Micardis', 'Gvither Plus', 'NovoMix 30']) {
      expect([name, matchDrugName(name)]).toEqual([name, null]);
    }
  });
});

