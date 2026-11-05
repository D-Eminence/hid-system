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

/** Deterministic filler bytes, so a fixture picture's base64 is long and distinctive (never a real picture). */
function filler(length: number, seed: number): number[] {
  const bytes: number[] = [];
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    bytes.push(state >> 16 & 0xff);
  }
  return bytes;
}

/** A fixture PNG: the signature and an IHDR chunk of the given size, then filler. Not a decodable picture. */
export function fixturePng(width: number, height: number, fillerBytes = 3_000): Uint8Array {
  const u32 = (value: number) => [value >>> 24 & 0xff, value >>> 16 & 0xff, value >>> 8 & 0xff, value & 0xff];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), 0x49, 0x48, 0x44, 0x52,
    ...u32(width), ...u32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0, ...filler(fillerBytes, 7)]);
}

/** A fixture EXIF APP1 segment holding one Orientation entry, in either TIFF byte order. */
export function fixtureExifSegment(orientation: number, order: 'II' | 'MM' = 'MM'): number[] {
  const little = order === 'II';
  const u16 = (value: number) => little ? [value & 0xff, value >> 8 & 0xff] : [value >> 8 & 0xff, value & 0xff];
  const u32 = (value: number) => little ? [value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff]
    : [value >>> 24 & 0xff, value >>> 16 & 0xff, value >>> 8 & 0xff, value & 0xff];
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8),
    ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return [0xff, 0xe1, (body.length + 2) >> 8 & 0xff, (body.length + 2) & 0xff, ...body];
}

/**
 * A fixture JPEG: SOI, an APP0 segment, an optional EXIF APP1 segment, a baseline SOF0 frame header of the given
 * size, then SOS and filler.
 */
export function fixtureJpeg(width: number, height: number, fillerBytes = 3_000, exif: number[] = []): Uint8Array {
  const u16 = (value: number) => [value >> 8 & 0xff, value & 0xff];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...u16(16), 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    ...exif,
    0xff, 0xc0, ...u16(17), 8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xda, ...u16(12), 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0, ...filler(fillerBytes, 11), 0xff, 0xd9]);
}
