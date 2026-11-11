import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

test('a hand-labelled set is never reported as the launch pass, even when complete, real and above the thresholds', async () => {
  const { scoreRun } = await import('../score.mjs');
  const example = workedExample();
  const report = scoreRun([example], new Map());
  assert.equal(typeof report.pass, 'boolean');
  const source = readFileSync(path.join(KIT_DIR, 'score.mjs'), 'utf8');
  assert.match(source, /report\.launchResult = !report\.partial && report\.mode === 'real' && !report\.handLabelled;/);
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
