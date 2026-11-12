import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  itemSuggestions, linkedFieldPairs, listValue, observationsFor, pairsAreSensitive, readDigest, readingMayLearn,
  readKey, showingsFor, suggestionKeys,
} from './learning';
import { itemIsSensitive, SENSITIVE_BRANDS, SENSITIVE_CLASSES_VERSION, valueIsSensitive } from './sensitive-classes';

// Fictional fixtures only: invented ids; real medicine and test names from the lists.
const id = (n: number) => `it-${n.toString(16).padStart(16, '0')}`;
const medicine = (n: number, fields: Record<string, unknown>) => ({ id: id(n), kind: 'medicine', page: 1,
  asWritten: `${fields.name} ${fields.strength ?? ''}`, plain: 'x', fields: { form: null, route: null, ...fields } });
const lab = (n: number, fields: Record<string, unknown>) => ({ id: id(n), kind: 'lab_result', page: 2,
  asWritten: `${fields.test}`, plain: 'x', fields });
const payload = (items: unknown[]) => ({ contract: 'hid-paper-reading-v2', items });

describe('lists copied from the OCR worker', () => {
  const worker = resolve(__dirname, '../../../../ocr-worker/src/reading');
  it.each(['list-match', 'drug-list', 'brand-names', 'diagnosis-list', 'lab-list'])('%s.ts is a byte-for-byte copy',
    (name) => {
      expect(readFileSync(resolve(__dirname, 'lists', `${name}.ts`), 'utf8'))
        .toBe(readFileSync(resolve(worker, `${name}.ts`), 'utf8'));
    });
});

describe('closed-list values', () => {
  it('takes exact list names in the list spelling, never a respelling', () => {
    expect(listValue('name', 'amoxicillin')).toBe('Amoxicillin');
    expect(listValue('name', 'Tab Paracetamol')).toBe('Paracetamol');
    expect(listValue('name', 'Amoxicilin')).toBeNull();
    expect(listValue('name', 'Fictional Patient Ngozi')).toBeNull();
  });
  it('takes strengths, frequency codes, lab tests and units in their normal form', () => {
    expect(listValue('strength', '500 mg')).toBe('500mg');
    expect(listValue('strength', '.5 mg')).toBe('0.5mg');
    expect(listValue('strength', 'half')).toBeNull();
    expect(listValue('frequency', 'twice daily')).toBe('bd');
    expect(listValue('frequency', 'whenever')).toBeNull();
    expect(listValue('test', 'FBC')).toBe('Full blood count');
    expect(listValue('unit', 'mg / dl')).toBe('mg/dl');
    expect(listValue('unit', 'parsecs')).toBeNull();
    expect(listValue('diagnosis', 'Malaria')).toBeNull();
    expect(listValue('name', undefined)).toBeNull();
  });
});

describe('digests', () => {
  it('is SHA-256 of the prefix, the field and the normalised value', () => {
    expect(readKey('strength', '5 mg')).toBe('5mg');
    expect(readKey('frequency', 'b.d.')).toBe('bd');
    expect(readDigest('name', 'amoxicilin')).toBe(
      createHash('sha256').update('hid.ocr.learning/v1|name|amoxicilin').digest('hex'));
    expect(readDigest('name', 'amoxicilin')).toMatch(/^[0-9a-f]{64}$/);
    expect(readDigest('strength', 'amoxicilin')).not.toBe(readDigest('name', 'amoxicilin'));
  });
});

describe('observations', () => {
  const reading = payload([
    medicine(1, { name: 'Amoxicilin', strength: '500 mg', frequency: 'tds' }),
    medicine(2, { name: 'Paracetamol', strength: '1g', frequency: 'qds' }),
    lab(3, { test: 'FCB', unit: 'g/dl', value: '12' }),
  ]);
  it('sends one per corrected field of a linked item: the digest, and the list value or NULL', () => {
    const pairs = linkedFieldPairs('PHARMACY', { medications: [
      { itemId: id(1), medicationText: 'Amoxicillin', strengthText: '500mg', frequencyText: 'three times daily' },
      { itemId: id(2), medicationText: 'Paracetamol', strengthText: 'one gram', frequencyText: 'qds' },
      { medicationText: 'Typed by the reviewer' },
    ] }, reading);
    const observations = observationsFor(pairs);
    expect(observations).toEqual([
      { field: 'name', readDigest: readDigest('name', 'amoxicilin'), suggestValue: 'Amoxicillin' },
      { field: 'strength', readDigest: readDigest('strength', '1g'), suggestValue: null },
    ]);
    expect(JSON.stringify(observations)).not.toMatch(/Amoxicilin|Typed|one gram/);
  });
  it('takes Lab test names and units; EHR and unlinked entries teach nothing', () => {
    const labPairs = linkedFieldPairs('LAB', { observations: [{ itemId: id(3), testName: 'Full blood count',
      unit: 'g/dL' }] }, reading);
    expect(observationsFor(labPairs)).toEqual([
      { field: 'test', readDigest: readDigest('test', 'fcb'), suggestValue: 'Full blood count' }]);
    expect(linkedFieldPairs('EHR', { content: 'Amoxicillin' }, reading)).toEqual([]);
    expect(linkedFieldPairs('PHARMACY', { medicationText: 'Amoxicillin' }, reading)).toEqual([]);
    expect(linkedFieldPairs('PHARMACY', { medications: [{ itemId: id(3), medicationText: 'x' }] }, reading)).toEqual([]);
  });
});

describe('what never becomes evidence', () => {
  const reading = payload([medicine(1, { name: 'Amoxicilin' }), medicine(2, { name: 'Amoxicilin' }),
    medicine(3, { name: 'Lamivir' }), medicine(4, { name: 'Adrenaline' })]);
  const pairsOf = (medications: Record<string, unknown>[]) =>
    linkedFieldPairs('PHARMACY', { medications }, reading).filter((pair) => pair.field === 'name');
  it('a sensitive value saved on a reading that never named it (review skipped)', () => {
    expect(pairsAreSensitive(pairsOf([{ itemId: id(3), medicationText: 'Lamivudine' }]))).toBe(true);
    expect(pairsAreSensitive(pairsOf([{ itemId: id(1), medicationText: 'Amoxicillin' }]))).toBe(false);
  });
  it('a field where a suggestion was shown (a rule never feeds itself)', () => {
    const shown = new Map([[id(1), { field: 'name' as const, value: 'Amoxicillin', text: 't', ruleId: 'r', scope: 'facility' as const }]]);
    expect(observationsFor(pairsOf([{ itemId: id(1), medicationText: 'Amoxicillin' }]), shown)).toEqual([]);
  });
  it('another spelling of the same list entry (a synonym)', () => {
    expect(observationsFor(pairsOf([{ itemId: id(4), medicationText: 'Epinephrine' }]))).toEqual([]);
  });
  it('two items with one key saved differently are one conflict', () => {
    expect(observationsFor(pairsOf([{ itemId: id(1), medicationText: 'Amoxicillin' },
      { itemId: id(2), medicationText: 'Ampicillin' }]))).toEqual([
      { field: 'name', readDigest: readDigest('name', 'amoxicilin'), suggestValue: null }]);
    expect(observationsFor(pairsOf([{ itemId: id(1), medicationText: 'Amoxicillin' },
      { itemId: id(2), medicationText: 'amoxicillin' }]))).toEqual([
      { field: 'name', readDigest: readDigest('name', 'amoxicilin'), suggestValue: 'Amoxicillin' }]);
  });
});

describe('suggestions and showings', () => {
  const reading = payload([medicine(1, { name: 'Amoxicilin', strength: '500 mg', frequency: 'tds' }),
    medicine(2, { name: 'Paracetamol', strength: '1g' })]);
  const keys = suggestionKeys(reading);
  const rules = [
    { field: 'strength' as const, readDigest: readDigest('strength', '500mg'), ruleId: 'r-strength', scope: 'facility' as const, value: '250mg' },
    { field: 'name' as const, readDigest: readDigest('name', 'amoxicilin'), ruleId: 'r-name', scope: 'platform' as const, value: 'Amoxicillin' },
  ];
  it('never shows a sensitive suggestion, whatever a rule holds', () => {
    const sensitive = [{ ...rules[1]!, value: 'Lamivudine' }];
    expect(itemSuggestions(keys, sensitive).size).toBe(0);
  });
  it('shows one suggestion per item, the name first, as a plain sentence', () => {
    const shown = itemSuggestions(keys, rules);
    expect(shown.get(id(1))).toEqual({ field: 'name', value: 'Amoxicillin', ruleId: 'r-name', scope: 'platform',
      text: 'Possibly Amoxicillin? Check the paper' });
    expect(shown.has(id(2))).toBe(false);
  });
  it('counts a suggestion taken when the saved value is the suggested list value', () => {
    const shown = itemSuggestions(keys, rules);
    const taken = linkedFieldPairs('PHARMACY', { medications: [{ itemId: id(1), medicationText: 'amoxicillin' }] }, reading);
    expect(showingsFor(taken, shown)).toEqual([{ ruleId: 'r-name', outcome: 'accepted' }]);
    const notTaken = linkedFieldPairs('PHARMACY', { medications: [{ itemId: id(1), medicationText: 'Ampicillin' }] }, reading);
    expect(showingsFor(notTaken, shown)).toEqual([{ ruleId: 'r-name', outcome: 'rejected' }]);
    expect(showingsFor([], shown)).toEqual([]);
  });
});

describe('sensitive classes', () => {
  it.each([
    ['an ARV by name', medicine(1, { name: 'Tenofovir' })],
    ['an ARV regimen as written', medicine(1, { name: 'TDF/3TC/DTG' })],
    ['a TB regimen', medicine(1, { name: 'RHZE' })],
    ['an antipsychotic', medicine(1, { name: 'Haloperidol' })],
    ['hydroxyurea', medicine(1, { name: 'Hydroxyurea' })],
    ['an HIV test', lab(1, { test: 'Retroviral screening' })],
    ['a genotype', lab(1, { test: 'Hb genotype' })],
    ['a TB diagnosis', { id: id(1), kind: 'diagnosis', asWritten: 'PTB', fields: { name: 'PTB' } }],
    ['a mental-health diagnosis', { id: id(1), kind: 'diagnosis', asWritten: 'Schizophrenia', fields: {} }],
    ['sickle cell', { id: id(1), kind: 'diagnosis', asWritten: 'SCD in crisis', fields: {} }],
    ['indinavir', medicine(1, { name: 'Indinavir' })],
    ['pimozide', medicine(1, { name: 'Pimozide' })],
    ['thioacetazone', medicine(1, { name: 'Thioacetazone' })],
  ])('marks %s sensitive, and the whole reading teaches nothing', (_name, item) => {
    expect(itemIsSensitive(item)).toBe(true);
    expect(readingMayLearn(payload([medicine(2, { name: 'Paracetamol' }), item]))).toBe(false);
  });
  it('marks a reading sensitive from a page line that never became an item', () => {
    expect(readingMayLearn({ ...payload([medicine(1, { name: 'Paracetamol' })]),
      pages: [{ page: 1, lines: [{ id: 'p1-l1', text: 'RVS +ve, seen at the ART clinic' }] }] })).toBe(false);
    expect(valueIsSensitive('Hiv screening test')).toBe(true);
    expect(valueIsSensitive('Haemoglobin genotype')).toBe(true);
    expect(valueIsSensitive('Amoxicillin')).toBe(false);
  });
  it('leaves ordinary items alone', () => {
    expect(readingMayLearn(payload([medicine(1, { name: 'Amoxicillin', strength: '500mg' }),
      lab(2, { test: 'FBC' }), { id: id(3), kind: 'diagnosis', asWritten: 'Malaria', fields: {} }]))).toBe(true);
    expect(SENSITIVE_CLASSES_VERSION).toBe('hid.ocr.sensitive/v2');
  });
  it.each(['Atripla', 'Truvada 1 tab daily', 'TRUVADA', 'Kaletra 2 tabs bd', 'Aluvia', 'Descovy', 'Biktarvy',
    'Triumeq', 'Combivir', 'Trizivir', 'Symfi Lo', 'Odefsey', 'Genvoya', 'Stribild', 'Juluca', 'Dovato', 'Duovir-N',
    'Duovir N', 'PrEP', 'on PrEP since March', 'PEP x 28 days', 'post-exposure prophylaxis', 'Rifinah', 'Rifafour',
    'Sirturo', 'Largactil 100mg nocte', 'Haldol', 'Prozac', 'Hydrea', 'Siklos', 'Niprisan', 'Ciklavit'])(
    'marks the brand or word %s sensitive (v2)', (value) => {
      expect(valueIsSensitive(value)).toBe(true);
      expect(itemIsSensitive(medicine(1, { name: value }))).toBe(true);
      expect(readingMayLearn({ ...payload([medicine(1, { name: 'Paracetamol' })]),
        pages: [{ page: 1, lines: [{ id: 'p1-l1', text: `Plan: ${value}` }] }] })).toBe(false);
    });
  it('marks every listed brand sensitive, in any case', () => {
    for (const brand of Object.values(SENSITIVE_BRANDS).flat()) {
      expect([brand, brand.toUpperCase()].map(valueIsSensitive)).toEqual([true, true]);
    }
  });
  it.each(['Augmentin', 'Panadol', 'Coartem', 'Flagyl', 'Amoxil', 'Lonart', 'Emzor paracetamol', 'Preparation H',
    'Pepsi', 'Peptic ulcer disease', 'Truvadax'])('leaves %s alone (whole words only)', (value) => {
    expect(valueIsSensitive(value)).toBe(false);
  });
});
