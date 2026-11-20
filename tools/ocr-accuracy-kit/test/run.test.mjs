// End to end, offline: generate the first 10 documents, check them against the committed manifest, read them
// with the real worker pipeline in --fake mode, and score them (100%). Also: the runner refuses without the
// confirmation flag, refuses a file that is not the kit's, resumes, and never prints document text.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULT_WORKER_DIR, KIT_DIR, loadKeys, sha256Hex } from '../lib/kit.mjs';
import { conflictingResults, isDone, main as run, withUploadedDocument } from '../run.mjs';
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
    // The worker's default model for every reading call (owner decision of 2026-11-05).
    assert.ok(Object.keys(record.usageByModel).includes('claude-opus-5-5'));
  }
  noDocumentText(first.lines);

  const second = capture();
  assert.equal(await run(['--i-confirm-fictional-documents', '--fake', '--docs', docs, '--out', out, '--limit', '10'],
    second.log), 0);
  assert.match(second.lines.join('\n'), /10 already done \(skipped\); 0 to read/);

  // Thresholds are met, but a partial (and fake) run is never a launch pass: exit 3, not 0.
  const scored = capture();
  assert.equal(score(['--results', out, '--partial'], scored.log), 3);
  assert.match(scored.lines[0], /^NOT A LAUNCH RESULT \(partial run, 10 of 200 documents; fake mode;/);
  assert.equal(scored.lines.some((line) => /^PASS/.test(line)), false);
  const report = JSON.parse(readFileSync(path.join(out, 'score-report.json'), 'utf8'));
  assert.equal(report.pass, false);
  assert.equal(report.thresholdsMet, true);
  assert.equal(report.partial, true);
  assert.equal(report.mode, 'fake');
  assert.equal(report.launchMetrics.medicineAccuracyAfterChecking.value, 1);
  assert.equal(report.launchMetrics.medicineAccuracyStrict.value, 1);
  assert.equal(report.launchMetrics.unsupportedItems.value, 0);
  for (const kind of Object.values(report.perKind)) {
    if (kind.expected > 0) { assert.equal(kind.recall, 1); assert.equal(kind.precision, 1); }
  }
  noDocumentText(scored.lines);
  const summary = readFileSync(path.join(out, 'score-summary.md'), 'utf8');
  noDocumentText([summary]);
  assert.match(summary, /\*\*NOT A LAUNCH RESULT\*\*/);
  assert.match(summary, /Partial run/);
  assert.match(summary, /Fake mode/);

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

test('a resumed run never reuses results made in another mode or with other settings', async () => {
  const out = path.join(work, 'fake');
  const fakeSettings = JSON.parse(readFileSync(path.join(out, `${first10[0].docId}.run.json`), 'utf8')).settings;
  assert.equal(fakeSettings.mode, 'fake');
  const realSettings = { ...fakeSettings, mode: 'real' };
  assert.equal(isDone(out, first10[0].docId, fakeSettings), true);
  assert.equal(isDone(out, first10[0].docId, realSettings), false);
  assert.equal(conflictingResults(out, first10, realSettings).length, 10);
  assert.equal(isDone(out, first10[0].docId, { ...fakeSettings, firstPassModel: 'claude-other' }), false);

  // The same fake run with other text reading features is refused rather than mixed into this directory.
  const before = process.env.OCR_TEXTRACT_FEATURES;
  process.env.OCR_TEXTRACT_FEATURES = 'layout';
  try {
    const { lines, log } = capture();
    assert.equal(await run(['--i-confirm-fictional-documents', '--fake', '--docs', docs, '--out', out, '--limit', '10'],
      log), 2);
    assert.match(lines.at(-1), /refused: .* already holds 10 results from a different run/);
  } finally {
    if (before === undefined) delete process.env.OCR_TEXTRACT_FEATURES; else process.env.OCR_TEXTRACT_FEATURES = before;
  }
});

test('the scorer refuses a results directory that mixes fake and real records', () => {
  const mixed = path.join(work, 'mixed');
  mkdirSync(mixed, { recursive: true });
  for (const key of first10.slice(0, 2)) {
    copyFileSync(path.join(work, 'fake', `${key.docId}.json`), path.join(mixed, `${key.docId}.json`));
    copyFileSync(path.join(work, 'fake', `${key.docId}.run.json`), path.join(mixed, `${key.docId}.run.json`));
  }
  const recordFile = path.join(mixed, `${first10[1].docId}.run.json`);
  writeFileSync(recordFile, JSON.stringify({ ...JSON.parse(readFileSync(recordFile, 'utf8')), mode: 'real' }));
  const { lines, log } = capture();
  assert.equal(score(['--results', mixed, '--partial'], log), 2);
  assert.match(lines.at(-1), /mixes run modes/);
});

test('an uploaded PDF version is deleted from the test bucket after reading, and after a failure', async () => {
  const sdk = createRequire(path.join(DEFAULT_WORKER_DIR, 'package.json'))('@aws-sdk/client-s3');
  const sent = [];
  const s3 = { send: async (command) => { sent.push([command.constructor.name, command.input]);
    return command instanceof sdk.PutObjectCommand ? { VersionId: 'v-1' } : {}; } };
  class Reader { async readExact(job) { return { bucket: job.storageBucket, key: job.storageKey, versionId: job.objectVersionId }; } }
  const context = { worker: { s3Sdk: sdk, s3reader: { S3ExactDocumentReader: Reader } }, config: {}, s3,
    bucket: 'test-bucket', prefix: 'kit/' };
  const key = { file: 'D999-test.pdf', mediaType: 'application/pdf' };
  const document = { bytes: Buffer.from('%PDF fictional'), sha256Hex: 'x' };
  const done = await withUploadedDocument(context, key, document, new AbortController().signal, async (verified) => {
    assert.equal(sent.some(([name]) => name === 'DeleteObjectCommand'), false, 'not deleted before reading');
    return verified.versionId;
  });
  assert.deepEqual(done, { result: 'v-1', versionId: 'v-1', cleanup: 'deleted' });
  assert.deepEqual(sent.at(-1), ['DeleteObjectCommand', { Bucket: 'test-bucket', Key: 'kit/D999-test.pdf', VersionId: 'v-1' }]);
  sent.length = 0;
  await assert.rejects(withUploadedDocument(context, key, document, new AbortController().signal, async () => {
    throw new Error('textract failed');
  }), /textract failed/);
  assert.deepEqual(sent.map(([name]) => name), ['PutObjectCommand', 'DeleteObjectCommand']);
});
