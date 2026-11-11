import { allergyTerms, matchAllergies, type AllergyForCheck } from './allergy-match';

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
      .toMatchObject({ matchKind: 'same_class', className: 'NSAIDs (anti-inflammatory painkillers)' });
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
    expect(matches[0]?.message).toContain('an allergy the patient reported (penicillin)');
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

  it('allergyTerms drops blank and none-like terms', () => {
    expect(allergyTerms('Penicillin / Sulfa\nnone; ')).toEqual(['Penicillin', 'Sulfa']);
  });
});
