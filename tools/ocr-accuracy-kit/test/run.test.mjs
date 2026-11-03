// End to end, offline: generate the first 10 documents, check them against the committed manifest, read them
// with the real worker pipeline in --fake mode, and score them (100%). Also: the runner refuses without the
// confirmation flag, refuses a file that is not the kit's, resumes, and never prints document text.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULT_WORKER_DIR, KIT_DIR, loadKeys, sha256Hex } from '../lib/kit.mjs';
import { main as run } from '../run.mjs';
import { main as score } from '../score.mjs';

const work = mkdtempSync(path.join(tmpdir(), 'ocr-kit-e2e-'));
const docs = path.join(work, 'generated', 'documents');
const { keys, manifest } = loadKeys();
const first10 = keys.slice(0, 10);
const python = process.env.PYTHON ?? 'python3';

before(() => {
  assert.ok(existsSync(path.join(DEFAULT_WORKER_DIR, 'dist', 'reading', 'reader.js')),
    'build services/ocr-worker first (npm ci && npm run build)');
  const generated = spawnSync(python, [path.join(KIT_DIR, 'generate.py'), '--seed', '20261103', '--count', '10',
    '--out', path.join(work, 'generated'), '--quiet'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
});
after(() => rmSync(work, { recursive: true, force: true }));

function capture() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

function noDocumentText(lines) {
  const output = lines.join('\n');
  for (const key of first10) {
    for (const page of key.text) {
      for (const line of page.lines) {
        // Short labels ("Rx:") can occur in ordinary output; anything with real content must not.
        if (line.text.length >= 12) assert.equal(output.includes(line.text), false, `printed text of ${key.docId}`);
      }
    }
    for (const item of key.items) if (item.asWritten.length >= 8) assert.equal(output.includes(item.asWritten), false);
  }
}

test('the first 10 regenerated documents are byte-identical to the committed manifest', () => {
  for (const key of first10) {
    assert.equal(sha256Hex(readFileSync(path.join(docs, key.file))), manifest.files[key.file], key.file);
  }
  const regenerated = readFileSync(path.join(work, 'generated', 'keys', 'keys.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(regenerated.map((line) => JSON.parse(line)), first10);
});

test('refuses without --i-confirm-fictional-documents, after printing the cost estimate', async () => {
  const { lines, log } = capture();
  const code = await run(['--docs', docs, '--out', path.join(work, 'refused'), '--limit', '10'], log);
  assert.equal(code, 2);
  assert.match(lines.join('\n'), /Cost estimate for \d+ pages/);
  assert.match(lines.at(-1), /refused: pass --i-confirm-fictional-documents/);
  assert.equal(existsSync(path.join(work, 'refused')), false);
});

test('real mode refuses PDFs without a versioned test bucket, before calling anything', async () => {
  const { lines, log } = capture();
  const code = await run(['--i-confirm-fictional-documents', '--docs', docs, '--out', path.join(work, 'real'),
    '--limit', '10'], log);
  assert.equal(code, 2);
  assert.match(lines.at(-1), /refused/);
});

test('--fake end to end on 10 documents scores 100% and passes; the run is resumable and prints no text', async () => {
  const out = path.join(work, 'fake');
  const first = capture();
  assert.equal(await run(['--i-confirm-fictional-documents', '--fake', '--docs', docs, '--out', out, '--limit', '10'],
    first.log), 0);
  for (const key of first10) {
    assert.ok(existsSync(path.join(out, `${key.docId}.json`)));
    const record = JSON.parse(readFileSync(path.join(out, `${key.docId}.run.json`), 'utf8'));
    assert.equal(record.status, 'done');
    assert.equal(record.pages, key.pages);
    assert.ok(record.usage.inputTokens > 0 && record.usage.outputTokens > 0);
    assert.ok(Object.keys(record.usageByModel).includes('claude-sonnet-5-5'));
  }
  noDocumentText(first.lines);

  const second = capture();
  assert.equal(await run(['--i-confirm-fictional-documents', '--fake', '--docs', docs, '--out', out, '--limit', '10'],
    second.log), 0);
  assert.match(second.lines.join('\n'), /10 already done \(skipped\); 0 to read/);

  const scored = capture();
  assert.equal(score(['--results', out, '--partial'], scored.log), 0);
  const report = JSON.parse(readFileSync(path.join(out, 'score-report.json'), 'utf8'));
  assert.equal(report.pass, true);
  assert.equal(report.launchMetrics.medicineAccuracyAfterChecking.value, 1);
  assert.equal(report.launchMetrics.medicineAccuracyStrict.value, 1);
  assert.equal(report.launchMetrics.unsupportedItems.value, 0);
  for (const kind of Object.values(report.perKind)) {
    if (kind.expected > 0) { assert.equal(kind.recall, 1); assert.equal(kind.precision, 1); }
  }
  noDocumentText(scored.lines);
  const summary = readFileSync(path.join(out, 'score-summary.md'), 'utf8');
  noDocumentText([summary]);

  // Without --partial the other 190 documents count as missed, so the launch check fails.
  assert.equal(score(['--results', out], capture().log), 1);
});

test('fake runs are deterministic: the same payloads twice', async () => {
  const again = path.join(work, 'fake-again');
  assert.equal(await run(['--i-confirm-fictional-documents', '--fake', '--docs', docs, '--out', again, '--limit', '10'],
    capture().log), 0);
  for (const key of first10) {
    assert.equal(readFileSync(path.join(again, `${key.docId}.json`), 'utf8'),
      readFileSync(path.join(work, 'fake', `${key.docId}.json`), 'utf8'), key.docId);
  }
});

test('a file that is not the kit\'s generated document is refused (sha256 not in the manifest)', async () => {
  const tampered = path.join(work, 'tampered');
  mkdirSync(tampered, { recursive: true });
  for (const name of readdirSync(docs)) copyFileSync(path.join(docs, name), path.join(tampered, name));
  const target = path.join(tampered, first10[0].file);
  const bytes = readFileSync(target);
  bytes[bytes.length - 1] ^= 0xff;
  writeFileSync(target, bytes);
  const out = path.join(work, 'tampered-out');
  const { lines, log } = capture();
  assert.equal(await run(['--i-confirm-fictional-documents', '--fake', '--docs', tampered, '--out', out,
    '--only', first10[0].docId], log), 1);
  const record = JSON.parse(readFileSync(path.join(out, `${first10[0].docId}.run.json`), 'utf8'));
  assert.equal(record.status, 'failed');
  assert.equal(record.code, 'DOCUMENT_NOT_IN_MANIFEST');
  assert.equal(existsSync(path.join(out, `${first10[0].docId}.json`)), false);
  assert.match(lines.join('\n'), /FAILED code=DOCUMENT_NOT_IN_MANIFEST/);
});
