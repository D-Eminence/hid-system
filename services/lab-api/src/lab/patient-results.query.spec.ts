import { createHash } from 'node:crypto';
import { isGatedLabResult, LOINC_SYSTEM_SQL_PATTERN, PATIENT_SELF_LAB_QUERY, SENSITIVE_LOINC_SQL_LIST, SENSITIVE_TEST_SQL_PATTERN, STAFF_LAB_QUERY } from './patient-results.service';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
// The text of PATIENT_LAB_QUERY at 34d69557, which the staff chat keeps unchanged.
const STAFF_LAB_QUERY_SHA256 = 'b58a3981dd83affda7f7a685bc86fba05adb0a3374ff9f85cc2835c6be2b2039';
const LOINC_SHA256 = 'cd437f3ce0885e4427789ceddbfbe4b209c9cd94829d6ddb31a8c3d8e39d066e';

describe('Lab result queries for the patient and the staff chat (A6)', () => {
  it('keeps the staff query exactly as it was, with the correction reason', () => {
    expect(sha(STAFF_LAB_QUERY)).toBe(STAFF_LAB_QUERY_SHA256);
    expect(STAFF_LAB_QUERY).toContain("'correctionReason',v.correction_reason");
    expect(STAFF_LAB_QUERY).not.toContain(SENSITIVE_TEST_SQL_PATTERN);
  });

  it('uses the same sensitive test list as ehr-api (patient-evidence.query.spec.ts pins the same hash)', () => {
    expect(sha(SENSITIVE_TEST_SQL_PATTERN)).toBe('7231c39cd3acd66e8ee7af7154e311e5352af625832171aabe025526eef9e8df');
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
    const fields = placeholder!.slice(0, placeholder!.indexOf(' end\n'));
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
    expect(PATIENT_SELF_LAB_QUERY).toContain(`(g.discussed or not (coalesce(t.name,'') ~* '${SENSITIVE_TEST_SQL_PATTERN}'`);
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
    expect(PATIENT_SELF_LAB_QUERY).toContain(`or (btrim(coalesce(t.code_system,'')) ~* '${LOINC_SYSTEM_SQL_PATTERN}' and btrim(coalesce(t.code,'')) in (${SENSITIVE_LOINC_SQL_LIST}))`);
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

describe('Patient chat part 2: finished visits only, and the "Discussed with the patient" mark (0107)', () => {
  const where = PATIENT_SELF_LAB_QUERY.slice(PATIENT_SELF_LAB_QUERY.indexOf(' where r.patient_id=$1'));

  it('joins the gate on the last released version and reads only results from a finished visit', () => {
    expect(PATIENT_SELF_LAB_QUERY).toContain(
      'order by x.result_version desc limit 1) rel on true\n join lab.patient_self_result_gates($1) g on g.result_id=r.id and g.released_version=rel.result_version');
    expect(where).toContain(' and g.finished_visit\n');
    // Inner join: a result the gate function does not return (no finished visit data, another patient) is not read.
    expect(PATIENT_SELF_LAB_QUERY).not.toMatch(/left join lab\.patient_self_result_gates/);
  });

  it('holds back a sensitive or critical result, judged on the released revision v, unless that version is marked', () => {
    expect(where).toContain(`and (g.discussed or not (coalesce(t.name,'') ~* '${SENSITIVE_TEST_SQL_PATTERN}'\n`
      + ` or (btrim(coalesce(t.code_system,'')) ~* '${LOINC_SYSTEM_SQL_PATTERN}' and btrim(coalesce(t.code,'')) in (${SENSITIVE_LOINC_SQL_LIST}))\n`
      + ` or v.abnormal_flag='critical_candidate'))`);
    // v is the revision at the last released version, not the current (possibly unreleased) one.
    expect(PATIENT_SELF_LAB_QUERY).toContain('join lab.result_revisions v on v.result_id=r.id and v.version=rel.result_version');
    // The old unconditional sensitive filter is gone (it would hide a discussed result).
    expect(PATIENT_SELF_LAB_QUERY).not.toContain("!~*");
  });

  it('tells ehr-api whether the result is discussed, on the value row and on the correction placeholder', () => {
    const [, placeholder] = PATIENT_SELF_LAB_QUERY.split(' else jsonb_build_object(');
    expect(placeholder).toMatch(/^[\s\S]*'The lab is correcting this result\.'\) end\n \|\|jsonb_build_object\('_discussed',g\.discussed\) fields\n/);
    expect(PATIENT_SELF_LAB_QUERY.match(/_discussed/g)).toHaveLength(1);
  });

  it('keeps the staff query byte-identical, with no gate or mark', () => {
    expect(sha(STAFF_LAB_QUERY)).toBe(STAFF_LAB_QUERY_SHA256);
    expect(STAFF_LAB_QUERY).not.toMatch(/patient_self_result_gates|_discussed|finished_visit|critical_candidate/);
  });

  it('isGatedLabResult names sensitive and critical results as the patient query does', () => {
    expect(isGatedLabResult('HIV 1/2 rapid test', null, null, 'normal')).toEqual({ sensitive: true, critical: false });
    expect(isGatedLabResult('Screen', '75622-1', 'http://loinc.org', null)).toEqual({ sensitive: true, critical: false });
    expect(isGatedLabResult('Screen', '75622-1', 'LOCAL', null)).toEqual({ sensitive: false, critical: false });
    expect(isGatedLabResult('Potassium', '2823-3', 'http://loinc.org', 'critical_candidate')).toEqual({ sensitive: false, critical: true });
    expect(isGatedLabResult('Haemoglobin', '718-7', 'http://loinc.org', 'low')).toEqual({ sensitive: false, critical: false });
    expect(isGatedLabResult(undefined, undefined, undefined, undefined)).toEqual({ sensitive: false, critical: false });
  });
});

describe('Q28: Ola\'s further sensitive tests, held until "Discussed with the patient"', () => {
  const re = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
  const SENSITIVE = ['HPV DNA', 'High-risk HPV', 'Human papillomavirus DNA', 'Mycoplasma genitalium NAAT', 'M. genitalium PCR', 'MGen PCR',
    'HBV DNA viral load', 'Hep B DNA quantitative', 'HCV RNA', 'Hepatitis C RNA', 'Urine drug screen', 'Drugs of abuse screen', 'Toxicology screen',
    'Tox screen', 'UDS', 'Benzodiazepine screen', 'Opiate screen', 'Opioid screen', 'Cannabinoid screen', 'THC', 'Amphetamine screen',
    'Methamphetamine', 'Cocaine screen', 'Benzoylecgonine', 'Blood alcohol', 'Breath alcohol', 'Alcohol level', 'Ethanol', 'NIPT',
    'Non-invasive prenatal testing', 'Cell-free DNA', 'Cell free fetal DNA', 'cfDNA screen', 'Trisomy screen', 'Prenatal screening',
    'Bone marrow aspirate', 'Bone marrow trephine', 'Bone marrow biopsy', 'Trephine biopsy', 'Flow cytometry', 'Immunophenotyping', 'AUDIT',
    'AUDIT-C', 'CAGE', 'CAGE questionnaire', 'MMSE', 'Mini-Mental State Examination', 'Hb genotype', 'Haemoglobin genotype'];

  it('matches each new test name in the patient SQL pattern and isGatedLabResult', () => {
    for (const name of SENSITIVE) {
      expect([name, re.test(name)]).toEqual([name, true]);
      expect([name, isGatedLabResult(name, 'x', 'LOCAL', 'normal')]).toEqual([name, { sensitive: true, critical: false }]);
    }
  });

  it('keeps ordinary tests, and TB tests stay off the list', () => {
    for (const name of ['Full blood count', 'Haemoglobin', 'Malaria parasite (MRDT)', 'Widal', 'Urinalysis', 'Joint aspirate culture',
      'Audiometry', 'Lactate', 'Sputum AFB', 'GeneXpert MTB/RIF', 'TB LAM', 'Mantoux test', 'Tuberculin skin test',
      'Interferon gamma release assay', 'Cell count (CSF)', 'Prothrombin time'])
      expect([name, re.test(name), isGatedLabResult(name, 'x', 'LOCAL', null).sensitive]).toEqual([name, false, false]);
  });

  it('lists the new LOINC codes, matched only under LOINC', () => {
    for (const code of ['21440-3', '30167-1', '11259-9', '11011-4', '5640-8', '5643-2', '72107-6', '75624-7', '75626-2']) {
      expect(SENSITIVE_LOINC_SQL_LIST).toContain(`'${code}'`);
      expect([code, isGatedLabResult('Synthetic', code, 'http://loinc.org', null).sensitive]).toEqual([code, true]);
      expect([code, isGatedLabResult('Synthetic', code, 'LOCAL', null).sensitive]).toEqual([code, false]);
    }
  });

  it('still gates any critical result (D-B)', () => {
    for (const name of ['Potassium', 'Glucose', 'Sodium', 'Haemoglobin'])
      expect(isGatedLabResult(name, 'x', 'LOCAL', 'critical_candidate')).toEqual({ sensitive: false, critical: true });
    expect(PATIENT_SELF_LAB_QUERY).toContain(" or v.abnormal_flag='critical_candidate'))");
  });
});

describe('Q28 review: lab menu spellings, held until "Discussed with the patient" (same list as ehr-api)', () => {
  const re = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
  const SENSITIVE = ['Urine drug test', 'Drug test', 'Urine for drugs', '10-panel drug test', 'Drug panel', 'Codeine (urine)', 'Tramadol screen',
    'Morphine, urine', 'Barbiturates', 'Marijuana', 'Indian hemp', 'Alcohol, blood', 'BAC', 'ETOH', 'EtOH level', 'MDMA', 'Ketamine',
    'Antenatal screening', 'Antenatal profile', 'ANC profile', 'Down syndrome screening', 'Quadruple test', 'Triple test', 'Harmony test',
    'First trimester combined screening', 'Nuchal translucency', 'BMA', 'BM aspirate', 'Marrow aspirate', 'BMAT', 'BM biopsy',
    'Papanicolaou smear', 'LBC', 'H.P.V DNA', 'M. gen', 'M.gen PCR', 'R.V.S', 'R. V. S'];

  it('matches each in the patient SQL pattern and isGatedLabResult, so each can be marked discussed', () => {
    for (const name of SENSITIVE) {
      expect([name, re.test(name)]).toEqual([name, true]);
      expect([name, isGatedLabResult(name, 'x', 'LOCAL', 'normal')]).toEqual([name, { sensitive: true, critical: false }]);
    }
  });

  it('keeps ordinary tests near the new names (ANC is the absolute neutrophil count)', () => {
    for (const name of ['ANC', 'Absolute neutrophil count (ANC)', 'Drug level', 'Therapeutic drug monitoring', 'Vancomycin level', 'Phenytoin level',
      'Lactate', 'Bicarbonate', 'Triglycerides', 'Full blood count', 'Blood culture'])
      expect([name, re.test(name), isGatedLabResult(name, 'x', 'LOCAL', null).sensitive]).toEqual([name, false, false]);
  });
});

describe('Owner Q31: TB results stay visible in the patient chat, off the sensitive list (same list as ehr-api)', () => {
  const re = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
  const TB_TESTS = ['GeneXpert MTB/RIF', 'GeneXpert', 'Xpert MTB/RIF Ultra', 'MTB/RIF', 'Sputum GeneXpert', 'AFB smear', 'Sputum AFB',
    'Sputum for AFB x3', 'Acid-fast bacilli smear', 'Ziehl-Neelsen stain', 'ZN stain', 'Mantoux test', 'Mantoux', 'TST',
    'Tuberculin skin test', 'IGRA', 'Interferon gamma release assay', 'QuantiFERON-TB Gold Plus', 'QuantiFERON', 'T-SPOT.TB',
    'Sputum culture for TB', 'TB culture', 'Mycobacterial culture', 'Sputum culture (MTB)', 'TB LAM', 'Urine LF-LAM', 'Line probe assay (TB)'];

  it('keeps TB results visible (owner Q31): GeneXpert MTB/RIF, AFB smear, Mantoux/TST, IGRA/QuantiFERON, TB culture', () => {
    // Not matched by the patient query's sensitive pattern, so a released TB result from a finished visit is read
    // without a "Discussed with the patient" mark; and not gated, so the clinician's list does not offer it.
    for (const name of TB_TESTS) {
      expect([name, re.test(name)]).toEqual([name, false]);
      expect([name, isGatedLabResult(name, 'TB1', 'LOCAL', 'abnormal')]).toEqual([name, { sensitive: false, critical: false }]);
      expect([name, isGatedLabResult(name, null, null, null)]).toEqual([name, { sensitive: false, critical: false }]);
    }
  });

  it('still gates a critical TB result (D-B is about critical, not about TB)', () => {
    expect(isGatedLabResult('GeneXpert MTB/RIF', 'TB1', 'LOCAL', 'critical_candidate')).toEqual({ sensitive: false, critical: true });
  });
});
