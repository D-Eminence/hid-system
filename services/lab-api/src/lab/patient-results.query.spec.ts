import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { INITIALISMS_TAKING_LETTERS, LOINC_SYSTEM_SQL_PATTERN, PATIENT_SELF_LAB_QUERY, SENSITIVE_LOINC_SQL_LIST, SENSITIVE_TEST_INITIALISMS,
  SENSITIVE_TEST_SQL_PATTERN, STAFF_LAB_QUERY, dottedInitialism, initialismForm } from './patient-results.service';

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
    expect(sha(SENSITIVE_TEST_SQL_PATTERN)).toBe('c806c1c2ce154e6765493f6f706ced745dd9f1c4c4c18195d87d7af5d0ecf6d7');
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
    expect(SENSITIVE_TEST_SQL_PATTERN).toContain('|h[^a-z0-9]*i[^a-z0-9]*v[a-z0-9]*|');
    expect(DOTTED).toEqual(expect.arrayContaining(['R.V.S.', 'V.D.R.L.', 'H.C.V.', 'C.D.4.', 'H.I.V.', 'B.R.C.A.']));
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
// apart by any marks or none, then digits may follow (letters too for HIV, CD4, HBV, HCV and HSV); BRCA joins the
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
    expect(INITIALISMS_TAKING_LETTERS).toEqual(['hiv', 'cd4', 'hbv', 'hcv', 'hsv']);
    expect(initialismForm('rvs')).toBe('r[^a-z0-9]*v[^a-z0-9]*s[0-9]*');
    expect(initialismForm('hiv')).toBe('h[^a-z0-9]*i[^a-z0-9]*v[a-z0-9]*');
    expect(SENSITIVE_TEST_INITIALISMS).toContain('brca');
    expect(SENSITIVE_TEST_INITIALISMS).not.toContain('gad');
    for (const fragment of ['g[^a-z0-9]*a[^a-z0-9]*d[^a-z0-9]*[0-9]+', 'determine[a-z0-9]*', 'uni[^a-z0-9]*gold', 'stat[^a-z0-9]*pak',
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
