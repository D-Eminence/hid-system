/**
 * Fictional fixtures for the reading tests. Every name, number and record
 * here is invented ("Test Patient Adaeze Example", folder TEST-0001); none
 * comes from a real patient. Used only by *.spec.ts files.
 */
import type { ReadLine, ReadPage } from '../types';
import type { ModelItem, ModelPage } from './prompt';

export const SOURCE_SHA = 'c'.repeat(64);

export function readLine(page: number, n: number, text: string, options: Partial<ReadLine> = {}): ReadLine {
  return { id: `p${page}-l${n}`, page, text, confidence: 0.99, handwritten: false,
    box: { left: 0.1, top: Math.min(0.95, Math.round(5 * n) / 100), width: 0.5, height: 0.02 }, ...options };
}

export function readPage(page: number, texts: readonly (string | [string, Partial<ReadLine>])[]): ReadPage {
  return { page, lines: texts.map((entry, index) => typeof entry === 'string'
    ? readLine(page, index + 1, entry) : readLine(page, index + 1, entry[0], entry[1])) };
}

export function modelItem(overrides: Partial<ModelItem>): ModelItem {
  return {
    kind: 'note', asWritten: '', plain: '', lineIds: [], unsure: false, dateAsWritten: '', status: 'none',
    name: '', strength: '', form: '', route: '', frequency: '', duration: '',
    substance: '', reaction: '', severity: 'none', noKnownAllergies: false,
    test: '', value: '', unit: '', referenceRange: '', flag: '', measure: 'none', noteText: '',
    prescriberAsWritten: '', prescriptionDate: '', ...overrides,
  };
}

export function modelPage(items: ModelItem[], overrides: Partial<ModelPage> = {}): ModelPage {
  return { pageUnsure: false, identity: { name: '', dateOfBirth: '', folderNumber: '', sex: '', lineIds: [] },
    items, ...overrides };
}

/** A fictional clinic page: identity, a diagnosis and two medicines on one line. */
export const CLINIC_PAGE = readPage(1, [
  'Name: Test Patient Adaeze Example  Folder: TEST-0001',
  'Dx: Hypertension',
  'Amlodipine 5mg od, Metformin 500mg bd',
  'Seen by Dr Test Prescriber 03/04/2026',
]);
