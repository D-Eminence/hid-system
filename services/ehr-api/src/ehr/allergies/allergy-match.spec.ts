import { allergyTerms, isNoKnownAllergy, matchAllergies, near, type AllergyForCheck } from './allergy-match';

const recorded = (substance: string, id = '123e4567-e89b-42d3-a456-426614174010'): AllergyForCheck =>
  ({ source: 'recorded', id, substance, reaction: 'Rash', severity: 'moderate' });
const reported = (text: string): AllergyForCheck => ({ source: 'patient_reported', substance: text });

describe('allergy matching (0124)', () => {
  it('matches the same medicine by generic name, whatever the strength or case', () => {
    const [match] = matchAllergies({ display: 'AMOXICILLIN 500 mg capsule' }, [recorded('Amoxicillin')]);
    expect(match).toMatchObject({ matchKind: 'same_medicine', source: 'recorded', substance: 'Amoxicillin',
      allergyId: '123e4567-e89b-42d3-a456-426614174010', reaction: 'Rash', severity: 'moderate' });
  });

  it('matches a brand name to its generic class', () => {
    expect(matchAllergies({ display: 'Augmentin 625 mg' }, [recorded('Penicillin')])[0])
      .toMatchObject({ matchKind: 'same_class', className: 'penicillins' });
  });

  it('matches a penicillin to a penicillin allergy by class', () => {
    expect(matchAllergies({ display: 'Flucloxacillin 250 mg' }, [recorded('Amoxicillin')])[0])
      .toMatchObject({ matchKind: 'same_class', className: 'penicillins' });
  });

  it('notes penicillin and cephalosporin cross-reactivity both ways', () => {
    const [toCeph] = matchAllergies({ display: 'Ceftriaxone 1 g injection' }, [recorded('Penicillin')]);
    expect(toCeph).toMatchObject({ matchKind: 'cross_reactivity', className: 'cephalosporins' });
    expect(toCeph?.message).toContain('Some people allergic to penicillins also react to cephalosporins');
    const [toPen] = matchAllergies({ display: 'Ampicillin' }, [recorded('Cefuroxime')]);
    expect(toPen).toMatchObject({ matchKind: 'cross_reactivity', className: 'penicillins' });
  });

  it('matches sulfonamides by class word and by member', () => {
    expect(matchAllergies({ display: 'Co-trimoxazole 960 mg' }, [recorded('Sulfa drugs')])[0])
      .toMatchObject({ matchKind: 'same_class' });
    expect(matchAllergies({ display: 'Fansidar (sulfadoxine/pyrimethamine)' }, [recorded('Septrin')])[0])
      .toMatchObject({ matchKind: 'same_class' });
  });

  it('matches NSAIDs', () => {
    expect(matchAllergies({ display: 'Diclofenac sodium 50 mg' }, [recorded('NSAIDs')])[0])
      .toMatchObject({ matchKind: 'same_class', className: 'NSAIDs, the anti-inflammatory painkillers' });
    expect(matchAllergies({ display: 'Ibuprofen 400 mg' }, [recorded('Aspirin')])[0])
      .toMatchObject({ matchKind: 'same_class' });
  });

  it('uses the medicine code too', () => {
    expect(matchAllergies({ display: 'Antibiotic capsule', code: 'amoxicillin' }, [recorded('Penicillin')]))
      .toHaveLength(1);
  });

  it('splits the patient\'s own text into terms and labels each match as patient reported', () => {
    const matches = matchAllergies({ display: 'Amoxicillin 500 mg' }, [reported('Peanuts, penicillin; dust')]);
    expect(matches).toEqual([expect.objectContaining({ source: 'patient_reported', substance: 'penicillin',
      matchKind: 'same_class' })]);
    expect(matches[0]?.message).toContain('Patient-reported allergy: “penicillin”.');
    expect(matches[0]).not.toHaveProperty('allergyId');
  });

  it('does not warn for unrelated medicines, unrelated allergies or "none"', () => {
    expect(matchAllergies({ display: 'Paracetamol 500 mg' }, [recorded('Penicillin'), recorded('Sulfa'),
      reported('Peanuts and eggs')])).toEqual([]);
    expect(matchAllergies({ display: 'Amoxicillin' }, [reported('None'), reported('NKDA'), reported('nil')])).toEqual([]);
    expect(matchAllergies({ display: 'Metformin 500 mg tablets' }, [recorded('Drug allergy to tablets')])).toEqual([]);
  });

  it('matches an allergy to a medicine outside the class map by its name', () => {
    expect(matchAllergies({ display: 'Metronidazole 400 mg' }, [recorded('metronidazole')])[0])
      .toMatchObject({ matchKind: 'same_medicine' });
  });

  it('reads hyphenated combination names as their parts', () => {
    expect(matchAllergies({ display: 'Amoxicillin-clavulanate 625 mg' }, [recorded('Amoxicillin')])[0])
      .toMatchObject({ matchKind: 'same_medicine' });
    expect(matchAllergies({ display: 'Amoxicillin-clavulanate 625 mg' }, [recorded('Penicillin')])[0])
      .toMatchObject({ matchKind: 'same_class', className: 'penicillins' });
    expect(matchAllergies({ display: 'Sulfamethoxazole-trimethoprim 960mg' }, [recorded('Sulfa drugs')])[0])
      .toMatchObject({ matchKind: 'same_class', className: 'sulfonamides (“sulfa” medicines)' });
    expect(matchAllergies({ display: 'Co-amoxiclav 625 mg' }, [recorded('Penicillin')])[0])
      .toMatchObject({ matchKind: 'same_class', className: 'penicillins' });
    expect(matchAllergies({ display: 'Co-trimoxazole 480 mg' }, [recorded('co-trimoxazole')])[0])
      .toMatchObject({ matchKind: 'same_medicine' });
  });

  it('reads "X-induced" and "X-sensitive" allergy notes as naming X', () => {
    expect(matchAllergies({ display: 'Amoxicillin 500mg' }, [recorded('Amoxicillin-induced rash')])[0])
      .toMatchObject({ matchKind: 'same_medicine' });
    expect(matchAllergies({ display: 'Ibuprofen 400mg' }, [recorded('Aspirin-sensitive asthma')])[0])
      .toMatchObject({ matchKind: 'same_class', className: 'NSAIDs, the anti-inflammatory painkillers' });
    expect(matchAllergies({ display: 'Diclofenac 50 mg' }, [recorded('Non-steroidal anti-inflammatory drugs')])[0])
      .toMatchObject({ matchKind: 'same_class' });
    expect(matchAllergies({ display: 'Paracetamol 500 mg' }, [recorded('Aspirin-induced rash')])).toEqual([]);
  });

  it('recognises Penicillin V and Penicillin G as penicillins', () => {
    expect(matchAllergies({ display: 'Penicillin V 250mg' }, [recorded('Penicillins')])[0])
      .toMatchObject({ matchKind: 'same_class', className: 'penicillins' });
    expect(matchAllergies({ display: 'Penicillin V' }, [recorded('Amoxicillin')])[0])
      .toMatchObject({ matchKind: 'same_class', className: 'penicillins' });
    expect(matchAllergies({ display: 'Penicillin V 250mg' }, [recorded('Cefalexin')])[0])
      .toMatchObject({ matchKind: 'cross_reactivity', className: 'penicillins' });
    expect(matchAllergies({ display: 'Penicillin G 1.2 MU injection' }, [recorded('Penicillins')])[0])
      .toMatchObject({ matchKind: 'same_class', className: 'penicillins' });
    expect(matchAllergies({ display: 'Phenoxymethylpenicillin 250mg' }, [recorded('Cefalexin')])[0])
      .toMatchObject({ matchKind: 'cross_reactivity' });
  });

  it('allergyTerms drops blank and none-like terms', () => {
    expect(allergyTerms('Penicillin / Sulfa\nnone; ')).toEqual(['Penicillin', 'Sulfa']);
  });

  it('does not read hyphen prefixes (anti-, non-, beta-, type) as the medicine\'s name', () => {
    expect(matchAllergies({ display: 'Anti-snake venom' }, [reported('anti-inflammatory drugs')])).toEqual([]);
    expect(matchAllergies({ display: 'Anti-D immunoglobulin 1500 IU' }, [recorded('Anti-TB drugs')])).toEqual([]);
    expect(matchAllergies({ display: 'Anti-tetanus serum' }, [recorded('Anti-malarials')])).toEqual([]);
    expect(matchAllergies({ display: 'Beta-carotene' }, [recorded('Beta-lactam antibiotics')])).toEqual([]);
    expect(matchAllergies({ display: 'Ibuprofen 400 mg' }, [recorded('Non-steroidal anti-inflammatory')])[0])
      .toMatchObject({ matchKind: 'same_class' });
    expect(matchAllergies({ display: 'Ibuprofen 400 mg' }, [reported('anti inflammatory drugs')])[0])
      .toMatchObject({ matchKind: 'same_class' });
  });

  it('recognises other penicillin names, "PCN" and "beta-lactams"', () => {
    for (const display of ['Amoxiclav 625 mg', 'Orbenin 500 mg', 'Floxapen 500 mg', 'Penbritin 500 mg', 'Clamoxyl 500 mg',
      'Unasyn 1.5 g', 'Pip-Tazo 4.5 g IV']) {
      expect(matchAllergies({ display }, [recorded('Penicillin')])[0]).toMatchObject({ matchKind: 'same_class' });
    }
    expect(matchAllergies({ display: 'Amoxicillin 500 mg' }, [recorded('PCN')])[0]).toMatchObject({ matchKind: 'same_class' });
    expect(matchAllergies({ display: 'Amoxicillin 500 mg' }, [recorded('beta-lactams')])[0])
      .toMatchObject({ matchKind: 'same_class' });
    expect(matchAllergies({ display: 'Insulin pen' }, [recorded('Penicillin')])).toEqual([]);
    expect(matchAllergies({ display: 'Amoxicillin 500 mg' }, [recorded('EpiPen')])).toEqual([]);
    expect(matchAllergies({ display: 'Amoxicillin 500 mg' }, [reported('Bee stings (carries Epi pen)')])).toEqual([]);
    expect(matchAllergies({ display: 'Amoxapine 50 mg' }, [recorded('Penicillin')])).toEqual([]);
  });

  it('covers the carbapenems and ceftazidime with aztreonam', () => {
    for (const display of ['Meropenem 1 g', 'Imipenem-cilastatin 500 mg', 'Ertapenem 1 g']) {
      expect(matchAllergies({ display }, [{ ...recorded('Penicillin'), severity: 'severe', reaction: 'Anaphylaxis' }])[0])
        .toMatchObject({ matchKind: 'cross_reactivity', className: 'carbapenems' });
    }
    expect(matchAllergies({ display: 'Meropenem 1 g' }, [recorded('Ceftriaxone')])[0])
      .toMatchObject({ matchKind: 'cross_reactivity', className: 'carbapenems' });
    expect(matchAllergies({ display: 'Ertapenem 1 g' }, [recorded('Meropenem')])[0])
      .toMatchObject({ matchKind: 'same_class', className: 'carbapenems' });
    const [aztreonam] = matchAllergies({ display: 'Aztreonam 1 g' }, [recorded('Ceftazidime')]);
    expect(aztreonam).toMatchObject({ matchKind: 'cross_reactivity' });
    expect(aztreonam?.message).toContain('Some people allergic to ceftazidime also react to aztreonam');
    expect(matchAllergies({ display: 'Ceftazidime 1 g' }, [recorded('Aztreonam')])[0])
      .toMatchObject({ matchKind: 'cross_reactivity' });
    expect(matchAllergies({ display: 'Aztreonam 1 g' }, [recorded('Penicillin')])).toEqual([]);
  });

  it('recognises sulfonamide and NSAID names', () => {
    expect(matchAllergies({ display: 'SP 3 tablets (IPTp)' }, [recorded('Sulpha')])[0]).toMatchObject({ matchKind: 'same_class' });
    for (const display of ['TMP-SMX 960 mg', 'Cotrim 960 mg', 'Sulfacetamide eye drops', 'Sulfadimidine 500 mg']) {
      expect(matchAllergies({ display }, [recorded('Sulfa')])[0]).toMatchObject({ matchKind: 'same_class' });
    }
    expect(matchAllergies({ display: 'Septrin 960 mg' }, [reported('Sulphur drugs')])[0]).toMatchObject({ matchKind: 'same_class' });
    for (const display of ['Ponstan 500 mg', 'Feldene 20 mg', 'Indocid 25 mg', 'Toradol 30 mg']) {
      expect(matchAllergies({ display }, [recorded('NSAIDs')])[0]).toMatchObject({ matchKind: 'same_class' });
    }
    expect(matchAllergies({ display: 'Celebrex 200 mg' }, [recorded('Aspirin')])[0]).toMatchObject({ matchKind: 'same_class' });
    expect(matchAllergies({ display: 'Ponstan 500 mg' }, [recorded('Diclofenac')])[0]).toMatchObject({ matchKind: 'same_class' });
    expect(matchAllergies({ display: 'Ibuprofen 400 mg' }, [recorded('ASA')])[0]).toMatchObject({ matchKind: 'same_class' });
    for (const display of ['Ferrous sulphate 200 mg', 'Magnesium sulphate 4 g', 'Furosemide 40 mg', 'Hydrochlorothiazide 25 mg',
      'Glibenclamide 5 mg', 'Acetazolamide 250 mg', 'Celecoxib 200 mg', 'Selenium sulfide shampoo']) {
      expect(matchAllergies({ display }, [recorded('Sulfa')])).toEqual([]);
    }
    expect(matchAllergies({ display: 'Paracetamol 1 g' }, [recorded('NSAIDs')])).toEqual([]);
  });

  it('reads a brand name as its generic, both ways', () => {
    const same = (display: string, allergy: string) =>
      expect(matchAllergies({ display }, [recorded(allergy)])[0]).toMatchObject({ matchKind: 'same_medicine' });
    same('Flagyl 400 mg', 'Metronidazole');
    same('Metronidazole 400 mg', 'Flagyl');
    same('Coartem 80/480', 'Artemether-lumefantrine');
    same('Amodiaquine 200 mg', 'Camoquin');
    same('Trimethoprim 200 mg', 'Septrin');
    same('Amoxil 500 mg', 'Amoxicillin');
    same('Co-trimoxazole 960 mg', 'Septrin');
    same('Ampiclox 500 mg', 'Ampicillin');
    same('Ibuprofen 400 mg', 'Brufen');
    same('Ceftriaxone 1 g', 'Rocephin');
    same('Amoxicillin 500 mg', 'Augmentin');
    expect(matchAllergies({ display: 'Augmentin 625 mg' }, [recorded('Penicillin')])[0])
      .toMatchObject({ matchKind: 'same_class', className: 'penicillins' });
  });

  it('allows one-letter misspellings and plurals of long names', () => {
    expect(matchAllergies({ display: 'Amoxicillin 500 mg' }, [recorded('Penicilin')])[0]).toMatchObject({ matchKind: 'same_class' });
    expect(matchAllergies({ display: 'Cefuroxime 500 mg' }, [recorded('Penicilin')])[0])
      .toMatchObject({ matchKind: 'cross_reactivity' });
    expect(matchAllergies({ display: 'Amoxicillin 500 mg' }, [reported('allergic to penicilin')])[0])
      .toMatchObject({ matchKind: 'same_class' });
    expect(matchAllergies({ display: 'Amoxicillin 500 mg' }, [recorded('Amoxicilin')])[0])
      .toMatchObject({ matchKind: 'same_medicine' });
    expect(matchAllergies({ display: 'Amoxicilin 500 mg' }, [recorded('Amoxicillin')])[0])
      .toMatchObject({ matchKind: 'same_medicine' });
    expect(matchAllergies({ display: 'Metronidazole 400 mg' }, [recorded('Metronidazol')])[0])
      .toMatchObject({ matchKind: 'same_medicine' });
    expect(matchAllergies({ display: 'Tetracycline 250 mg' }, [recorded('Tetracyclines')])[0])
      .toMatchObject({ matchKind: 'same_medicine' });
    for (const [display, allergy] of [['Prednisolone 5 mg', 'Prednisone'], ['Clonazepam 0.5 mg', 'Lorazepam'],
      ['Hydroxychloroquine 200 mg', 'Chloroquine'], ['Ciprofloxacin 500 mg', 'Levofloxacin']] as const) {
      expect(matchAllergies({ display }, [recorded(allergy)])).toEqual([]);
    }
    expect(near('amoxicilin', 'amoxicillin')).toBe(true);
    expect(near('metronidazole', 'metrondiazole')).toBe(true);
    expect(near('amoxicillin', 'ampicillin')).toBe(false);
    expect(near('amoxil', 'amoxyl')).toBe(false);
  });

  it('does not take salts, forms, strengths or "vitamin" and "vaccine" for the medicine\'s name', () => {
    const silent = (display: string, allergy: string) =>
      expect(matchAllergies({ display }, [recorded(allergy)])).toEqual([]);
    silent('Sodium chloride 0.9% infusion', 'Diclofenac sodium');
    silent('Folic acid 5 mg', 'Mefenamic acid');
    silent('Magnesium sulfate 4 g', 'Morphine sulfate');
    silent('Ferrous sulphate 200 mg', 'Quinine sulphate');
    silent('Ferrous sulphate 200 mg', 'Magnesium sulphate');
    silent('Potassium chloride 600 mg', 'Penicillin V potassium');
    silent('Tramadol hydrochloride 50 mg', 'Ciprofloxacin hydrochloride');
    silent('Chloroquine phosphate', 'Codeine phosphate');
    silent('Omeprazole 20 mg capsules', 'Amoxicillin capsules');
    silent('Paracetamol syrup 120 mg/5 ml', 'Amoxicillin syrup');
    silent('Paracetamol 1 g infusion', 'Metronidazole infusion');
    silent('Paracetamol 500mg', 'Amoxicillin 500mg');
    silent('Vitamin C 100 mg', 'Vitamin K');
    silent('Hepatitis B vaccine', 'Tetanus toxoid vaccine');
    silent('Sodium chloride 0.9%', 'Potassium chloride');
    const same = (display: string, allergy: string) =>
      expect(matchAllergies({ display }, [recorded(allergy)])[0]).toMatchObject({ matchKind: 'same_medicine' });
    same('Vitamin K 10 mg injection', 'Vitamin K');
    same('Phytomenadione (vitamin K1) 10 mg', 'Vitamin K');
    same('Morphine sulfate 10 mg', 'Morphine sulfate');
    same('Magnesium sulphate 4 g', 'Magnesium sulphate');
    same('Potassium chloride 600 mg', 'Potassium chloride');
    same('Diclofenac potassium 50 mg', 'Diclofenac sodium');
    same('Amoxicillin 500 mg', 'Amoxicillin trihydrate');
  });

  it('keeps warning for a salt, vitamin or vaccine written another way (sulph/sulf, K1, Hep B, bicarb)', () => {
    const same = (display: string, allergy: string) =>
      expect(matchAllergies({ display }, [recorded(allergy)])[0]).toMatchObject({ matchKind: 'same_medicine' });
    same('Magnesium sulphate 4 g', 'Magnesium sulfate');
    same('Magnesium sulfate 4 g', 'Magnesium sulphate');
    same('Vitamin K1 1 mg IM', 'Vitamin K');
    same('Konakion 10 mg injection', 'Vitamin K');
    same('Vitamin K 1 mg IM', 'Vitamin K1');
    same('Hepatitis B vaccine 1 ml', 'Hep B vaccine');
    same('Hep B vaccine 1 ml', 'Hepatitis B vaccine');
    same('Sodium bicarbonate 8.4% injection', 'Sodium bicarb');
    same('Sodium bicarb 600 mg', 'Sodium bicarbonate');
    const silent = (display: string, allergy: string) =>
      expect(matchAllergies({ display }, [recorded(allergy)])).toEqual([]);
    silent('Ferrous sulphate 200 mg', 'Sulpha');
    silent('Ferrous sulfate 200 mg', 'Sulfa');
    silent('Magnesium sulfate 4 g', 'Morphine sulphate');
    silent('Magnesium sulphate 4 g', 'Morphine sulfate');
    silent('Sodium chloride 0.9%', 'Sodium bicarbonate');
  });

  it('says the severity and reaction first, then why, in plain words', () => {
    const severe = { source: 'recorded' as const, id: 'a', substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'severe' };
    expect(matchAllergies({ display: 'Amoxicillin 500 mg capsules' }, [severe])[0]?.message)
      .toBe('Penicillin allergy: SEVERE (Anaphylaxis). This medicine is one of the penicillins, the same group.');
    expect(matchAllergies({ display: 'Amoxicillin 500 mg capsules' }, [{ ...severe, severity: 'mild', reaction: 'Rash' }])[0]?.message)
      .toBe('Penicillin allergy: mild (Rash). This medicine is one of the penicillins, the same group.');
    expect(matchAllergies({ display: 'Amoxicillin 500 mg' }, [{ ...severe, severity: 'unknown', reaction: null }])[0]?.message)
      .toBe('Penicillin allergy: severity not known. This medicine is one of the penicillins, the same group.');
    expect(matchAllergies({ display: 'Ceftriaxone 1 g' }, [severe])[0]?.message)
      .toBe('Penicillin allergy: SEVERE (Anaphylaxis). This medicine is a cephalosporin. Some people allergic to penicillins '
        + 'also react to cephalosporins: a risk, not a certainty.');
    expect(matchAllergies({ display: 'Ampicillin 500 mg' }, [{ ...severe, substance: 'Cefuroxime' }])[0]?.message)
      .toContain('This medicine is a penicillin. Some people allergic to cephalosporins also react to penicillins');
    expect(matchAllergies({ display: 'Metronidazole 400 mg' }, [{ ...severe, substance: 'Flagyl' }])[0]?.message)
      .toBe('Flagyl allergy: SEVERE (Anaphylaxis). This medicine may be, or may contain, the same medicine.');
    expect(matchAllergies({ display: 'Amoxicillin 500 mg' }, [reported('penicillin')])[0]?.message)
      .toBe('Patient-reported allergy: “penicillin”. This medicine is one of the penicillins, the same group. '
        + 'Entered by the patient in their Health ID portal, not checked by a clinician.');
  });

  it('says where and when an allergy was recorded, and shows the same allergy recorded twice as one line', () => {
    const at = (id: string, facilityId: string, recordedHere: boolean, day: string): AllergyForCheck => ({
      source: 'recorded', id, substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'severe', facilityId, recordedHere,
      recordedOn: new Date(`${day}T10:00:00Z`) });
    const [here] = matchAllergies({ display: 'Amoxicillin 500 mg' }, [at('a', 'f1', true, '2026-03-03')]);
    expect(here?.message).toBe('Penicillin allergy: SEVERE (Anaphylaxis). This medicine is one of the penicillins, the same group. '
      + 'Recorded by a clinician at this facility on 3 Mar 2026.');
    expect(here).toMatchObject({ recordedHere: true, allergyIds: ['a'] });
    const [elsewhere] = matchAllergies({ display: 'Amoxicillin 500 mg' }, [at('b', 'f2', false, '2026-03-03')]);
    expect(elsewhere?.message).toContain('Recorded by a clinician at another facility on 3 Mar 2026.');
    const both = matchAllergies({ display: 'Amoxicillin 500 mg capsules' },
      [at('a', 'f1', true, '2026-03-03'), at('b', 'f2', false, '2026-05-10')]);
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ allergyId: 'a', allergyIds: ['a', 'b'], recordedHere: true });
    expect(both[0]?.message).toBe('Penicillin allergy: SEVERE (Anaphylaxis). This medicine is one of the penicillins, the same group. '
      + 'Recorded by clinicians (recorded at 2 facilities), most recently on 10 May 2026.');
    // A different severity or reaction is its own line.
    expect(matchAllergies({ display: 'Amoxicillin 500 mg' },
      [at('a', 'f1', true, '2026-03-03'), { ...at('b', 'f2', false, '2026-03-03'), severity: 'mild', reaction: 'Rash' }]))
      .toHaveLength(2);
  });

  it('isNoKnownAllergy recognises "no known allergies" and the like', () => {
    for (const text of ['NKDA', 'nkda.', 'No known allergies', 'None', 'nil']) expect(isNoKnownAllergy(text)).toBe(true);
    for (const text of ['Penicillin', 'Nuts']) expect(isNoKnownAllergy(text)).toBe(false);
  });

  it('proves a member only by its prefix: Cefiderocol and Cephradine are cephalosporins', () => {
    expect(matchAllergies({ display: 'Cefiderocol 2 g' }, [recorded('Penicillin')])[0])
      .toMatchObject({ matchKind: 'cross_reactivity', className: 'cephalosporins' });
    expect(matchAllergies({ display: 'Cephradine 500 mg' }, [recorded('Penicillin')])[0])
      .toMatchObject({ matchKind: 'cross_reactivity', className: 'cephalosporins' });
  });

  /**
   * Every class member, written out by hand (not built from DRUG_CLASSES, so
   * removing a member fails its row). Each warns as the same group against the
   * class's own name, which proves the class membership and not a shared word.
   */
  const MEMBERS: [string, string][] = [
    ['amoxicillin', 'Penicillins'], ['amoxycillin', 'Penicillins'], ['ampicillin', 'Penicillins'],
    ['cloxacillin', 'Penicillins'], ['flucloxacillin', 'Penicillins'], ['dicloxacillin', 'Penicillins'],
    ['oxacillin', 'Penicillins'], ['nafcillin', 'Penicillins'], ['piperacillin', 'Penicillins'],
    ['ticarcillin', 'Penicillins'], ['benzylpenicillin', 'Penicillins'], ['phenoxymethylpenicillin', 'Penicillins'],
    ['penicillin', 'Penicillins'], ['penicillin v', 'Penicillins'], ['penicillin g', 'Penicillins'], ['pen v', 'Penicillins'],
    ['pen g', 'Penicillins'], ['phenoxymethyl', 'Penicillins'], ['benzathine', 'Penicillins'],
    ['procaine penicillin', 'Penicillins'], ['co-amoxiclav', 'Penicillins'], ['co amoxiclav', 'Penicillins'],
    ['coamoxiclav', 'Penicillins'], ['augmentin', 'Penicillins'], ['ampiclox', 'Penicillins'], ['amoxil', 'Penicillins'],
    ['tazocin', 'Penicillin'], ['pivmecillinam', 'Penicillins'], ['temocillin', 'Penicillins'], ['amoxiclav', 'Penicillins'],
    ['amoxyclav', 'Penicillins'], ['orbenin', 'Penicillins'], ['floxapen', 'Penicillins'], ['penbritin', 'Penicillins'],
    ['clamoxyl', 'Penicillins'], ['unasyn', 'Penicillins'], ['pip-tazo', 'Penicillins'],
    ['cefalexin', 'Cephalosporins'], ['cephalexin', 'Cephalosporins'], ['cefadroxil', 'Cephalosporins'],
    ['cefazolin', 'Cephalosporins'], ['cefaclor', 'Cephalosporins'], ['cefuroxime', 'Cephalosporins'],
    ['cefprozil', 'Cephalosporins'], ['cefixime', 'Cephalosporins'], ['cefpodoxime', 'Cephalosporins'],
    ['cefdinir', 'Cephalosporins'], ['cefotaxime', 'Cephalosporins'], ['ceftriaxone', 'Cephalosporins'],
    ['ceftazidime', 'Cephalosporins'], ['cefepime', 'Cephalosporins'], ['ceftaroline', 'Cephalosporins'],
    ['cefoxitin', 'Cephalosporins'], ['zinnat', 'Cephalosporins'], ['rocephin', 'Cephalosporins'],
    ['meropenem', 'Carbapenems'], ['imipenem', 'Carbapenems'], ['ertapenem', 'Carbapenems'], ['doripenem', 'Carbapenems'],
    ['meronem', 'Carbapenems'], ['tienam', 'Carbapenems'],
    ['sulfamethoxazole', 'Sulfa'], ['sulphamethoxazole', 'Sulfa'], ['co-trimoxazole', 'Sulfa'], ['co trimoxazole', 'Sulfa'],
    ['cotrimoxazole', 'Sulfa'], ['trimethoprim-sulfamethoxazole', 'Sulfa'], ['septrin', 'Sulfa'], ['bactrim', 'Sulfa'],
    ['sulfadiazine', 'Sulfa'], ['sulphadiazine', 'Sulfa'], ['sulfadoxine', 'Sulfa'], ['sulphadoxine', 'Sulfa'],
    ['fansidar', 'Sulfa'], ['sulfasalazine', 'Sulfa'], ['sulphasalazine', 'Sulfa'], ['silver sulfadiazine', 'Sulfa'],
    ['sp', 'Sulfa'], ['smx', 'Sulfa'], ['cotrim', 'Sulfa'],
    ['ibuprofen', 'NSAIDs'], ['diclofenac', 'NSAIDs'], ['naproxen', 'NSAIDs'], ['aspirin', 'NSAIDs'],
    ['acetylsalicylic', 'NSAIDs'], ['piroxicam', 'NSAIDs'], ['indomethacin', 'NSAIDs'], ['indometacin', 'NSAIDs'],
    ['ketoprofen', 'NSAIDs'], ['meloxicam', 'NSAIDs'], ['celecoxib', 'NSAIDs'], ['etoricoxib', 'NSAIDs'],
    ['mefenamic', 'NSAIDs'], ['ketorolac', 'NSAIDs'], ['aceclofenac', 'NSAIDs'], ['flurbiprofen', 'NSAIDs'],
    ['nabumetone', 'NSAIDs'], ['etodolac', 'NSAIDs'], ['voltaren', 'NSAIDs'], ['brufen', 'NSAIDs'], ['cataflam', 'NSAIDs'],
    ['felvin', 'NSAIDs'], ['ponstan', 'NSAIDs'], ['feldene', 'NSAIDs'], ['celebrex', 'NSAIDs'], ['indocid', 'NSAIDs'],
    ['toradol', 'NSAIDs'], ['mobic', 'NSAIDs'], ['arcoxia', 'NSAIDs'], ['nurofen', 'NSAIDs'], ['naprosyn', 'NSAIDs'],
    ['asa', 'NSAIDs'],
  ];
  it.each(MEMBERS)('%s warns against %s', (member, allergy) =>
    expect(matchAllergies({ display: `${member} 500 mg` }, [recorded(allergy)])[0])
      .toMatchObject({ matchKind: 'same_class' }));
});
