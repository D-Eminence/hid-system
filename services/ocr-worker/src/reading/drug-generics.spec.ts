import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DRUG_GENERICS } from './drug-generics.generated';
import { NEML_GENERICS, normaliseDrugName } from './drug-list';

// The generator finds the CSV from its own place, so the test names only the files it needs (the build's test-read
// scanner maps each to ocr-worker: scripts/production-backend-build.mjs outsideTestInputs).
const SCRIPT = join(__dirname, '../../../../scripts/generate-ocr-drug-list.mjs');
const CSV = join(__dirname, '../../../../docs/codes/drafts/hid-medicines-and-lab-tests.csv');
const GENERATED = join(__dirname, 'drug-generics.generated.ts');

describe('the generated drug list (drug-generics.generated.ts)', () => {
  it('matches the medicine rows of docs/codes/drafts/hid-medicines-and-lab-tests.csv exactly', () => {
    // Runs the generator on the CSV and compares its output with the checked-in file, byte for byte.
    const expected = execFileSync(process.execPath, [SCRIPT, '--stdout'], { encoding: 'utf8' });
    expect(readFileSync(CSV, 'utf8')).toContain('MED-00001');
    expect(readFileSync(GENERATED, 'utf8')).toBe(expected);
  });

  it('is the drug list, each name normalised, unique and in order', () => {
    expect(NEML_GENERICS).toBe(GENERATED_DRUG_GENERICS);
    expect(new Set(NEML_GENERICS).size).toBe(NEML_GENERICS.length);
    for (const name of NEML_GENERICS) expect(normaliseDrugName(name)).toBe(name);
    expect([...NEML_GENERICS].sort()).toEqual(NEML_GENERICS);
    // Combinations stay whole, and a cleaned name reads as the script's CLEANED_NAMES gives it.
    expect(NEML_GENERICS).toEqual(expect.arrayContaining(['amoxicillin + clavulanic acid', 'artemether + lumefantrine',
      'activated charcoal', 'soluble insulin', "ringer's lactate"]));
    expect(NEML_GENERICS).not.toContain('charcoal, activated');
  });
});
