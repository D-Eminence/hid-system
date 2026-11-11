#!/usr/bin/env node
// Hand-labelled sets for the launch check (LABELLING.md): checks a person's labels against the kit's key format,
// and seals the set with a manifest (each file's sha256 and the labels' sha256) so run.mjs and score.mjs accept it.
//   node label.mjs check --keys DIR --docs DIR
//   node label.mjs seal  --keys DIR --docs DIR [--name NAME]
// Prints codes, ids and counts only, never label or document text.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, sha256Hex } from './lib/kit.mjs';
import { onPage as writtenOn } from './lib/normalise.mjs';

/** The fields of each kind, as in keys/keys.jsonl and the reading contract hid-paper-reading-v2. */
export const FIELDS = {
  medicine: ['name', 'strength', 'form', 'route', 'frequency', 'duration', 'status'],
  diagnosis: ['name', 'status'],
  allergy: ['substance', 'reaction', 'severity', 'noKnownAllergies'],
  lab_result: ['test', 'value', 'unit', 'referenceRange', 'flag'],
  vital: ['measure', 'value', 'unit'],
  note: ['text'],
};
/** Fields that take one of a fixed set of values (null allowed where the paper says nothing). */
export const VALUES = {
  'medicine.status': ['current', 'new', 'past', 'stopped', 'unknown'],
  'allergy.severity': ['mild', 'moderate', 'severe', 'unknown', null],
  'diagnosis.status': ['confirmed', 'suspected', 'ruled_out', 'history', 'family_history'],
  'vital.measure': ['blood_pressure', 'pulse', 'temperature', 'respiratory_rate', 'oxygen_saturation', 'weight', 'height',
    'blood_glucose'],
  'lab_result.flag': ['H', 'L', null],
};
/** Item `trap` values ("type" or "type:detail") and the document's `traps` (the sorted set of item trap types). */
export const TRAP_TYPES = ['lookalike', 'strength', 'negation', 'allergy_conflict', 'future_date'];
/** Free-text fields whose value must be written on the item's own lines (LABELLING.md "Values as on the paper"). */
const TEXT_FIELDS = { medicine: ['name', 'strength', 'form', 'route', 'frequency', 'duration'], diagnosis: ['name'],
  allergy: ['substance', 'reaction'], lab_result: ['test', 'value', 'unit', 'referenceRange', 'flag'],
  vital: ['value', 'unit'], note: ['text'] };
/** Words that give a diagnosis's status: they belong in asWritten, not in the name. */
const STATUS_CUE = /^\s*(?:\?|query\b|q\.|hx\b|h\/o\b|pmh\b|fhx\b|past history|history of|no evidence|r\/o\b|rule out|possible\b|working diagnosis)/i;
const REQUIRED = { medicine: ['name', 'status'], diagnosis: ['name', 'status'], lab_result: ['test', 'value'],
  vital: ['measure', 'value'], note: ['text'], allergy: [] };
const MEDIA_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf' };

/** Every problem in a set of labels, as `docId: code (detail)` with no label text. */
export function checkLabels(keysText, docsDir) {
  const problems = [];
  const seen = new Set();
  const lines = keysText.split('\n').map((line, index) => ({ line, index })).filter(({ line }) => line.trim() !== '');
  if (lines.length === 0) problems.push('keys.jsonl: EMPTY');
  for (const { line, index } of lines) {
    let key;
    try { key = JSON.parse(line); } catch { problems.push(`line ${index + 1}: NOT_JSON`); continue; }
    const id = typeof key.docId === 'string' && key.docId ? key.docId : `line ${index + 1}`;
    const bad = (code, detail = '') => problems.push(`${id}: ${code}${detail ? ` (${detail})` : ''}`);
    if (seen.has(id)) bad('DUPLICATE_DOC_ID');
    seen.add(id);
    if (key.fictional !== true) bad('NOT_MARKED_FICTIONAL');
    for (const name of ['docId', 'file', 'documentKind', 'difficulty']) if (typeof key[name] !== 'string' || !key[name]) bad('MISSING', name);
    const extension = path.extname(String(key.file ?? '')).toLowerCase();
    if (MEDIA_TYPES[extension] === undefined) bad('FILE_TYPE', 'png, jpg or pdf');
    else if (key.mediaType !== MEDIA_TYPES[extension]) bad('MEDIA_TYPE', `expected ${MEDIA_TYPES[extension]}`);
    if (docsDir && key.file && !existsSync(path.join(docsDir, key.file))) bad('FILE_MISSING');
    if (!Number.isInteger(key.pages) || key.pages < 1) bad('PAGES');
    if (!Array.isArray(key.text) || key.text.length !== key.pages) { bad('TEXT', 'one entry per page'); continue; }
    const lineNumbers = key.text.map((page, pageIndex) => {
      if (page?.page !== pageIndex + 1) bad('TEXT_PAGE', `entry ${pageIndex + 1} needs "page": ${pageIndex + 1}`);
      if (!Array.isArray(page?.lines) || page.lines.length === 0) { bad('TEXT', `page ${pageIndex + 1} has no lines`); return new Set(); }
      page.lines.forEach((entry, lineIndex) => {
        if (entry?.n !== lineIndex + 1) bad('LINE_NUMBER', `page ${pageIndex + 1} line ${lineIndex + 1}: n must count from 1`);
        if (typeof entry?.text !== 'string' || !entry.text.trim()) bad('LINE_TEXT', `page ${pageIndex + 1} line ${lineIndex + 1}`);
        if (entry?.handwritten !== undefined && typeof entry.handwritten !== 'boolean') {
          bad('LINE_HANDWRITTEN', `page ${pageIndex + 1} line ${lineIndex + 1}: true or false`);
        }
      });
      return new Set(page.lines.map((entry) => entry?.n));
    });
    const onPage = (page, refs, where) => {
      if (!Number.isInteger(page) || page < 1 || page > key.pages) { bad('PAGE', where); return; }
      if (!Array.isArray(refs) || refs.length === 0) { bad('LINES', `${where}: at least one line`); return; }
      for (const ref of refs) if (!lineNumbers[page - 1].has(ref)) bad('LINE_REF', `${where}: page ${page} has no line ${ref}`);
    };
    if (key.identity !== null && key.identity !== undefined) onPage(key.identity.page, key.identity.lines, 'identity');
    if (!Array.isArray(key.items)) { bad('ITEMS'); continue; }
    const itemIds = new Set();
    const itemTraps = new Set();
    const linesOf = (item) => (Array.isArray(item.lines) ? item.lines : [])
      .map((n) => key.text[item.page - 1]?.lines?.[n - 1]?.text).filter((text) => typeof text === 'string');
    key.items.forEach((item, itemIndex) => {
      const where = typeof item?.id === 'string' ? item.id : `item ${itemIndex + 1}`;
      if (typeof item?.id !== 'string' || itemIds.has(item.id)) bad('ITEM_ID', where);
      itemIds.add(item?.id);
      const allowed = FIELDS[item?.kind];
      if (!allowed) { bad('KIND', `${where}: one of ${Object.keys(FIELDS).join(', ')}`); return; }
      if (typeof item.asWritten !== 'string' || !item.asWritten.trim()) bad('AS_WRITTEN', where);
      onPage(item.page, item.lines, where);
      const fields = item.fields ?? {};
      const names = Object.keys(fields);
      for (const name of names) if (!allowed.includes(name)) bad('FIELD', `${where}: ${item.kind} has no field ${name}`);
      for (const name of allowed) if (!(name in fields)) bad('FIELD_MISSING', `${where}: ${name} (use null when the paper does not say)`);
      for (const name of REQUIRED[item.kind]) if (fields[name] === null || fields[name] === '') bad('FIELD_EMPTY', `${where}: ${name}`);
      for (const [name, value] of Object.entries(fields)) {
        const choices = VALUES[`${item.kind}.${name}`];
        if (choices && !choices.includes(value)) bad('VALUE', `${where}: ${name} must be one of ${choices.map(String).join(', ')}`);
        if (name === 'noKnownAllergies') { if (typeof value !== 'boolean') bad('VALUE', `${where}: noKnownAllergies is true or false`); }
        else if (value !== null && typeof value !== 'string') bad('VALUE', `${where}: ${name} is text or null`);
      }
      if (item.prescription !== undefined && item.prescription !== null
        && (typeof item.prescription !== 'object' || Object.keys(item.prescription).some((name) => !['prescriberAsWritten', 'dateAsWritten'].includes(name)))) {
        bad('PRESCRIPTION', where);
      }
      const cited = linesOf(item);
      if (cited.length === 0) return;
      // asWritten and every text field are copied from the item's own lines.
      if (typeof item.asWritten === 'string' && item.asWritten.trim() && !cited.join(' ').includes(item.asWritten)
        && !cited.some((text) => text.includes(item.asWritten))) bad('AS_WRITTEN_NOT_ON_LINES', where);
      for (const name of TEXT_FIELDS[item.kind]) {
        const value = fields[name];
        if (typeof value === 'string' && value.trim() && !writtenOn(value, cited, cited.length)) {
          bad('VALUE_NOT_ON_LINES', `${where}: ${name}`);
        }
      }
      if (item.kind === 'diagnosis' && typeof fields.name === 'string') {
        if (STATUS_CUE.test(fields.name)) bad('NAME_HAS_STATUS_CUE', `${where}: the cue goes in asWritten and status, not the name`);
        if (/\(.*\)/.test(fields.name)) bad('NAME_HAS_QUALIFIER', `${where}: a qualifier in brackets stays in asWritten`);
      }
      if (item.kind === 'lab_result' && typeof fields.test === 'string' && /^[^():]+:\s*\S/.test(fields.test)) {
        bad('TEST_HAS_PREFIX', `${where}: no panel prefix in the test name`);
      }
      if (item.kind === 'medicine' && item.prescription && ['stopped', 'past'].includes(fields.status)) {
        bad('PRESCRIPTION_NOT_TAKEN', `${where}: a ${fields.status} medicine has prescription null`);
      }
      if (item.kind !== 'medicine' && item.prescription) bad('PRESCRIPTION', `${where}: only a medicine has one`);
      // The date the page gives for the item, copied from that page (optional; null when the page gives none).
      if (item.dateAsWritten !== undefined && item.dateAsWritten !== null) {
        if (typeof item.dateAsWritten !== 'string' || !item.dateAsWritten.trim()) bad('DATE', `${where}: text or null`);
        else if (!(key.text[item.page - 1]?.lines ?? []).some((line) => String(line?.text).includes(item.dateAsWritten))) {
          bad('DATE_NOT_ON_PAGE', where);
        }
      }
      // Traps: one value per item ("type" or "type:detail"), null when none.
      if (item.trap !== undefined && item.trap !== null) {
        const type = typeof item.trap === 'string' ? item.trap.split(':')[0] : '';
        if (!TRAP_TYPES.includes(type)) bad('TRAP', `${where}: one of ${TRAP_TYPES.join(', ')}`);
        else itemTraps.add(type);
      }
      const negation = (item.kind === 'diagnosis' && VALUES['diagnosis.status'].includes(fields.status) && fields.status !== 'confirmed')
        || (item.kind === 'medicine' && fields.status === 'stopped');
      if (negation && item.trap !== 'negation') bad('TRAP_NEGATION', `${where}: a ${fields.status} ${item.kind} carries trap "negation"`);
    });
    const listed = key.traps ?? [];
    const wanted = [...itemTraps].sort();
    if (!Array.isArray(listed) || listed.length !== wanted.length || listed.some((type, index) => type !== wanted[index])) {
      bad('TRAPS', `the document's traps must be the sorted trap types of its items: [${wanted.join(', ')}]`);
    }
  }
  return { problems, count: lines.length };
}

/** The manifest run.mjs and score.mjs check a keys directory against (lib/kit.mjs loadKeys, readKitDocument). */
export function sealLabels(keysText, docsDir, name) {
  const keys = keysText.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  const files = Object.fromEntries(keys.map((key) => [key.file, sha256Hex(readFileSync(path.join(docsDir, key.file)))]));
  return { count: keys.length, seed: name, handLabelled: true, files, keysSha256: sha256Hex(Buffer.from(keysText, 'utf8')) };
}

export function main(argv, log = console.log) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest, { strings: ['keys', 'docs', 'name'] });
  if (!['check', 'seal'].includes(command) || !args.keys || !args.docs) {
    log('usage: node label.mjs check|seal --keys DIR --docs DIR [--name NAME]');
    return 2;
  }
  const keysDir = path.resolve(args.keys);
  const docsDir = path.resolve(args.docs);
  const keysPath = path.join(keysDir, 'keys.jsonl');
  if (!existsSync(keysPath)) { log(`no keys.jsonl in ${keysDir}`); return 2; }
  const keysText = readFileSync(keysPath, 'utf8');
  const { problems, count } = checkLabels(keysText, docsDir);
  for (const problem of problems) log(problem);
  if (problems.length > 0) { log(`${problems.length} problem(s) in ${count} document(s); nothing sealed.`); return 1; }
  if (command === 'check') { log(`ok: ${count} document(s) labelled in the kit's format.`); return 0; }
  const manifest = sealLabels(keysText, docsDir, args.name ?? path.basename(keysDir));
  writeFileSync(path.join(keysDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`sealed: ${count} document(s); manifest.json written. Change keys.jsonl or a file and seal again.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
