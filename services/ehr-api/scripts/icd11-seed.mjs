// ORD-9 (0150): the ICD-11 diagnosis list's seed, built from WHO's own
// release file (SimpleTabulation-ICD-11-MMS-en.zip, the file
// ocr-worker/src/reading/diagnosis-list.ts checked its titles against) and
// our own other names (that file's DIAGNOSIS_SYNONYMS). Node only, no
// dependency: build-icd11-seed.mjs and scripts/tests/icd11-seed.test.mjs use
// it; the seed is ORD-7's format (catalog-seed.mjs, kind 'diagnosis'), so
// the governed loader takes it.
//
// ICD-11, World Health Organization, CC BY-ND 3.0 IGO: titles are copied
// verbatim, never shortened, respelled, re-cased or translated. Only the
// tabulation's own indent marks ("- - ") and its quoting are taken off.
// Every coded entry is kept but extension codes (X...) and the two
// supplementary parts that are not diagnoses for a clinician's picker
// (LEFT_OUT_CHAPTERS); blocks and chapters have no code and are left out. Our other names are kept apart from WHO's
// words, and only where they name a coded title. A title with accented letters also gets its plain-letter spelling
// as one of our other names ("Sjogren syndrome" for "Sjögren syndrome"; Ola, clinical owner), so a search typed
// without the accents finds it; the title itself is never changed.
import { inflateRawSync } from 'node:zlib';
import { SEED_FORMAT } from './catalog-seed.mjs';

export const ICD11_NOTICE = 'ICD-11 for Mortality and Morbidity Statistics (MMS), World Health Organization. Licensed under '
  + 'CC BY-ND 3.0 IGO (https://creativecommons.org/licenses/by-nd/3.0/igo/). Titles are reproduced without change.';
export const TABULATION_MEMBER = 'SimpleTabulation-ICD-11-MMS-en.txt';
/**
 * The parts of the classification left out of the picker, with why (Ola,
 * clinical owner, ORD-9 on #258): chapter 26 holds traditional-medicine
 * patterns (TM1, TM2), used beside a conventional diagnosis, never instead
 * of one; section V holds functioning assessment items (WHODAS), not
 * diagnoses.
 */
export const LEFT_OUT_CHAPTERS = {
  26: 'Supplementary chapter: traditional medicine conditions, used beside a conventional diagnosis, never instead of one',
  V: 'Supplementary section for functioning assessment (WHODAS items), not diagnoses',
};

/** One member of a ZIP file (stored or deflated), found through the central directory. */
export function zipMember(bytes, name) {
  const buffer = Buffer.from(bytes);
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end === -1) throw new Error('ZIP: no end of central directory');
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP: a central directory entry is damaged');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const entryName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (entryName === name) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP: a local header is damaged');
      const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`ZIP: ${name} uses compression method ${method}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP: no member ${name}`);
}

/**
 * The tabulation's rows as objects. Tab-separated, fields in double quotes
 * may hold tabs and doubled quotes; a coding note may hold a bare line
 * break, which splits its row in the file, so a short row is joined to the
 * next until it has the header's fields (the last header names the
 * release, and rows have one field fewer).
 */
export function parseTabulation(text) {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field === '') quoted = true;
    else if (character === '\t') { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field); records.push(row); row = []; field = '';
    } else field += character;
  }
  if (field !== '' || row.length > 0) { row.push(field); records.push(row); }
  const [header, ...body] = records;
  const width = header.length - 1;
  const rows = [];
  let pending = null;
  for (const record of body) {
    if (record.length === 1 && record[0] === '' && pending === null) continue;
    let current = record;
    if (pending !== null) {
      pending[pending.length - 1] += `\n${current[0]}`;
      current = [...pending, ...current.slice(1)];
      pending = null;
    }
    if (current.length < width) { pending = current; continue; }
    if (current.length > width + 1) throw new Error(`tabulation: a row has ${current.length} fields`);
    rows.push(Object.fromEntries(header.slice(0, width).map((name, column) => [name, current[column]])));
  }
  if (pending !== null) throw new Error('tabulation: the last row is cut short');
  return rows;
}

/** WHO's title without the tabulation's indent marks ("- - - Cholera" is "Cholera"). */
export const verbatimTitle = (title) => title.replace(/^(- )+/, '');

/** A TypeScript string literal's text: '...' or "...", with its backslash escapes of quotes and backslashes read. */
const literalText = (single, double) => (single ?? double).replace(/\\(['"\\])/g, '$1');

/**
 * Our own other names from ocr-worker's diagnosis-list.ts: DIAGNOSIS_SYNONYMS
 * maps a name to a title, ICD11_TITLES gives each title's code (null for a
 * block). Only names whose title has a code are returned, by code. A key or
 * a title may be in single or double quotes (a name with an apostrophe,
 * such as "parkinson's disease", is written in double quotes).
 */
export function otherNamesFrom(diagnosisListSource) {
  const titles = new Map();
  for (const match of diagnosisListSource.matchAll(/\['((?:[^'\\]|\\.)*)', (?:'([^']+)'|null)\]/g)) {
    titles.set(literalText(match[1]), match[2] ?? null);
  }
  const start = diagnosisListSource.indexOf('export const DIAGNOSIS_SYNONYMS');
  const end = diagnosisListSource.indexOf('\n};', start);
  if (start === -1 || end === -1) throw new Error('diagnosis-list.ts: no DIAGNOSIS_SYNONYMS');
  const byCode = new Map();
  const entry = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"): (?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),/gm;
  for (const match of diagnosisListSource.slice(start, end).matchAll(entry)) {
    const name = literalText(match[1], match[2]);
    const code = titles.get(literalText(match[3], match[4]));
    if (!code || name.includes(';')) continue;
    byCode.set(code, [...(byCode.get(code) ?? []), name]);
  }
  for (const [code, names] of byCode) byCode.set(code, [...new Set(names)].sort());
  return byCode;
}

/**
 * A title's plain-letter spelling: its accents taken off (each letter in its
 * canonical decomposition, the combining marks dropped), nothing else
 * changed; null when the title has no accented letter. "Sjögren syndrome"
 * is "Sjogren syndrome"; a dash, a Greek letter or a no-break space stays as
 * it is, so it gives no other name.
 */
export function plainLetters(title) {
  const plain = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
  return plain === title ? null : plain;
}

/**
 * The diagnosis seed: every coded, non-extension entry of the tabulation,
 * in code order, with its verbatim title, chapter, whether it is residual,
 * and our other names. `release` is the version label (2026-01);
 * `releaseFile` names the WHO file and its sha256, recorded in the seed.
 */
export function buildIcd11Seed(rows, { release, releaseFile, otherNames = new Map() }) {
  const items = [];
  const seen = new Set();
  const leftOut = Object.fromEntries(Object.keys(LEFT_OUT_CHAPTERS).map((chapter) => [chapter, 0]));
  for (const row of rows) {
    const code = row.Code;
    if (!code || code.startsWith('X') || row.ClassKind !== 'category') continue;
    if (seen.has(code)) throw new Error(`tabulation: the code ${code} appears twice`);
    seen.add(code);
    if (row.ChapterNo in LEFT_OUT_CHAPTERS) { leftOut[row.ChapterNo] += 1; continue; }
    const title = verbatimTitle(row.Title);
    const plain = plainLetters(title);
    items.push({ code, title, otherNames: [...new Set([...(otherNames.get(code) ?? []), ...(plain ? [plain] : [])])].sort(),
      chapter: row.ChapterNo, residual: row.IsResidual === 'True' });
  }
  items.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const unused = [...otherNames.keys()].filter((code) => !items.some((item) => item.code === code));
  if (unused.length > 0) throw new Error(`other names for codes not in this release: ${unused.join(', ')}`);
  return {
    format: SEED_FORMAT,
    kind: 'diagnosis',
    version: release,
    sources: [`who-icd11-mms-${release}`],
    release: { name: `ICD-11 MMS ${release}`, file: releaseFile.name, sha256: releaseFile.sha256 },
    leftOut: Object.entries(LEFT_OUT_CHAPTERS).map(([chapter, why]) => ({ chapter, entries: leftOut[chapter], why })),
    attribution: [ICD11_NOTICE],
    retired: [],
    heldBack: [],
    items,
  };
}
