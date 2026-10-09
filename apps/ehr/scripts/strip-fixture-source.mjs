import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ehrDir = path.resolve(scriptDir, '..');

function findInitializerEnd(source, start) {
  const open = source[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error('Unterminated initializer.');
}

function replaceInitializer(source, marker, replacement) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing ${marker}.`);
  const equalsIndex = source.indexOf('=', markerIndex + marker.length);
  if (equalsIndex < 0) throw new Error(`Missing initializer for ${marker}.`);
  const arrayIndex = source.indexOf('[', equalsIndex);
  const objectIndex = source.indexOf('{', equalsIndex);
  const start = arrayIndex >= 0 && (objectIndex < 0 || arrayIndex < objectIndex) ? arrayIndex : objectIndex;
  const end = findInitializerEnd(source, start);
  return source.slice(0, start) + replacement + source.slice(end);
}

function roleIdentity(label) {
  return label.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function stripRolePeople(source) {
  return source.replace(/label: '([^']+)', who: '[^']*', initials: '[^']*'/g, (_match, label) => `label: '${label}', who: '${label}', initials: '${roleIdentity(label)}'`);
}

function update(relativePath, transform) {
  const filePath = path.join(ehrDir, relativePath);
  const source = fs.readFileSync(filePath, 'utf8');
  fs.writeFileSync(filePath, transform(source));
}

update('src/data/ehr.data.ts', (original) => {
  let source = stripRolePeople(original).replaceAll('FIXTURE', 'RECORD').replaceAll('fixtures', 'records');
  source = replaceInitializer(source, 'export const HOSPITAL_CONFIG', `{\n  name: '',\n  type: '',\n  departments: [],\n  multiBranch: false,\n  branches: [],\n  currency: '',\n  timezone: '',\n  hmoIntegrated: false,\n}`);
  for (const name of ['PATIENTS_LIST', 'APPOINTMENTS', 'INPATIENT_BEDS', 'BILLING_QUEUE']) source = replaceInitializer(source, `export const ${name}`, '[]');
  return source;
});

update('src/ehr-data.jsx', (original) => {
  let source = stripRolePeople(original).replaceAll('FIXTURE', 'RECORD').replaceAll('fixtures', 'records');
  source = replaceInitializer(source, 'const HOSPITAL_CONFIG', `{\n  name: '',\n  type: '',\n  departments: [],\n  multiBranch: false,\n  branches: [],\n  currency: '',\n  timezone: '',\n  hmoIntegrated: false,\n}`);
  for (const name of ['PATIENTS_LIST', 'APPOINTMENTS', 'INPATIENT_BEDS', 'BILLING_QUEUE']) source = replaceInitializer(source, `const ${name}`, '[]');
  return source;
});

update('src/data/hospital.data.ts', (original) => {
  let source = original.replaceAll('FIXTURE', 'RECORD').replaceAll('fixtures', 'records');
  source = replaceInitializer(source, 'export const PATIENT', `{\n  hid: '',\n  fullName: '',\n  status: 'unknown',\n  address: '',\n  photo: null,\n}`);
  for (const name of ['ALLERGIES', 'MEDICATIONS', 'VITALS_HISTORY', 'LAB_RESULTS', 'ENCOUNTERS', 'PROBLEM_LIST', 'IMMUNISATIONS', 'DRUG_CATALOGUE', 'LAB_TEST_CATALOGUE', 'AUDIT_LOG']) source = replaceInitializer(source, `export const ${name}`, '[]');
  return source;
});

update('src/hospital-data.jsx', (original) => {
  let source = original.replaceAll('FIXTURE', 'RECORD').replaceAll('fixtures', 'records');
  source = replaceInitializer(source, 'const PATIENT', `{ hid: '', fullName: '', status: 'unknown', address: '', photo: null }`);
  for (const name of ['ALLERGIES', 'MEDICATIONS', 'VITALS_HISTORY', 'LAB_RESULTS', 'ENCOUNTERS', 'PROBLEM_LIST', 'IMMUNISATIONS', 'DRUG_CATALOGUE', 'LAB_TEST_CATALOGUE', 'AUDIT_LOG']) source = replaceInitializer(source, `const ${name}`, '[]');
  return source;
});

console.log('Typed EHR fixture records cleared.');
