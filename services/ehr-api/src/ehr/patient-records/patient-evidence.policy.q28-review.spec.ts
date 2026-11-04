import { SENSITIVE_TEST_SQL_PATTERN, isSensitiveTest, patientEvidence, type PatientProfileInput } from './patient-evidence.policy';
import { evidence, type Evidence, type SourceKind } from './patient-evidence.types';

// Review of Ola's Q28 lists: gaps that reached the patient chat, and over-matching that hid ordinary records. Fictional records only.
const profile: PatientProfileInput = { firstName: 'Ngozi', lastName: 'Okafor', fullName: 'Ngozi Okafor', dateOfBirth: '1988-02-14', gender: 'female' };
const today = new Date('2026-11-04T09:00:00.000Z');
const encounterId = '60000000-0000-4000-8000-000000000128';
const completed = { _encounterId: encounterId, _encounterStatus: 'completed' };
let n = 0;
const record = (kind: SourceKind, fields: Record<string, unknown>, title: string) => {
  n += 1;
  return evidence({ kind, id: `12812812-8128-4128-8128-${String(n).padStart(12, '0')}`, version: '1', title,
    recordedAt: '2026-10-01T10:00:00.000Z', effectiveAt: null, provenance: 'Synthetic provenance', quality: 'recorded', fields });
};
const kept = (input: Evidence) => patientEvidence([input], profile, today).length === 1;
const diagnosis = (condition: string, code = 'SYN-1', codeSystem = 'http://snomed.info/sct') => record('diagnosis', { _encounterId: encounterId,
  codeSystem, code, condition, clinicalStatus: 'active', verificationStatus: 'confirmed', onsetAt: null, abatementAt: null }, condition);
const prescription = (medication: string, more: Record<string, unknown> = {}) => record('prescription', { ...completed, medication,
  doseQuantity: 1, doseUnit: 'tablet(s)', route: 'Oral', frequency: 'Once a day', startsOn: '2026-10-01', endsOn: null, status: 'active', ...more }, medication);
const lab = (test: string) => record('lab_result', { test, codeSystem: 'LOCAL', code: 'X1', specimen: 'Blood', resultType: 'text',
  textValue: 'Synthetic value', recordedFlag: 'normal', releasedAt: '2026-10-01T10:00:00.000Z', verification: 'released' }, test);
const sql = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
const hiddenDiagnoses = (list: string[]) => {
  for (const condition of list) {
    expect([condition, kept(diagnosis(condition))]).toEqual([condition, false]);
    expect([condition, kept(diagnosis(condition, 'L-1', 'LOCAL'))]).toEqual([condition, false]);
  }
};
const hiddenMedicines = (list: string[]) => {
  for (const medication of list) expect([medication, kept(prescription(medication))]).toEqual([medication, false]);
};

describe('Q28 review: diagnosis display text, whatever the code system', () => {
  it('leaves out the ICD-10 X60-X69 titles and common self-harm wording', () => hiddenDiagnoses([
    'Intentional self-poisoning by and exposure to nonopioid analgesics', 'Intentional self-poisoning', 'Self-poisoning', 'Parasuicide',
    'Self-inflicted injury', 'Overdose (intentional)', 'History of overdose', 'Intentional self-harm by hanging']));

  it('leaves out the D47 titles: essential (haemorrhagic) thrombocythaemia, osteomyelofibrosis, MGUS and mastocytosis', () => hiddenDiagnoses([
    'Essential (haemorrhagic) thrombocythaemia', 'Essential (hemorrhagic) thrombocythemia', 'Osteomyelofibrosis', 'Myelosclerosis',
    'Monoclonal gammopathy of undetermined significance', 'MGUS', 'Mastocytosis', 'Systemic mastocytosis']));

  it('leaves out the T74 and Y05-Y07 neglect, abandonment and other abuse titles', () => hiddenDiagnoses([
    'Neglect or abandonment', 'Neglect and abandonment', 'Child battering', 'Sexual molestation', 'Torture', 'Abandoned child']));

  it('leaves out the Z20.2 official title', () => hiddenDiagnoses([
    'Contact with and exposure to infections with a predominantly sexual mode of transmission']));

  it('leaves out the Z30, Z37 and Z39 titles and common family-planning wording', () => hiddenDiagnoses([
    'Twins, both liveborn', 'Single liveborn', 'Care and examination of lactating mother', 'Encounter for sterilisation', 'Sterilization',
    'Tubal ligation', 'Vasectomy', 'IUCD insertion', 'IUD removal', 'Implanon insertion', 'Nexplanon removal', 'Depo-Provera injection', 'DMPA']));

  it('keeps ordinary diagnoses near these words', () => {
    for (const condition of ['Hypertension', 'Malaria', 'Thrombocytopenia', 'Reactive thrombocytosis', 'Lactose intolerance', 'Lactic acidosis',
      'Iron deficiency anaemia', 'Unilateral neglect after stroke', 'Drug allergy', 'Polycythaemia', 'Live vaccine reaction', 'Mastitis', 'Delivery of care plan review'])
      expect([condition, kept(diagnosis(condition))]).toEqual([condition, true]);
  });
});

describe('Q28 review: ICD-10 codes by the ICD-10 OID and with spaces', () => {
  it('matches ICD-10 by its OID, plain or as urn:oid, and trims the code', () => {
    for (const [code, system] of [['X84', 'urn:oid:2.16.840.1.113883.6.3'], ['X84', '2.16.840.1.113883.6.3'], ['D37.0', '2.16.840.1.113883.6.90'],
      [' D37.0', 'ICD-10'], ['D37.0 ', 'ICD-10'], ['  Z30.0', 'urn:oid:2.16.840.1.113883.6.3']])
      expect([code, system, kept(diagnosis('Synthetic condition', code, system))]).toEqual([code, system, false]);
  });

  it('does not treat other OIDs or systems as ICD-10', () => {
    for (const [code, system] of [['X84', 'urn:oid:2.16.840.1.113883.6.30'], ['X84', '2.16.840.1.113883.6.96'], ['X84', '1.2.16.840.1.113883.6.3.1'],
      ['X84', 'LOCAL'], ['D37.0', 'http://snomed.info/sct']])
      expect([code, system, kept(diagnosis('Synthetic condition', code, system))]).toEqual([code, system, true]);
  });
});

describe('Q28 review: medicines', () => {
  it('leaves out emergency contraception by brand, by the 0.75 mg tablet and by every way the dose is written', () => {
    hiddenMedicines(['Postinor2', 'Postinor 2', 'Levonorgestrel 0.75 mg tablet', 'Levonorgestrel 750 mcg', 'Levonorgestrel 1.5 milligram tablet',
      'Levonorgestrel 1.5 milligrams', 'LNG 1.5 mg', 'Levonelle 1500', 'NorLevo', 'Plan B One-Step', 'Pregnon', 'Escapelle']);
    expect(kept(prescription('Levonorgestrel 0.75 mg tablet', { doseQuantity: 2, doseUnit: 'tablet(s)' }))).toBe(false);
    for (const doseUnit of ['milligram', 'milligrams', 'mg/tab', 'mg/tablet', 'MG'])
      expect([doseUnit, kept(prescription('Levonorgestrel tablet', { doseQuantity: 1.5, doseUnit }))]).toEqual([doseUnit, false]);
    for (const [doseQuantity, doseUnit] of [[0.75, 'mg'], [750, 'mcg'], [750, 'micrograms'], [1500, 'µg']] as const)
      expect([doseQuantity, doseUnit, kept(prescription('Levonorgestrel tablet', { doseQuantity, doseUnit }))]).toEqual([doseQuantity, doseUnit, false]);
  });

  it('still keeps ordinary levonorgestrel contraception', () => {
    for (const medication of ['Levonorgestrel 30 mcg/ethinylestradiol 150 mcg (Microgynon)', 'Levonorgestrel implant (Jadelle)', 'Levonorgestrel 30 mcg',
      'LNG-IUS 52 mg (Mirena)', 'Levonorgestrel 150 mcg/ethinylestradiol 30 mcg'])
      expect([medication, kept(prescription(medication))]).toEqual([medication, true]);
    expect(kept(prescription('Levonorgestrel tablet', { doseQuantity: 30, doseUnit: 'mcg' }))).toBe(true);
    expect(kept(prescription('Levonorgestrel tablet', { doseQuantity: 2, doseUnit: 'tablet(s)' }))).toBe(true);
  });

  it('leaves out hepatitis B and C antiviral brands, Indian generics, regimen abbreviations and other HCV antivirals', () => hiddenMedicines([
    'Baraclude 0.5 mg', 'Viread 300 mg', 'Vemlidy 25 mg', 'Hepsera', 'Pegasys 180 mcg', 'PegIntron', 'Myhep 400 mg', 'Hepcinat LP', 'Velpanat',
    'SOF/VEL', 'SOF/DCV', 'SOF + DCV', 'Zepatier', 'Elbasvir/grazoprevir', 'Vosevi', 'Simeprevir', 'Daklinza', 'Sebivo']));

  it('leaves out hormonal cancer treatment and chemotherapy brands and monoclonal antineoplastics by name', () => hiddenMedicines([
    'Nolvadex', 'Femara 2.5 mg', 'Arimidex', 'Aromasin', 'Casodex', 'Zytiga', 'Xtandi', 'Lupron Depot', 'Eligard', 'Herceptin', 'Trastuzumab 440 mg',
    'Rituximab 500 mg', 'Bevacizumab', 'Avastin', 'Pembrolizumab', 'Glivec 400 mg', 'Gleevec', 'Xeloda', 'Taxol', 'Taxotere', 'Endoxan', 'Gemzar']));

  it('leaves out acamprosate, nalmefene and mifepristone and misoprostol brands', () => hiddenMedicines([
    'Acamprosate 333 mg', 'Campral', 'Nalmefene', 'Selincro', 'Mifeprin', 'Mifegest', 'Mifegest kit', 'Medabon', 'Misoclear']));

  it('leaves out the ATC groups of the named medicines: J05AF, J05AR, the alfa interferons, ribavirin, misoprostol and old V03AA codes', () => {
    for (const code of ['J05AF10', 'J05AF07', 'J05AR18', 'J05AR10', 'J05AE03', 'J05AG01', 'J05AJ03', 'L03AB11', 'L03AB10', 'L03AB04', 'L03AB05',
      'L03AB60', 'L03AB61', 'J05AB04', 'G02AD06', 'V03AA03', 'N07BB03'])
      expect([code, kept(prescription('Amlodipine 5 mg', { _medicationCodeSystem: 'ATC', _medicationCode: code }))]).toEqual([code, false]);
    expect(kept(prescription('Baraclude 0.5 mg', { _medicationCodeSystem: 'ATC', _medicationCode: 'J05AF10' }))).toBe(false);
  });

  it('keeps interferon beta and gamma, aciclovir, oseltamivir and other prostaglandins by ATC code', () => {
    for (const code of ['L03AB07', 'L03AB08', 'L03AB13', 'L03AB03', 'J05AB01', 'J05AH02', 'G02AD02', 'A02BC01'])
      expect([code, kept(prescription('Amlodipine 5 mg', { _medicationCodeSystem: 'ATC', _medicationCode: code }))]).toEqual([code, true]);
  });

  it('keeps interferon beta and gamma by name (multiple sclerosis, not hepatitis), and still leaves out the alfa interferons', () => {
    for (const medication of ['Interferon beta-1a (Avonex)', 'Peginterferon beta-1a', 'Interferon beta-1b', 'Interferon gamma-1b', 'Pegylated interferon beta-1a'])
      expect([medication, kept(prescription(medication))]).toEqual([medication, true]);
    hiddenMedicines(['Interferon alfa-2b', 'Interferon alpha', 'Peginterferon alfa-2a', 'Pegylated interferon', 'Peginterferon', 'Interferon']);
  });

  it('keeps ordinary medicines near the new names', () => {
    for (const medication of ['Amlodipine 5 mg', 'Morphine sulfate 10 mg', 'Tramadol 50 mg', 'Codeine phosphate 30 mg', 'Ketamine 50 mg/ml (anaesthesia)',
      'Tofacitinib 5 mg', 'Ruxolitinib 5 mg', 'Hydroxyurea 500 mg', 'Prednisolone 5 mg', 'Hydroxychloroquine 200 mg', 'Aciclovir 400 mg', 'Sofradex ear drops'])
      expect([medication, kept(prescription(medication))]).toEqual([medication, true]);
  });
});

describe('Q28 review: sensitive test names (policy and the shared SQL pattern)', () => {
  const SENSITIVE = [
    // Drug screens and alcohol as lab menus write them.
    'Urine drug test', 'Drug test', 'Urine for drugs', '10-panel drug test', 'Drug panel', 'Codeine (urine)', 'Tramadol screen', 'Morphine, urine',
    'Barbiturates', 'Marijuana', 'Indian hemp', 'Alcohol, blood', 'BAC', 'ETOH', 'EtOH level', 'MDMA', 'Ketamine',
    // Prenatal screening, Nigerian spelling and named aneuploidy screens.
    'Antenatal screening', 'Antenatal profile', 'ANC profile', 'Down syndrome screening', 'Quadruple test', 'Triple test', 'Harmony test',
    'First trimester combined screening', 'Nuchal translucency',
    // Bone marrow abbreviations.
    'BMA', 'BM aspirate', 'Marrow aspirate', 'BMAT', 'BM biopsy',
    // Pap, HPV, M. genitalium, retroviral screening.
    'Papanicolaou smear', 'LBC', 'H.P.V DNA', 'H. P. V', 'M. gen', 'M.gen PCR', 'R.V.S', 'R. V. S'];

  it('treats each as a sensitive test in the policy and the SQL pattern, and holds the result back', () => {
    for (const name of SENSITIVE) {
      expect([name, isSensitiveTest(name), sql.test(name)]).toEqual([name, true, true]);
      expect([name, kept(lab(name))]).toEqual([name, false]);
    }
  });

  it('keeps ordinary tests near the new names', () => {
    for (const name of ['Full blood count', 'ANC', 'Absolute neutrophil count (ANC)', 'Drug level', 'Therapeutic drug monitoring', 'Vancomycin level',
      'Phenytoin level', 'Lactate', 'Bicarbonate', 'Triglycerides', 'Blood culture', 'Haemoglobin'])
      expect([name, isSensitiveTest(name), sql.test(name)]).toEqual([name, false, false]);
  });
});

describe('Q28 review: test names are not diagnoses (no over-hiding)', () => {
  it('keeps confirmed allergy and adverse-reaction diagnoses that mention opioids, opiates or ethanol', () => {
    for (const condition of ['Allergy to opioids', 'Opioid allergy', 'Adverse reaction to opiates', 'Allergy to opiate analgesics',
      'Opioid-induced constipation', 'Chronic pain on long-term opioids', 'Ethanol allergy'])
      expect([condition, kept(diagnosis(condition, 'SYN-1', 'SNOMED CT'))]).toEqual([condition, true]);
  });

  it('keeps non-cancer diagnoses that mention bone marrow', () => {
    for (const condition of ['Bone marrow suppression due to co-trimoxazole', 'Aplastic anaemia (bone marrow failure)'])
      expect([condition, kept(diagnosis(condition, 'SYN-1', 'SNOMED CT'))]).toEqual([condition, true]);
  });

  it('judges a congenital trisomy diagnosis the same however it is worded', () => {
    expect(kept(diagnosis('Trisomy 21 (Down syndrome)', 'SYN-1', 'SNOMED CT'))).toBe(true);
    expect(kept(diagnosis('Down syndrome', 'SYN-1', 'SNOMED CT'))).toBe(true);
  });

  it('still leaves out the tests themselves when requested or resulted, and the dependence diagnoses', () => {
    for (const name of ['Opiate screen', 'Ethanol, serum', 'Bone marrow aspirate', 'Trisomy screen'])
      expect([name, kept(lab(name))]).toEqual([name, false]);
    for (const condition of ['Opioid dependence', 'Opioid use disorder', 'Alcohol dependence', 'Cannabis use'])
      expect([condition, kept(diagnosis(condition, 'SYN-1', 'SNOMED CT'))]).toEqual([condition, false]);
  });
});
