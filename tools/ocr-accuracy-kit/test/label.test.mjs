import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkLabels, main } from '../label.mjs';
import { KIT_DIR, loadKeys } from '../lib/kit.mjs';

/** The worked example in LABELLING.md, as one keys.jsonl line: the guide and the checker cannot drift apart. */
function workedExample() {
  const guide = readFileSync(path.join(KIT_DIR, 'LABELLING.md'), 'utf8');
  const block = guide.split('```json\n')[1].split('\n```')[0];
  return JSON.parse(block);
}

function handSet(keys) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kit-label-'));
  mkdirSync(path.join(dir, 'keys'));
  mkdirSync(path.join(dir, 'documents'));
  for (const key of keys) writeFileSync(path.join(dir, 'documents', key.file), Buffer.from(`fictional ${key.docId}`));
  writeFileSync(path.join(dir, 'keys', 'keys.jsonl'), keys.map((key) => JSON.stringify(key)).join('\n') + '\n');
  return { keys: path.join(dir, 'keys'), docs: path.join(dir, 'documents') };
}

const quiet = () => { const lines = []; return { lines, log: (line) => lines.push(line) }; };

test('the worked example in LABELLING.md passes the check, seals, and loads as a kit keys directory', () => {
  const example = workedExample();
  const set = handSet([example]);
  const checked = quiet();
  assert.equal(main(['check', '--keys', set.keys, '--docs', set.docs], checked.log), 0);
  assert.match(checked.lines.at(-1), /^ok: 1 document/);
  assert.equal(main(['seal', '--keys', set.keys, '--docs', set.docs, '--name', 'example'], quiet().log), 0);
  const { keys, manifest } = loadKeys(set.keys);
  assert.equal(keys.length, 1);
  assert.equal(manifest.handLabelled, true);
  assert.equal(manifest.seed, 'example');
  assert.match(manifest.files[example.file], /^[0-9a-f]{64}$/);
});

test('a hand-labelled set (one image, one two-page PDF) runs and scores 100% offline, and is never the launch pass', async () => {
  const { main: run } = await import('../run.mjs');
  const { main: score } = await import('../score.mjs');
  const example = workedExample();
  // The same page as a two-page PDF: page 2 holds the medicines (items keep their own lines on page 2).
  const pdf = structuredClone(example);
  Object.assign(pdf, { docId: 'L002', file: 'L002-prescription.pdf', mediaType: 'application/pdf', pages: 2 });
  pdf.text = [{ page: 1, lines: example.text[0].lines.slice(0, 6) },
    { page: 2, lines: example.text[0].lines.slice(6).map((line, index) => ({ ...line, n: index + 1 })) }];
  pdf.items = pdf.items.map((item) => ({ ...item, id: item.id.replace('L001', 'L002'),
    ...(item.lines[0] > 6 ? { page: 2, lines: item.lines.map((n) => n - 6) } : {}) }));
  const set = handSet([example, pdf]);
  assert.equal(main(['seal', '--keys', set.keys, '--docs', set.docs, '--name', 'two-docs'], quiet().log), 0);
  const out = path.join(path.dirname(set.keys), 'results');
  assert.equal(await run(['--i-confirm-fictional-documents', '--fake', '--keys', set.keys, '--docs', set.docs,
    '--out', out], quiet().log), 0);
  const fake = quiet();
  assert.equal(score(['--results', out, '--keys', set.keys], fake.log), 3);
  assert.match(fake.lines[0], /^NOT A LAUNCH RESULT \(fake mode; hand-labelled set; thresholds met/);
  const report = JSON.parse(readFileSync(path.join(out, 'score-report.json'), 'utf8'));
  assert.equal(report.launchMetrics.medicineAccuracyAfterChecking.value, 1);
  assert.equal(report.launchMetrics.medicineAccuracyAfterChecking.expected, 6);
  assert.equal(report.launchMetrics.unsupportedItems.value, 0);
  // Even with every record said to be real and the thresholds met, a hand-labelled set is not the launch pass.
  for (const name of readdirSync(out).filter((file) => file.endsWith('.run.json'))) {
    const record = JSON.parse(readFileSync(path.join(out, name), 'utf8'));
    writeFileSync(path.join(out, name), JSON.stringify({ ...record, mode: 'real' }));
  }
  const real = quiet();
  assert.equal(score(['--results', out, '--keys', set.keys], real.log), 3);
  assert.match(real.lines[0], /^NOT A LAUNCH RESULT \(hand-labelled set; thresholds met/);
  const realReport = JSON.parse(readFileSync(path.join(out, 'score-report.json'), 'utf8'));
  assert.equal(realReport.handLabelled, true);
  assert.equal(realReport.launchResult, false);
  assert.equal(realReport.pass, false);
});

test('a page entry without its page number, an unknown severity and a non-list status are refused', () => {
  const example = workedExample();
  const broken = structuredClone(example);
  delete broken.text[0].page;
  broken.items[2].fields.severity = 'Severe';
  broken.items[5].fields.status = 'ongoing';
  const { problems } = checkLabels(JSON.stringify(broken), null);
  const text = problems.join('\n');
  for (const code of ['TEXT_PAGE', 'VALUE']) assert.match(text, new RegExp(code));
  assert.equal(problems.filter((problem) => problem.includes('VALUE')).length, 2);
});

test('the check names each mistake by document, code and place, never the text, and seals nothing', () => {
  const example = workedExample();
  const broken = structuredClone(example);
  broken.fictional = false;
  broken.items[0].fields.status = 'probable';
  delete broken.items[5].fields.route;
  broken.items[6].lines = [99];
  broken.items[7].kind = 'drug';
  broken.items[8].fields.colour = 'red';
  const set = handSet([broken]);
  const out = quiet();
  assert.equal(main(['seal', '--keys', set.keys, '--docs', set.docs], out.log), 1);
  const text = out.lines.join('\n');
  for (const code of ['NOT_MARKED_FICTIONAL', 'VALUE', 'FIELD_MISSING', 'LINE_REF', 'KIND', 'FIELD']) assert.match(text, new RegExp(code));
  assert.match(text, /nothing sealed/);
  assert.doesNotMatch(text, /Malaria|Artemether|Ada Example/);
  assert.throws(() => loadKeys(set.keys));
});

test('a missing file, a wrong media type, a duplicate id and a page without lines are refused', () => {
  const example = workedExample();
  const twin = structuredClone(example);
  twin.mediaType = 'image/png';
  twin.text = [{ lines: [] }];
  const { problems } = checkLabels([example, twin].map((key) => JSON.stringify(key)).join('\n'),
    path.join(os.tmpdir(), 'no-such-folder'));
  const text = problems.join('\n');
  for (const code of ['FILE_MISSING', 'MEDIA_TYPE', 'DUPLICATE_DOC_ID', 'TEXT']) assert.match(text, new RegExp(code));
});
