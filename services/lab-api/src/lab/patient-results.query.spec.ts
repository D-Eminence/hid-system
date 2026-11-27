import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOINC_SYSTEM_SQL_PATTERN, PATIENT_SELF_LAB_QUERY, SENSITIVE_LOINC_SQL_LIST, SENSITIVE_TEST_INITIALISMS, SENSITIVE_TEST_SQL_PATTERN,
  STAFF_LAB_QUERY, dottedInitialism, initialismForm } from './patient-results.service';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
// The text of PATIENT_LAB_QUERY at 34d69557, which the staff chat keeps unchanged.
const STAFF_LAB_QUERY_SHA256 = 'b58a3981dd83affda7f7a685bc86fba05adb0a3374ff9f85cc2835c6be2b2039';
const LOINC_SHA256 = 'a775ca2c7186606ab7a30fded571d975c4ac9d3c060a92a1953c9d3aa53c677d';

describe('Lab result queries for the patient and the staff chat (A6)', () => {
  it('keeps the staff query exactly as it was, with the correction reason', () => {
    expect(sha(STAFF_LAB_QUERY)).toBe(STAFF_LAB_QUERY_SHA256);
    expect(STAFF_LAB_QUERY).toContain("'correctionReason',v.correction_reason");
    expect(STAFF_LAB_QUERY).not.toContain(SENSITIVE_TEST_SQL_PATTERN);
  });

  it('uses the same sensitive test list as ehr-api (patient-evidence.query.spec.ts pins the same hash)', () => {
    expect(sha(SENSITIVE_TEST_SQL_PATTERN)).toBe('7a64e7e6a9cfc4751a490ad894b225ba733bd45e84c10c26deeb0459c553cfc2');
  });

  it('never gives the patient the correction reason', () => {
    expect(PATIENT_SELF_LAB_QUERY).not.toMatch(/correction_reason|correctionReason/);
  });

  it('finds the latest release and shows values only when it is for the current version', () => {
    expect(PATIENT_SELF_LAB_QUERY).toContain('order by x.result_version desc limit 1) rel on true');
    const [normal, placeholder] = PATIENT_SELF_LAB_QUERY.split(' else jsonb_build_object(');
    expect(normal).toContain("case when rel.result_version=r.current_version then jsonb_build_object('test'");
    expect(normal).toContain("'numericValue',v.numeric_value::text");
    // The placeholder carries the test, never a value, flag, range or release.
    const fields = placeholder!.slice(0, placeholder!.indexOf(' end fields'));
    expect(fields).toContain("'correctionPending',true,'status','The lab is correcting this result.'");
    for (const forbidden of ['numericValue', 'textValue', 'numeric_value', 'text_value', 'unit', 'referenceRange', 'recordedFlag', 'releasedAt', 'revisionKind']) {
      expect(fields).not.toContain(forbidden);
    }
    expect(PATIENT_SELF_LAB_QUERY).toContain("r.current_version::text||':pending:'||rel.id::text");
  });

  it('leaves out a result whose current or last released version was entered in error', () => {
    expect(PATIENT_SELF_LAB_QUERY).toContain('i.result_version=r.current_version and i.patient_id=r.patient_id');
    expect(PATIENT_SELF_LAB_QUERY).toContain('i.result_version=rel.result_version and i.patient_id=r.patient_id');
    expect(PATIENT_SELF_LAB_QUERY).toContain('ver.result_version=rel.result_version');
  });

  it('leaves out sensitive tests by name, and keeps ordinary ones', () => {
    expect(PATIENT_SELF_LAB_QUERY).toContain(`coalesce(t.name,'') !~* '${SENSITIVE_TEST_SQL_PATTERN}'`);
    expect(SENSITIVE_TEST_SQL_PATTERN).not.toContain("'");
    // The ARE pattern is also valid JavaScript with the same meaning for these names.
    const re = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
    for (const name of ['HIV 1/2 rapid test', 'RVS', 'Retroviral screening', 'HBsAg', 'Anti-HCV', 'VDRL', 'Beta hCG',
      'Urine pregnancy test', 'UPT', 'PSA', 'CA 125', 'CA 19-9', 'Pap smear', 'Haemoglobin genotype', 'CD4 count', 'Viral load', 'PHQ-9',
      'VL', 'HIV VL', 'Hb electrophoresis', 'Haemoglobin electrophoresis', 'Hemoglobin electrophoresis']) {
      expect(re.test(name)).toBe(true);
    }
    for (const name of ['Full blood count', 'Malaria parasite (MRDT)', 'Haemoglobin', 'Fasting blood sugar', 'Urinalysis',
      'Widal', 'Lipid profile', 'Thyroid uptake', 'Electrolytes, urea and creatinine', 'Packed cell volume']) {
      expect(re.test(name)).toBe(false);
    }
  });
});

describe('Review fixes: sensitive tests written out in full or coded in LOINC (S4)', () => {
  it('leaves out the spelled-out names', () => {
    const re = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
    for (const name of ['Prostate specific Ag [Mass/volume] in Serum or Plasma', 'Alpha-1-Fetoprotein [Mass/volume] in Serum or Plasma',
      'Carcinoembryonic Ag [Mass/volume] in Serum or Plasma', 'Cancer Ag 125 [Units/volume] in Serum or Plasma',
      'Choriogonadotropin [Units/volume] in Serum or Plasma', 'Human chorionic gonadotropin', 'Human immunodeficiency virus 1+2 antibody',
      'Hep B surface antigen', 'HBs Ag', 'Hep C antibody']) expect([name, re.test(name)]).toEqual([name, true]);
    for (const name of ['Heparin level', 'Hepatic function panel', 'Specific gravity of urine']) expect([name, re.test(name)]).toEqual([name, false]);
  });

  it('leaves out the listed LOINC codes when the code system is LOINC, with the same list as ehr-api', () => {
    expect(PATIENT_SELF_LAB_QUERY).toContain(`and not (btrim(coalesce(t.code_system,'')) ~* '${LOINC_SYSTEM_SQL_PATTERN}' and btrim(coalesce(t.code,'')) in (${SENSITIVE_LOINC_SQL_LIST}))`);
    expect(SENSITIVE_LOINC_SQL_LIST).toContain("'75622-1'");
    expect(SENSITIVE_LOINC_SQL_LIST).toMatch(/^'[0-9]{1,6}-[0-9]'(?:,'[0-9]{1,6}-[0-9]')*$/);
    // patient-evidence.query.spec.ts pins the same hash.
    expect(sha(SENSITIVE_LOINC_SQL_LIST)).toBe(LOINC_SHA256);
    expect(STAFF_LAB_QUERY).not.toContain('loinc');
  });
});

describe('Second review: more spellings and codes, and LOINC by its OID (S4)', () => {
  it('leaves out hepatitis, HIV, CD4 and CA-125 written with dots, spaces or hyphens, and keeps near names', () => {
    const re = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
    for (const name of ['HepBsAg', 'Hep Bs Ag', 'Hep-Bc', 'Hep. B surface antigen', 'Hep. C antibody', 'H.I.V screen',
      'Human immuno-deficiency virus', 'CD 4 count', 'CA.125']) expect([name, re.test(name)]).toEqual([name, true]);
    for (const name of ['Hepcidin', 'Heparin anti-Xa', 'Hep A IgM', 'CD8 count']) expect([name, re.test(name)]).toEqual([name, false]);
  });

  it('lists the further LOINC codes and recognises LOINC by name, URL or OID, with the same pattern as ehr-api', () => {
    for (const code of ['7918-6', '29893-5', '31201-7', '5221-7', '10351-5', '25836-8', '2118-8', '19080-2'])
      expect(SENSITIVE_LOINC_SQL_LIST).toContain(`'${code}'`);
    const system = new RegExp(LOINC_SYSTEM_SQL_PATTERN, 'i');
    for (const s of ['http://loinc.org', 'LOINC', 'urn:oid:2.16.840.1.113883.6.1', '2.16.840.1.113883.6.1']) expect([s, system.test(s)]).toEqual([s, true]);
    for (const s of ['urn:oid:2.16.840.1.113883.6.96', 'urn:oid:2.16.840.1.113883.6.10', 'LOCAL']) expect([s, system.test(s)]).toEqual([s, false]);
    expect(LOINC_SYSTEM_SQL_PATTERN).not.toContain("'");
    // patient-evidence.query.spec.ts in ehr-api pins the same hash.
    expect(sha(LOINC_SYSTEM_SQL_PATTERN)).toBe('c2d253608793eec2a8437e3b718d2498e40feab386ad6e7163338b33bcf9f9ef');
  });
});

// 0155 (ORD-7): a facility's own lab test is ordered by its name only, so its name is all that can hide it from the
// patient. Ola's call as clinical owner (design note on #258, 26 Nov 2026): the HIV rapid-test kit names, and a dotted
// form of each initialism, made as ehr-api makes them (the same sha256 is pinned above and in ehr-api).
describe('0155: HIV rapid-test kits and dotted initialisms (S4)', () => {
  const re = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
  const DOTTED = SENSITIVE_TEST_INITIALISMS.map(letters => `${[...letters.toUpperCase()].join('.')}.`);
  const KITS = ['Determine', 'Determine HIV-1/2 Ag/Ab Combo', 'Uni-Gold', 'Unigold', 'Uni Gold Recombigen', 'Stat-Pak', 'StatPak',
    'Stat Pak', 'OraQuick', 'Ora-Quick', 'Ora Quick ADVANCE', 'Rapid test (Determine)'];

  it('makes the dotted form by the same rule as ehr-api', () => {
    expect(dottedInitialism('vdrl')).toBe('v[^a-z0-9]*d[^a-z0-9]*r[^a-z0-9]*l');
    expect(SENSITIVE_TEST_SQL_PATTERN).toContain('|h[^a-z0-9]*i[^a-z0-9]*v[0-9]*|');
    expect(DOTTED).toEqual(expect.arrayContaining(['R.V.S.', 'V.D.R.L.', 'H.C.V.', 'C.D.4.', 'H.I.V.', 'B.R.C.A.', 'H.P.V.']));
  });

  it.each([...DOTTED, 'R. V. S.', 'R.V.S', 'r.v.s.', 'V. D. R. L', 'C.D.4 count', 'C. D. 4', 'Retroviral screening (R.V.S.)', ...KITS])(
    'leaves out %j', (name) => {
      expect([name, re.test(name)]).toEqual([name, true]);
    });

  it('still shows a plain "Full blood count", and names near the new words', () => {
    for (const name of ['Full blood count', 'F.B.C.', 'Blood group determination', 'Predetermined panel', 'Gold standard culture',
      'Statin level', 'Oral glucose tolerance test', 'C.D.8 count', 'V.D.', 'Urine M/C/S']) {
      expect([name, re.test(name)]).toEqual([name, false]);
    }
  });

  it('the patient query leaves them out by name, the staff query does not', () => {
    expect(PATIENT_SELF_LAB_QUERY).toContain(`coalesce(t.name,'') !~* '${SENSITIVE_TEST_SQL_PATTERN}'`);
    expect(SENSITIVE_TEST_SQL_PATTERN).not.toContain("'");
    expect(STAFF_LAB_QUERY).not.toContain('determine');
  });
});

// Ola's decision as clinical owner (#258, 26 Nov 2026), made the same way in ehr-api: an initialism's letters may be set
// apart by any marks or none, then digits may follow (since 27 Nov, digits only: see the next block); BRCA joins the
// initialisms; GAD counts only with its number; the kit names take any marks between their parts, and "Determine" may
// run on ("DetermineHIV").
describe('0155: any marks between the letters of an initialism, BRCA, numbered GAD and kit names (S4)', () => {
  const re = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
  const HIDDEN = ['H-I-V', 'h.i.v', 'H.I.V1', 'HIV1', 'C.D4', 'CD.4', 'C-D-4', 'C D 4', 'cd4 count', 'V-D-R-L', 'V.D.R.L.', 'R.V.S', 'R-V-S',
    'H.C.V', 'H-B-V', 'B.R.C.A.', 'BRCA1', 'G.A.D.-7', 'GAD-7', 'Uni.Gold', 'Uni  Gold', 'Uni\u2013Gold', 'UniGold', 'Stat.Pak', 'Stat-Pak',
    'Ora.Quick', 'OraQuick HIV self-test', 'DetermineHIV', 'Determine HIV 1/2', 'P.H.Q.-9'];
  const SHOWN = ['Full blood count', 'Haemoglobin', 'Malaria parasite', 'Urinalysis', 'Anti-GAD antibody',
    'GAD (glutamic acid decarboxylase) antibody', 'Fasting blood sugar', 'Stat dose', 'Gold standard culture', 'Statin level',
    'Liver function test', 'Electrolytes'];

  it('builds each initialism form by the same rule as ehr-api', () => {
    expect(initialismForm('rvs')).toBe('r[^a-z0-9]*v[^a-z0-9]*s[0-9]*');
    expect(initialismForm('hiv')).toBe('h[^a-z0-9]*i[^a-z0-9]*v[0-9]*');
    expect(SENSITIVE_TEST_INITIALISMS).toContain('brca');
    expect(SENSITIVE_TEST_INITIALISMS).not.toContain('gad');
    for (const fragment of ['g[^a-z0-9]*a[^a-z0-9]*d[^a-z0-9]*[27]', 'determine[a-z0-9]*', 'uni[^a-z0-9]*gold', 'stat[^a-z0-9]*pac?k',
      'ora[^a-z0-9]*quick']) expect(SENSITIVE_TEST_SQL_PATTERN).toContain(`|${fragment}|`);
  });

  it('is the very same pattern string as ehr-api builds', () => {
    // ehr-api's policy needs nothing but node:crypto, so it can be loaded here as it is.
    const ehr: { SENSITIVE_TEST_SQL_PATTERN: string } = jest.requireActual(
      join(__dirname, '../../../ehr-api/src/ehr/patient-records/patient-evidence.policy.ts'));
    expect(SENSITIVE_TEST_SQL_PATTERN).toBe(ehr.SENSITIVE_TEST_SQL_PATTERN);
  });

  it.each(HIDDEN)('leaves out %j', (name) => {
    expect([name, re.test(name)]).toEqual([name, true]);
  });

  it.each(SHOWN)('still shows %j', (name) => {
    expect([name, re.test(name)]).toEqual([name, false]);
  });
});

// Ola's decision as clinical owner (#258, 27 Nov 2026), made the same way in ehr-api: fewer false positives, and the
// names and spellings that were missed. A set-apart initialism takes digits only ("H.I.V1"), so "Hb value" is no longer
// read as H-B-V; GAD counts only as GAD-2 or GAD-7. The pattern string is ehr-api's (checked above).
describe('0155: fewer false positives, and the missing names and spellings (S4)', () => {
  const re = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
  // Each name is written with a space, a dot, a hyphen, an en dash, a slash and nothing between its parts.
  const SEPARATORS = [' ', '.', '-', '–', '/', ''];
  const PARTS = [['H', 'I', 'V1'], ['C', 'D', '4 count'], ['CD', '4 count'], ['GAD', '7'], ['G', 'A', 'D', '2'], ['Viral', 'load'],
    ['CA', '125'], ['CA', '19', '9'], ['CA', '15', '3'], ['CA', '72', '4'], ['Hep', 'B'], ['Hep', 'C'], ['Hep', 'Bs', 'Ag'], ['HBs', 'Ag'],
    ['Anti', 'HBc'], ['HBc', 'Ab'], ['HBs', 'Ab'], ['Anti', 'HBs'], ['HBe', 'Ab'], ['Anti', 'HBe'], ['HBc', 'IgM'], ['HBc', 'Ag'],
    ['Prostate', 'specific antigen'], ['Tumour', 'marker'], ['Tumor', 'markers'], ['Hb', 'electrophoresis'], ['Haemoglobin', 'electrophoresis'],
    ['Human', 'immuno', 'deficiency virus'], ['Cancer', 'antigen 125'], ['Pap', 'smear'], ['PHQ', '9'], ['T', 'pallidum'],
    ['FTA', 'ABS'], ['CT', 'NG'], ['H', 'P', 'V16'], ['ER', 'PR'], ['HER', '2'], ['Frozen', 'section'], ['Alpha', 'foeto', 'proteins'],
    ['Carcino', 'embryonic antigen'], ['Sickle', 'cell', 'test'], ['Sickling', 'test'], ['Sickle', 'screening'], ['Hb', 'S', 'solubility'],
    ['Hgb', 'electrophoresis'], ['Hb', 'typing'], ['Double', 'check', 'gold'], ['Stat', 'pack'], ['Pre', 'marital screening'],
    ['Ante', 'natal', 'profile'], ['Ante', 'natal', 'screening'], ['ANC', 'panel'], ['Booking', 'bloods'], ['Retro', 'viral screening'],
    ['Drugs', 'of', 'abuse'], ['Drug', 'screen'], ['Urine', 'drug screen']];
  const NAMES = ['H.I.V1', 'C.D.4 count', 'GAD-2', 'GAD-7', 'G.A.D.-7', 'TPPA', 'FTA-ABS', 'CT/NG', 'HPV', 'HPV DNA test', 'H.P.V.', 'FNA',
    'FNAC', 'IHC', 'ER/PR', 'HER2', 'HER-2/neu', 'Frozen sections', 'CA 72-4', 'Sickle cell screen', 'EID', 'EID (DBS)', 'Recency test',
    'Double Check Gold', 'INSTI HIV-1/2', 'StatPack', 'Premarital screening', 'Antenatal panel', 'ANC profile', 'Booking blood',
    'Syph', 'Syphyllis', 'Gonorhoea', 'Chlamidia', 'Tricomonas', 'Preg test', 'Pregancy test', 'Pregnacy test', 'Hepatits B',
    'Retro-viral', 'AntiHIV', 'RapidHIV', 'AntiHCV', 'RapidHCV', 'BetahCG', 'bhCG', 'UrinehCG', 'SerumhCG', 'fPSA', 'tPSA', 'UnigoldHIV',
    'StatpakHIV', 'OraquickHIV', 'DetermineHIV', 'STIs', 'STDs', 'VLs', 'PSAs', 'VDRLs', 'Drug of abuse screen', 'Urine drugs',
    'Paternity test'];
  // "Pregabalin" is a medicine: lab-api reads test names only, and ehr-api's medicine list is unchanged.
  const SHOWN = ['Hb (venous)', 'Hb value', 'Hb vs PCV', 'HC volume', 'HS vWF', 'GAD65 antibody', 'GAD65', 'GAD-65', 'Anti-GAD65 antibody',
    'GAD', 'Anti-GAD antibody', 'Full blood count', 'Haemoglobin', 'Liver function test', 'Hepatic function panel', 'Electrolytes',
    'Fasting blood sugar', 'Malaria parasite', 'Urinalysis', 'Stool microscopy', 'Widal', 'ESR', 'PCV', 'HbA1c', 'Lipid profile',
    'Blood group', 'G6PD', 'CRP', 'Archive copy', 'Stat dose', 'Gold standard culture', 'Statin level', 'Erythrocyte count',
    'Thyroid function',
    // Ola accepted that this one is shown: letters after a set-apart initialism are not read.
    'C.D4count'];

  it('builds the forms as decided: digits only after a set-apart initialism, any marks between the parts of a name', () => {
    expect(initialismForm('hbv')).toBe('h[^a-z0-9]*b[^a-z0-9]*v[0-9]*');
    expect(SENSITIVE_TEST_INITIALISMS).toContain('hpv');
    for (const fragment of ['(?:anti|rapid)?hiv[a-z0-9]*', '(?:unigold|statpak|oraquick|determine)hiv[a-z0-9]*', 'cd[^a-z0-9]*4[a-z0-9]*',
      'hbv[a-z]*', '(?:anti|rapid)?hcv[a-z]*', 'hsv[a-z0-9]*', 'hpv[a-z0-9]*', 'gad[^a-z0-9]*[27]', 'syph[a-z]*', 'hepatit[a-z]*',
      '(?:beta|b|urine|serum)?hcgs?', '[ft]?psas?', 'stis?', 'stds?', 'vls?', 'h[^a-z0-9]*p[^a-z0-9]*v[0-9]*', 'preg', 'pregnan[a-z]*'])
      // Each is a whole alternative of the list (the first follows its opening "(?:").
      expect([fragment, `|${SENSITIVE_TEST_SQL_PATTERN.slice('(^|[^a-z0-9])(?:'.length)}`.includes(`|${fragment}|`)]).toEqual([fragment, true]);
    // No narrow separator class is left but TP-PA's (narrowed on purpose since: see the next block), and nothing hides
    // every word that ends in "hiv" ("Archive").
    expect(SENSITIVE_TEST_SQL_PATTERN.replace('|tp[ .-]?pa|', '|')).not.toMatch(/\[ [.-]*\]|\[a-z\]\*hiv|hepat\[/);
    expect(PATIENT_SELF_LAB_QUERY).toContain(`coalesce(t.name,'') !~* '${SENSITIVE_TEST_SQL_PATTERN}'`);
    expect(SENSITIVE_TEST_SQL_PATTERN).not.toContain("'");
  });

  it.each(PARTS.map(parts => [parts.join(' '), parts] as const))('%j is hidden with any separator between its parts', (_name, parts) => {
    for (const name of SEPARATORS.map(separator => parts.join(separator))) expect([name, re.test(name)]).toEqual([name, true]);
  });

  it.each(NAMES)('%j is hidden', (name) => {
    expect([name, re.test(name)]).toEqual([name, true]);
  });

  it.each(SHOWN)('%j is shown', (name) => {
    expect([name, re.test(name)]).toEqual([name, false]);
  });
});

// Ola's second decision as clinical owner (#258, 27 Nov 2026), made the same way in ehr-api: every name of a national
// lab test that the list hides by one of its names is hidden too (the walk below), then more names, and fewer false
// positives ("Chlamydophila", "TP & PA", "Pregnenolone"). The pattern string is ehr-api's (checked above).
describe('0155: every name of the sensitive national tests, more names, fewer false positives (S4)', () => {
  const re = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
  // The national tests the list hides, each with all its names (code list c68ef594 and seed eff9ba67), kept in ehr-api.
  const national: { items: { id: string; names: string[] }[] } = JSON.parse(
    readFileSync(join(__dirname, '../../../ehr-api/test/fixtures/national-sensitive-lab-tests.json'), 'utf8'));
  // Each name is written with a space, a dot, a hyphen, an en dash, a slash and nothing between its parts.
  const SEPARATORS = [' ', '.', '-', '–', '/', ''];
  const PARTS = [
    // 2: alpha feto, foeto or foto protein; HBe Ag; HBs set apart; Australia antigen.
    ['Alpha', 'feto', 'protein'], ['Alpha', 'foeto', 'protein'], ['Alpha', 'foto', 'proteins'], ['HBe', 'Ag'], ['Hb', 's', 'Ag'],
    ['Australia', 'antigen'],
    // 3: genotype tests.
    ['Hb', 'variant analysis'], ['Haemoglobin', 'variants'], ['Hemoglobin', 'variant'], ['Hb', 'HPLC'], ['Hgb', 'HPLC'],
    ['Haemoglobinopathy', 'screen'], ['Hemoglobinopathy', 'screening'], ['Sickling', 'prep'], ['Sickling', 'test'], ['Sickle', 'cell', 'status'],
    ['Sickle', 'cell', 'test'], ['Hb', 'S', 'solubility test'], ['Sickle', 'solubility test'], ['Haemoglobin', 'pattern'],
    // 4: STI and HIV.
    ['NG', 'CT'], ['GC', 'CT'], ['CT', 'GC'], ['GC', 'culture'], ['C', 'trachomatis'], ['T', 'vaginalis'], ['Human', 'papilloma', 'virus'],
    ['Human', 'papillomavirus'], ['VD', 'screen'], ['Infant', 'DNA', 'PCR'], ['DBS', 'PCR'], ['p24', 'antigen'], ['Western', 'blot'],
    ['LAg', 'avidity'], ['Retro', 'screening'], ['Retro', 'test'], ['Viral', 'lod'], ['Cr', 'Ag'], ['TB', 'LAM'], ['LF', 'LAM'],
    ['T', 'helper cell count'], ['R', 'V', 'S', 'T'], ['P', 'M', 'T', 'C', 'T'],
    // 5: hepatitis A, D and E.
    ['Hep', 'D'], ['Hep', 'E'], ['Anti', 'HAV'], ['Anti', 'HDV'], ['Anti', 'HEV'],
    // 6: pregnancy screening and panels.
    ['Triple', 'test'], ['Quad', 'screen'], ['Quadruple', 'screen'], ['PAPP', 'A'], ['Booking', 'investigations'], ['Pre', 'natal', 'screening'],
    ['Ante', 'natal', 'booking'], ['Obstetric', 'panel'], ['ANC', 'tests'],
    // 7: cancer.
    ['Fine', 'needle', 'aspiration'], ['Oestrogen', 'receptor'], ['Estrogen', 'receptor'], ['Progesterone', 'receptor'],
    ['Hormone', 'receptor', 'status'], ['ER', 'status'], ['HER2', 'neu'], ['Ki', '67'], ['CA', '27', '29'], ['Bone', 'marrow', 'aspirate'],
    ['Flow', 'cytometry'], ['BCR', 'ABL'], ['Bence', 'Jones'], ['Cell', 'block'], ['VIA', 'test'], ['VIA', 'screen'], ['Cervical', 'screening'],
    ['Cervical', 'smear'], ['Cancer', 'screening'], ['Malignancy', 'screen'], ['Immuno', 'histochemistry'], ['Cyto', 'stain'],
    ['Wet', 'mount'], ['Wet', 'prep'],
    // 8: mental health and drug tests.
    ['Depression', 'screening'], ['Anxiety', 'screen'], ['Mental', 'status exam'], ['Toxicology', 'screen'], ['Tox', 'screen'],
    ['Urine', 'toxicology'], ['Drug', 'abuse', 'screen'], ['Drug', 'abuse', 'panel'], ['THC', 'test'], ['Cannabis', 'screen'],
    ['Opiates', 'test'], ['Cocaine', 'screen'], ['Amphetamine', 'test'], ['Benzodiazepine', 'screen']];
  // A word between, or a word that must stand apart: any marks, but not run together.
  const MARKS = [' ', '.', '-', '–', '/', ' - '];
  const WORDS_APART = [['ANC', 'booking', 'profile'], ['Antenatal', 'care', 'profile'], ['Antenatal', 'care', 'panel'],
    ['Booking', 'blood', 'tests'], ['Prenatal', 'screening', 'panel'], ['Hb', 'S', 'by', 'solubility'], ['Cryptococcal', 'antigen'],
    ['Cryptococcus', 'sp', 'Ag']];
  const NAMES = ['Sickledex', 'Sickling', 'Hemoglobin S [Presence] in Blood by Solubility test', 'Venereal', 'Venereal disease', 'V.D. screen',
    'Siphilis', 'Sifilis', 'Syfilis', 'Syphilis', 'H1V', 'HlV', 'H1V 1/2', 'HlV test', 'RVST', 'R.V.S.T.', 'DBS', 'CrAg', 'PMTCT', 'PMTCT test',
    'P.M.T.C.T.', 'HIV p24 Ag', 'LAg-avidity EIA', 'C. trachomatis', 'Ctrachomatis', 'T. vaginalis', 'Hepititis', 'Heptitis', 'Hepatatis',
    'Hepititis B', 'HAV', 'HEV', 'HDV', 'AntiHAV', 'anti-HEV IgM', 'HAV IgM', 'HDV Ag', 'HAVAb', 'Preg', 'Preg test', 'Pregnancy test',
    'Pregancy test', 'Prenancy test', 'Pragnancy test', 'Pregnacy test', 'Pregnency test', 'PT', 'Serum PT', 'NIPT', 'Quad test', 'PAPPA',
    'ANC booking profile', 'Antenatal booking', 'Antenatal tests', 'Antenatal investigations', 'Antenatal labs', 'ANC screening',
    'ANC investigations', 'ANC labs', 'Booking tests', 'Booking labs', 'Booking profile', 'Prenatal panel', 'Prenatal profile',
    'Obstetric profile', 'Immunohistochemistry', 'Fine needle aspirate', 'Hormone receptor status', 'ER/PR status', 'HER2neu', 'HER-2/neu',
    'Ki-67', 'CA 27.29', 'CA 27-29', 'Cytopathology', 'Bone marrow aspiration and trephine', 'BMA', 'BCR-ABL1', 'Bence Jones protein', 'LBC',
    'VIA screening', 'Cervix smear', 'TORCH', 'TORCH screen', 'EPDS', 'HADS', 'Mental status examination', 'UDS', 'DOA', 'DOA panel',
    'Opiate test', 'Benzodiazepines test', 'Chlamydia', 'Chlamydia trachomatis', 'Chlamidia', 'TP-PA', 'TP PA', 'TP.PA', 'TPPA',
    'Lipoarabinomannan test', 'Cryptococcal antigen test'];
  // Ola's list of names that must be shown, and names near the new words. The shown lists of the last two decisions
  // are in the two blocks above.
  const SHOWN = ['Pregnenolone', '17-OH pregnenolone', 'Pregabalin level', 'Chlamydophila pneumoniae serology', 'TP & PA', 'TP/PA',
    'Hepatic function panel', 'Liver function test', 'Total protein', 'Prothrombin time', 'Archive copy', 'Solubility test', 'VIA', 'INR',
    'International normalised ratio', 'Ancestry panel', 'Thyroid stimulating hormone receptor antibody', 'Toxoplasma IgG avidity',
    'Gardnerella vaginalis', 'Hepatic', 'Hb sample'];

  it('walks the national list: no name of a sensitive national test is shown', () => {
    expect(national.items.length).toBeGreaterThanOrEqual(32);
    expect(national.items.flatMap(item => item.names.filter(name => !re.test(name)).map(name => `${item.id} ${name}`))).toEqual([]);
  });

  it('hides "PT", a name of the national pregnancy tests, and prothrombin time\'s "PT" with it; the names written out are shown', () => {
    expect(['PT', 'Serum PT', 'Prothrombin time (PT)', 'PT/INR'].map(name => re.test(name))).toEqual([true, true, true, true]);
    expect(['Prothrombin time', 'INR', 'International normalised ratio'].map(name => re.test(name))).toEqual([false, false, false]);
  });

  it('builds the pattern as decided, and the patient query carries it', () => {
    const fragments = `|${SENSITIVE_TEST_SQL_PATTERN.slice('(^|[^a-z0-9])(?:'.length, -')($|[^a-z0-9])'.length)}|`;
    for (const fragment of ['chlam(?!ydophila)[a-z]*', 'tp[ .-]?pa', 'alpha[^a-z0-9]*fo?e?to[^a-z0-9]*proteins?', 'hbe[^a-z0-9]*ag',
      'hb[^a-z0-9]*s[^a-z0-9]*ag', 'hep[a-z]{0,3}t[aiy]t[aiy]s', 'syph[a-z]*', 's[iy][pf]h?[iy]l[a-z]*', 'vener[a-z]*', 'cr[^a-z0-9]*ags?',
      'preg', 'pregnan[a-z]*', 'pr[ae]g?n?[ae]n?cy[a-z]*', 'pt', 'r[^a-z0-9]*v[^a-z0-9]*s[^a-z0-9]*t[0-9]*',
      'p[^a-z0-9]*m[^a-z0-9]*t[^a-z0-9]*c[^a-z0-9]*t[0-9]*'])
      expect([fragment, fragments.includes(`|${fragment}|`)]).toEqual([fragment, true]);
    // 'preg[a-z]*' and the plain 'chlam[a-z]*' are gone, and the only look-ahead is the one for Chlamydophila.
    expect([fragments.includes('|preg[a-z]*|'), fragments.includes('|chlam[a-z]*|')]).toEqual([false, false]);
    expect(SENSITIVE_TEST_SQL_PATTERN.match(/\(\?[^:]/g)).toEqual(['(?!']);
    expect(SENSITIVE_TEST_INITIALISMS).toEqual(expect.arrayContaining(['rvst', 'pmtct']));
    expect(PATIENT_SELF_LAB_QUERY).toContain(`coalesce(t.name,'') !~* '${SENSITIVE_TEST_SQL_PATTERN}'`);
    expect(SENSITIVE_TEST_SQL_PATTERN).not.toContain("'");
  });

  it.each(PARTS.map(parts => [parts.join(' '), parts] as const))('%j is hidden with any separator between its parts', (_name, parts) => {
    for (const name of SEPARATORS.map(separator => parts.join(separator))) expect([name, re.test(name)]).toEqual([name, true]);
  });

  it.each(WORDS_APART.map(parts => [parts.join(' '), parts] as const))('%j is hidden with any marks between its words', (_name, parts) => {
    for (const name of MARKS.map(separator => parts.join(separator))) expect([name, re.test(name)]).toEqual([name, true]);
  });

  it.each(NAMES)('%j is hidden', (name) => {
    expect([name, re.test(name)]).toEqual([name, true]);
  });

  it.each(SHOWN)('%j is shown', (name) => {
    expect([name, re.test(name)]).toEqual([name, false]);
  });
});
