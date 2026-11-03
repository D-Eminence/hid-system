#!/usr/bin/env node
// Runs the real ocr-worker reading pipeline (services/ocr-worker/dist: Textract provider, exact S3 reader,
// PaperReadingService with the Claude page client) on the kit's FICTIONAL documents and writes one
// 'hid-paper-reading-v2' payload per document. It never prints document text: only ids, counts, codes,
// token usage and costs.
//
//   node run.mjs --i-confirm-fictional-documents --docs generated/documents --out results/real-1 \
//     --s3-bucket demo-hospital-ocr-kit-test [--concurrency 2] [--limit 20] [--only D001,D007]
//   node run.mjs --i-confirm-fictional-documents --fake --docs generated/documents --out results/fake
//   node run.mjs --estimate-only
//
// See README.md. Only the kit's own generated documents can be run: every file's sha256 must be in the
// manifest, so nothing else (and never a real patient record) can be sent.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { estimate, formatEstimate, usageCost } from './lib/cost.mjs';
import { FakePageModelClient, FakeTextractClient } from './lib/fake.mjs';
import { DEFAULT_KEYS_DIR, DEFAULT_WORKER_DIR, KIT_DIR, KitError, loadKeys, parseArgs, readKitDocument } from './lib/kit.mjs';

export const DEMO_FACILITY_ID = '00000000-0000-4000-8000-00000000d0e0';
const CONFIRM_FLAG = 'i-confirm-fictional-documents';
const USAGE = `usage: node run.mjs --${CONFIRM_FLAG} [--fake] [--docs DIR] [--keys DIR] [--out DIR]
       [--s3-bucket BUCKET] [--s3-prefix PREFIX] [--concurrency N] [--limit N] [--only D001,D002]
       [--facility-id UUID] [--worker-dir DIR]
       node run.mjs --estimate-only [--keys DIR]`;

export function loadWorker(workerDir = DEFAULT_WORKER_DIR) {
  const dist = path.join(workerDir, 'dist');
  if (!existsSync(path.join(dist, 'reading', 'reader.js'))) {
    throw new KitError('WORKER_NOT_BUILT', `build the worker first: (cd ${workerDir} && npm ci && npm run build)`);
  }
  const require = createRequire(path.join(workerDir, 'package.json'));
  return {
    config: require(path.join(dist, 'config.js')),
    textract: require(path.join(dist, 'textract.provider.js')),
    reader: require(path.join(dist, 'reading', 'reader.js')),
    claude: require(path.join(dist, 'reading', 'claude.client.js')),
    contract: require(path.join(dist, 'reading', 'contract.js')),
    s3reader: require(path.join(dist, 's3-document-reader.js')),
    types: require(path.join(dist, 'types.js')),
    textractSdk: require('@aws-sdk/client-textract'),
    s3Sdk: require('@aws-sdk/client-s3'),
  };
}

/** Values the worker requires for its database but this runner never uses (no database is touched). */
const UNUSED_DATABASE = { OCR_WORKER_DATABASE_URL: 'postgresql://unused@127.0.0.1:5432/unused',
  OCR_WORKER_SUBJECT: 'ocr-accuracy-kit' };

/** The worker's own configuration parser, on the process environment (real) or a fixed offline one (fake). */
export function workerConfig(worker, { fake, environment = process.env }) {
  if (fake) {
    return worker.config.readOcrWorkerConfig({ ...UNUSED_DATABASE, NODE_ENV: 'test', OCR_PROVIDER: 'textract',
      AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'fake-offline', AWS_SECRET_ACCESS_KEY: 'fake-offline',
      OCR_TEXTRACT_POLL_MS: '250', OCR_TEXTRACT_FEATURES: environment.OCR_TEXTRACT_FEATURES ?? 'text',
      OCR_AI_MODE: 'claude', ANTHROPIC_API_KEY: 'fake-offline-key-not-a-secret',
      OCR_AI_GLOBAL_PROCESSING_APPROVED: 'true' });
  }
  // The worker's database settings are irrelevant here; NODE_ENV production would demand database TLS.
  return worker.config.readOcrWorkerConfig({ ...UNUSED_DATABASE, ...environment, NODE_ENV: 'development',
    OCR_PROVIDER: 'textract' });
}

function addUsage(total, more) {
  total.inputTokens += more.inputTokens;
  total.outputTokens += more.outputTokens;
  total.cacheReadInputTokens += more.cacheReadInputTokens;
  total.cacheCreationInputTokens += more.cacheCreationInputTokens;
}
const zeroUsage = () => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });

/** Wraps the page client to count token usage per model (first pass and re-read are different models). */
class CountingPageClient {
  constructor(inner) { this.inner = inner; this.byModel = {}; }
  async readPage(request, signal) {
    const answer = await this.inner.readPage(request, signal);
    const usage = (this.byModel[request.model] ??= { requests: 0, ...zeroUsage() });
    usage.requests += 1;
    addUsage(usage, answer.usage);
    return answer;
  }
}

function safeCode(error) {
  if (error && typeof error.code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(error.code)) return error.code;
  if (error instanceof Error && /^[A-Za-z0-9_]{1,80}$/.test(error.name)) return error.name;
  return 'UNEXPECTED';
}

/** Uploads a PDF/TIFF to the versioned test bucket and reads it back by exact version, as the worker does. */
async function exactS3Document(context, key, document, signal) {
  const { worker, config, s3, bucket, prefix } = context;
  const objectKey = `${prefix}${key.file}`;
  const put = await s3.send(new worker.s3Sdk.PutObjectCommand({ Bucket: bucket, Key: objectKey,
    Body: document.bytes, ContentType: key.mediaType, ChecksumAlgorithm: 'SHA256' }), { abortSignal: signal });
  if (!put.VersionId) throw new KitError('S3_BUCKET_NOT_VERSIONED', 'the test bucket must have versioning on');
  const reader = new worker.s3reader.S3ExactDocumentReader(config, s3);
  const verified = await reader.readExact({ storageBucket: bucket, storageKey: objectKey, objectVersionId: put.VersionId,
    sizeBytes: document.bytes.byteLength, sourceSha256Hex: document.sha256Hex, mediaType: key.mediaType }, signal);
  return { verified, versionId: put.VersionId };
}

/** One document through text reading and the AI step. Returns the payload and a text-free run record. */
export async function processDocument(context, key, signal) {
  const { worker, config, fake, docsDir, manifest, facilityId } = context;
  const started = Date.now();
  const document = readKitDocument(docsDir, key, manifest);
  const provider = new worker.textract.TextractOcrProvider(config);
  let pageClient;
  let verified;
  let s3VersionId = null;
  if (fake) {
    provider.client = new FakeTextractClient(key, worker.textractSdk);
    pageClient = new CountingPageClient(new FakePageModelClient(key));
    verified = { bytes: document.bytes, bucket: 'fake-kit-bucket', key: key.file, versionId: 'fake-version',
      mediaType: key.mediaType, sha256Hex: document.sha256Hex };
  } else {
    pageClient = new CountingPageClient(context.claudeClient);
    if (key.mediaType === 'application/pdf' || key.mediaType === 'image/tiff') {
      const exact = await exactS3Document(context, key, document, signal);
      verified = exact.verified;
      s3VersionId = exact.versionId;
    } else {
      verified = { bytes: document.bytes, bucket: 'local-bytes', key: key.file, versionId: 'local-bytes',
        mediaType: key.mediaType, sha256Hex: document.sha256Hex };
    }
  }
  const text = await provider.extract(verified, signal);
  const reading = new worker.reader.PaperReadingService(config, pageClient);
  const outcome = await reading.read({ facilityId, sourceSha256Hex: document.sha256Hex, pages: text.pages }, signal);
  const checked = worker.contract.paperReadingPayloadSchema.safeParse(outcome.payload);
  if (!checked.success) throw new KitError('READING_CONTRACT_VIOLATION', 'payload is not in the contract shape');
  const summary = outcome.summary;
  const byModel = Object.fromEntries(Object.entries(pageClient.byModel).map(([model, usage]) =>
    [model, { ...usage, costUsd: Math.round(usageCost(model, usage) * 1e6) / 1e6 }]));
  return {
    payload: outcome.payload,
    record: {
      docId: key.docId, file: key.file, status: 'done', mode: fake ? 'fake' : 'real',
      pages: text.pageCount, lines: text.pages.reduce((sum, page) => sum + page.lines.length, 0),
      textract: { providerModel: text.providerModel, operation: text.provenance.operation,
        features: text.provenance.textractFeatures },
      s3VersionId,
      reading: { status: summary.status, firstPassModel: summary.firstPassModel, rereadModel: summary.rereadModel,
        requests: summary.requests, refusals: summary.refusals, rereadPages: summary.rereadPages,
        rereadFailedPages: summary.rereadFailedPages, itemCount: summary.itemCount,
        droppedUngrounded: summary.droppedUngrounded, flaggedPages: summary.flaggedPages,
        maskedNumbers: summary.maskedNumbers, failureCode: summary.failureCode },
      usage: summary.usage,
      usageByModel: byModel,
      durationMs: Date.now() - started,
    },
  };
}

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, file);
}

export function isDone(outDir, docId) {
  const recordFile = path.join(outDir, `${docId}.run.json`);
  if (!existsSync(recordFile) || !existsSync(path.join(outDir, `${docId}.json`))) return false;
  try { return JSON.parse(readFileSync(recordFile, 'utf8')).status === 'done'; } catch { return false; }
}

async function pool(items, concurrency, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}

export async function main(argv = process.argv.slice(2), log = (line) => process.stdout.write(line + '\n')) {
  let args;
  try {
    args = parseArgs(argv, { booleans: [CONFIRM_FLAG, 'fake', 'estimate-only', 'help'],
      strings: ['docs', 'keys', 'out', 's3-bucket', 's3-prefix', 'concurrency', 'limit', 'only', 'facility-id',
        'worker-dir'] });
  } catch (error) {
    log(error.message); log(USAGE); return 2;
  }
  if (args.help) { log(USAGE); return 0; }
  let kit;
  try { kit = loadKeys(args.keys ? path.resolve(args.keys) : DEFAULT_KEYS_DIR); } catch (error) {
    log(`refused: ${error.message}`); return 2;
  }
  let keys = kit.keys;
  if (args.only) {
    const wanted = new Set(args.only.split(',').map((id) => id.trim()));
    keys = keys.filter((key) => wanted.has(key.docId));
  }
  if (args.limit) keys = keys.slice(0, Math.max(0, Number(args.limit)));
  const fake = Boolean(args.fake);
  const pages = keys.reduce((sum, key) => sum + key.pages, 0);
  const features = process.env.OCR_TEXTRACT_FEATURES === 'layout' && !fake ? 'layout' : 'text';
  const cost = estimate({ pages, features, firstPassModel: process.env.OCR_AI_FIRST_PASS_MODEL || 'claude-sonnet-5-5',
    rereadModel: process.env.OCR_AI_REREAD_MODEL || 'claude-opus-5-5' });
  log(`${keys.length} fictional documents, ${pages} pages (seed ${kit.manifest.seed}).`);
  log(fake ? 'Fake mode: no AWS or Anthropic service is called; cost is $0.' : formatEstimate(cost));
  if (args['estimate-only']) return 0;
  if (!args[CONFIRM_FLAG]) {
    log(`refused: pass --${CONFIRM_FLAG} to confirm that only the kit's generated FICTIONAL documents are`
      + ' being read. Real patient records must never be used with this kit.');
    return 2;
  }

  let worker;
  let config;
  try {
    worker = loadWorker(args['worker-dir'] ? path.resolve(args['worker-dir']) : DEFAULT_WORKER_DIR);
    config = workerConfig(worker, { fake });
  } catch (error) {
    log(`refused: ${error instanceof KitError ? error.message : 'invalid worker configuration'}`);
    if (!(error instanceof KitError) && error instanceof Error) log(error.message);
    return 2;
  }
  if (!fake && config.OCR_AI_MODE !== 'claude') {
    log('refused: set OCR_AI_MODE=claude (with ANTHROPIC_API_KEY and OCR_AI_GLOBAL_PROCESSING_APPROVED=true)');
    return 2;
  }
  const facilityId = (args['facility-id'] ?? config.OCR_AI_FACILITY_IDS?.[0] ?? DEMO_FACILITY_ID).toLowerCase();
  const asyncDocs = keys.filter((key) => key.mediaType === 'application/pdf' || key.mediaType === 'image/tiff');
  if (!fake && asyncDocs.length > 0 && !args['s3-bucket']) {
    log(`refused: ${asyncDocs.length} documents are PDF and are read from S3 by version; pass --s3-bucket`
      + ' (a versioned test bucket), or --only with PNG documents.');
    return 2;
  }
  const docsDir = path.resolve(args.docs ?? path.join(KIT_DIR, 'generated', 'documents'));
  const outDir = path.resolve(args.out ?? path.join(KIT_DIR, 'results', fake ? 'fake' : 'real'));
  mkdirSync(outDir, { recursive: true });
  const context = { worker, config, fake, docsDir, manifest: kit.manifest, facilityId,
    bucket: args['s3-bucket'], prefix: args['s3-prefix'] ?? `ocr-accuracy-kit/seed-${kit.manifest.seed}/` };
  if (!fake) {
    context.claudeClient = new worker.claude.ClaudePageClient(config);
    if (args['s3-bucket']) {
      context.s3 = new worker.s3Sdk.S3Client({ region: config.AWS_REGION, maxAttempts: 3,
        ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL } : {}),
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        ...(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY ? { credentials: {
          accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY } } : {}) });
    }
  }
  const concurrency = Math.max(1, Math.min(16, Number(args.concurrency ?? (fake ? 4 : 2))));
  const todo = keys.filter((key) => !isDone(outDir, key.docId));
  log(`${keys.length - todo.length} already done (skipped); ${todo.length} to read, ${concurrency} at a time.`);
  const controller = new AbortController();
  const stop = () => { log('stopping: finishing nothing new; re-run to resume.'); controller.abort(new Error('stopped')); };
  process.once('SIGINT', stop);
  let finished = 0;
  let failed = 0;
  await pool(todo, concurrency, async (key) => {
    if (controller.signal.aborted) return;
    try {
      const { payload, record } = await processDocument(context, key, controller.signal);
      writeJson(path.join(outDir, `${key.docId}.json`), payload);
      writeJson(path.join(outDir, `${key.docId}.run.json`), record);
      finished += 1;
      const tokens = Object.entries(record.usageByModel).map(([model, u]) =>
        `${model} in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadInputTokens}`).join('; ');
      log(`[${finished + failed}/${todo.length}] ${key.docId} pages=${record.pages} status=${record.reading.status}`
        + ` items=${record.reading.itemCount} dropped=${record.reading.droppedUngrounded}`
        + ` reread=${record.reading.rereadPages.length}${tokens ? ` ${tokens}` : ''}`);
    } catch (error) {
      failed += 1;
      const code = safeCode(error);
      writeJson(path.join(outDir, `${key.docId}.run.json`), { docId: key.docId, file: key.file, status: 'failed',
        mode: fake ? 'fake' : 'real', code, retryable: error?.retryable ?? null });
      log(`[${finished + failed}/${todo.length}] ${key.docId} FAILED code=${code} (re-run to retry)`);
    }
  });
  process.removeListener('SIGINT', stop);
  const totals = summarise(outDir, keys);
  writeJson(path.join(outDir, 'run-summary.json'), totals);
  log(`done: ${totals.documentsDone}/${keys.length} documents, ${totals.pages} pages, ${totals.failed} failed.`);
  for (const [model, usage] of Object.entries(totals.usageByModel)) {
    log(`  ${model}: ${usage.requests} requests, input ${usage.inputTokens}, output ${usage.outputTokens},`
      + ` cache read ${usage.cacheReadInputTokens}, cache write ${usage.cacheCreationInputTokens}`
      + (fake ? '' : `, about $${usage.costUsd.toFixed(2)}`));
  }
  if (!fake) log(`  Textract: ${totals.pages} pages, about $${totals.textractUsd.toFixed(2)}. Total about $${totals.totalUsd.toFixed(2)}.`);
  log(`next: node score.mjs --results ${path.relative(process.cwd(), outDir) || '.'}`);
  return failed > 0 ? 1 : 0;
}

/** Totals across every run record in the output directory (text-free). */
export function summarise(outDir, keys) {
  const usageByModel = {};
  let pages = 0;
  let done = 0;
  let failedCount = 0;
  let features = 'text';
  for (const key of keys) {
    const file = path.join(outDir, `${key.docId}.run.json`);
    if (!existsSync(file)) continue;
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (record.status !== 'done') { failedCount += 1; continue; }
    done += 1;
    pages += record.pages;
    features = record.textract?.features ?? features;
    for (const [model, usage] of Object.entries(record.usageByModel ?? {})) {
      const total = (usageByModel[model] ??= { requests: 0, ...zeroUsage(), costUsd: 0 });
      total.requests += usage.requests;
      addUsage(total, usage);
      total.costUsd += usage.costUsd;
    }
  }
  const textractUsd = pages * (features === 'layout' ? 4 : 1.5) / 1000;
  const aiUsd = Object.values(usageByModel).reduce((sum, usage) => sum + usage.costUsd, 0);
  return { documents: keys.length, documentsDone: done, failed: failedCount, pages, usageByModel,
    textractUsd, totalUsd: textractUsd + aiUsd };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`run failed: ${safeCode(error)}\n`);
    process.exitCode = 1;
  });
}
