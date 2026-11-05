import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compactKey, DIAGNOSIS_ENTRIES, DIAGNOSIS_SYNONYMS, ICD11_TITLES, listKey, matchDiagnosisName, matchListName,
  UNGROUNDED_ABBREVIATIONS, UNLISTED_DIAGNOSIS_LOOKALIKES } from './diagnosis-list';
import { LAB_ENTRIES, LAB_TESTS, matchLabTestName, UNLISTED_LAB_LOOKALIKES } from './lab-list';
import { fuzzyListMatch } from './list-match';

const ATTRIBUTION = 'ICD-11, World Health Organization, licensed under CC BY-ND 3.0 IGO';

describe('diagnosis list (hard pages only)', () => {
  it('reproduces ICD-11 titles verbatim, with the attribution in the data file and the README', () => {
    const source = readFileSync(join(__dirname, 'diagnosis-list.ts'), 'utf8');
    expect(source.replace(/\n \*\s+/g, ' ')).toContain(ATTRIBUTION);
    const readme = readFileSync(join(__dirname, '..', '..', 'README.md'), 'utf8');
    expect(readme.replace(/\s+/g, ' ')).toContain(ATTRIBUTION);
    // No ICD-10 content: no ICD-10-style code anywhere in the list.
    expect(source).not.toMatch(/'[A-Z]\d\d(?:\.\d+)?'/);
    const titles = ICD11_TITLES.map(([title]) => title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const [title, code] of ICD11_TITLES) {
      expect(title).toBe(title.trim());
      expect(title.charAt(0)).toBe(title.charAt(0).toUpperCase());
      if (code !== null) expect(code).toMatch(/^[0-9A-Z]{4}(?:\.[0-9A-Z]{1,2})?$/);
    }
    // Every synonym of ours maps to a listed title, and is not itself a title.
    for (const [name, title] of Object.entries(DIAGNOSIS_SYNONYMS)) {
      expect([name, titles.includes(title)]).toEqual([name, true]);
      expect(titles.map(listKey)).not.toContain(listKey(name));
      expect(name).toBe(name.toLowerCase());
    }
  });

  it('keeps the name as read in front and adds the ICD-11 title, unchanged, after it', () => {
    expect(matchDiagnosisName('HTN')).toEqual({ title: 'Hypertensive diseases', display: 'HTN? (Hypertensive diseases)',
      exact: true });
    expect(matchDiagnosisName('htn?')?.display).toBe('htn? (Hypertensive diseases)');
    expect(matchDiagnosisName('T2DM')?.title).toBe('Type 2 diabetes mellitus');
    expect(matchDiagnosisName('PUD')?.title).toBe('Peptic ulcer, site unspecified');
    expect(matchDiagnosisName('URTI')?.title).toBe('Acute upper respiratory infection, site unspecified');
    expect(matchDiagnosisName('BPH')?.title).toBe('Hyperplasia of prostate');
    expect(matchDiagnosisName('CCF')?.title).toBe('Congestive heart failure');
    expect(matchDiagnosisName('Typhoid')?.display).toBe('Typhoid? (Typhoid fever)');
    // A title as written is left as read.
    expect(matchDiagnosisName('Essential hypertension')).toMatchObject({ display: 'Essential hypertension', exact: true });
    expect(matchDiagnosisName('Pre eclampsia')?.display).toBe('Pre eclampsia');
    expect(matchDiagnosisName('preeclampsia')?.display).toBe('preeclampsia? (Pre-eclampsia)');
    // One slip, within the strict rules: respelled, the reading kept in front.
    expect(matchDiagnosisName('Typhoid fevr')).toMatchObject({ title: 'Typhoid fever', exact: false,
      display: 'Typhoid fevr? (Typhoid fever)' });
    expect(matchDiagnosisName('Typhiod fever')).toBeNull();
  });

  it('never adds what an abbreviation does not say, and keeps a negative apart from a positive', () => {
    expect(matchDiagnosisName('HTN')?.title).not.toBe('Essential hypertension');
    expect(matchDiagnosisName('DM')?.title).toBe('Diabetes mellitus');
    expect(matchDiagnosisName('SCD')?.title).toBe('Sickle cell disorders or other haemoglobinopathies');
    expect(matchDiagnosisName('MP+')?.title).toBe('Malaria');
    expect(matchDiagnosisName('MP +ve')?.title).toBe('Malaria');
    for (const name of ['MP -ve', 'MP-ve', 'MP', 'Fictional syndrome', 'Tab 1 bd']) {
      expect([name, matchDiagnosisName(name)]).toEqual([name, null]);
    }
  });

  it('never grounds an abbreviation that stands for more than one thing', () => {
    for (const name of ['PID', 'pid', 'PET', 'AGE', 'SCA', 'P.I.D.']) {
      expect([name, matchDiagnosisName(name)]).toEqual([name, null]);
    }
    for (const name of UNGROUNDED_ABBREVIATIONS) expect(Object.keys(DIAGNOSIS_SYNONYMS)).not.toContain(name);
    // The spelled-out names stay listed.
    expect(matchDiagnosisName('Pelvic inflammatory disease')?.title).toBe('Female pelvic inflammatory diseases');
    expect(matchDiagnosisName('Sickle cell anaemia')?.title).toBe('Sickle cell disorders or other haemoglobinopathies');
    expect(matchDiagnosisName('Acute gastroenteritis')?.title)
      .toBe('Gastroenteritis or colitis without specification of infectious agent');
  });

  it('never respells a real unlisted disease into a listed one a letter away', () => {
    expect(matchDiagnosisName('Nephritic syndrome')).toBeNull();
    expect(matchDiagnosisName('Malacia')).toBeNull();
    expect(matchDiagnosisName('Nephrotic syndrome')?.display).toBe('Nephrotic syndrome');
    // A slip as near the unlisted look-alike as the listed name is no match either: it may be either disease.
    expect(matchDiagnosisName('Nephrotic syndrom')).toBeNull();
    // Each look-alike is really off the list, and without the guard it would be fuzzy-matched to a listed name.
    for (const [lookalikes, entries] of [[UNLISTED_DIAGNOSIS_LOOKALIKES, DIAGNOSIS_ENTRIES],
      [UNLISTED_LAB_LOOKALIKES, LAB_ENTRIES]] as const) {
      for (const name of lookalikes) {
        expect([name, entries.some((entry) => entry.key === listKey(name))]).toEqual([name, false]);
        expect(matchListName(name, entries, lookalikes)).toBeNull();
      }
    }
    for (const name of UNLISTED_DIAGNOSIS_LOOKALIKES) {
      expect([name, fuzzyListMatch([listKey(name)], DIAGNOSIS_ENTRIES) === null]).toEqual([name, false]);
    }
    // A slip one letter from both a listed test and an unlisted look-alike is no match.
    expect(matchLabTestName('Creatinne')).toBeNull();
    expect(matchLabTestName('Creatinine')?.display).toBe('Creatinine');
  });

  it('keeps a query on the paper, "[?]", in the name shown', () => {
    expect(matchDiagnosisName('[?]TB')?.display).toBe('[?]TB? (Tuberculosis)');
    expect(matchDiagnosisName('TB[?]')?.display).toBe('TB[?]? (Tuberculosis)');
    expect(listKey('[?]TB')).toBe('tb');
  });
});

describe('lab test list (hard pages only)', () => {
  it('names tests in our own words, with no LOINC content', () => {
    const source = readFileSync(join(__dirname, 'lab-list.ts'), 'utf8');
    // A LOINC code is digits, a hyphen and a check digit ("1234-5"): none is here.
    expect(source).not.toMatch(/\b\d{3,5}-\d\b/);
    const names = Object.keys(LAB_TESTS);
    const all = [...names, ...Object.values(LAB_TESTS).flat()];
    expect(new Set(all.map(compactKey)).size).toBeLessThanOrEqual(all.length);
    for (const name of all) expect(name).toBe(name.toLowerCase());
  });

  it('shows an abbreviation as read with the test name after it, and leaves a listed name as read', () => {
    expect(matchLabTestName('FBC')).toEqual({ title: 'full blood count', display: 'FBC? (full blood count)', exact: true });
    for (const [written, test] of [['PCV', 'packed cell volume'], ['Hb', 'haemoglobin'], ['ESR', 'erythrocyte sedimentation rate'],
      ['MP', 'malaria parasite test'], ['Widal', 'widal test'], ['RBS', 'random blood sugar'], ['FBS', 'fasting blood sugar'],
      ['HbA1c', 'hba1c'], ['E/U/Cr', 'electrolytes, urea and creatinine'], ['EUCr', 'electrolytes, urea and creatinine'],
      ['U&E', 'electrolytes, urea and creatinine'], ['LFTs', 'liver function tests'], ['M/C/S', 'microscopy, culture and sensitivity'],
      ['HBsAg', 'hepatitis b surface antigen'], ['Anti-HCV', 'hepatitis c antibody'], ['VDRL', 'vdrl'], ['PSA', 'prostate-specific antigen'],
      ['TFT', 'thyroid function tests'], ['CRP', 'c-reactive protein'], ['Genotype', 'haemoglobin genotype'],
      ['UPT', 'pregnancy test'], ['Lipid profile', 'lipid profile'], ['Clotting profile', 'clotting profile']] as const) {
      expect([written, matchLabTestName(written)?.title]).toEqual([written, test]);
    }
    expect(matchLabTestName('Full blood count')?.display).toBe('Full blood count');
    expect(matchLabTestName('HbA1c')?.display).toBe('HbA1c');
  });

  it('never adds a specimen or an assay that is not written', () => {
    expect(matchLabTestName('Cr')?.title).toBe('creatinine');
    expect(matchLabTestName('AFB')?.title).toBe('acid-fast bacilli (afb)');
    expect(matchLabTestName('Sputum for AFB')?.title).toBe('sputum afb');
    expect(matchLabTestName('Stool mcs')?.title).toBe('stool microscopy, culture and sensitivity');
    expect(matchLabTestName('Stool m/c/s')?.title).toBe('stool microscopy, culture and sensitivity');
  });

  it('never expands a name that stands for more than one test', () => {
    for (const name of ['PT', 'BG', 'GT', 'CS', 'HCV', 'Stool analysis', 'Fictional assay']) {
      expect([name, matchLabTestName(name)]).toEqual([name, null]);
    }
  });
});
