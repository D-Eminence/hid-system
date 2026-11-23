import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DRUG_GENERICS } from './drug-generics.generated';
import { NEML_GENERICS, normaliseDrugName } from './drug-list';

const ROOT = join(__dirname, '../../../..');
const SCRIPT = join(ROOT, 'scripts/generate-ocr-drug-list.mjs');
const GENERATED = join(__dirname, 'drug-generics.generated.ts');

describe('the generated drug list (drug-generics.generated.ts)', () => {
  it('matches the medicine rows of docs/codes/drafts/hid-medicines-and-lab-tests.csv exactly', () => {
    // Runs the generator on the CSV and compares its output with the checked-in file, byte for byte.
    const expected = execFileSync(process.execPath, [SCRIPT, '--stdout'], { cwd: ROOT, encoding: 'utf8' });
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
