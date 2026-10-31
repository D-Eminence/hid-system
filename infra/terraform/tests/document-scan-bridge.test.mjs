import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  ALLOWED_MEDIA_TYPES, AwsClient, EhrClient, Metrics, OBJECT_PREFIX, SCANNER_ENGINE,
  backoffSeconds, bridgeConfiguration, correlationId, handleSqsBatch, idempotencyKey, mapResult,
  readResolvedTarget, reasonSlug, reconcile, reconcileRequest, route, scanStartedKey, validateEnvelope,
} from '../modules/application/runtime/document-scan-bridge/bridge.mjs';
import { TokenCache, lambdaCredentials, signRequest, verifyMintedToken } from '../modules/application/runtime/document-scan-bridge/sigv4.mjs';

// All values are synthetic: a fictional account, bucket, plan and keys.
const ACCOUNT = '123456789012';
const PLAN = `arn:aws:guardduty:eu-west-1:${ACCOUNT}:malware-protection-plan/b4c7f464ab3a4example`;
const BUCKET = 'hid-staging-documents-20261031example';
const QUEUE_URL = `https://sqs.eu-west-1.amazonaws.com/${ACCOUNT}/hid-staging-document-scan-results`;
const QUEUE_ARN = `arn:aws:sqs:eu-west-1:${ACCOUNT}:hid-staging-document-scan-results`;
const ISSUER = 'https://abc123.execute-api.eu-west-1.amazonaws.com/staging';
const EHR = 'https://ehr.internal.staging.example.org';
const KEY = 'clinical/objects/0f8fad5b-d9cb-469f-a165-70867728950e';
const VERSION = '3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY+MTRCxf3vjVBH40Nr8X8gdRQBpUMLUo';
const DOCUMENT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SHA = 'a'.repeat(64);
const CREDENTIALS = { AccessKeyId: 'ASIAEXAMPLE000000001', SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', Token: 'session-token-example-0123456789' };

const environment = (overrides = {}) => ({
  HID_DEPLOYMENT_ENV: 'staging', AWS_REGION: 'eu-west-1',
  WORKLOAD_ISSUER_URL: ISSUER, WORKLOAD_JWKS_URL: `${ISSUER}/.well-known/jwks.json`,
  WORKLOAD_SUBJECT: 'hid:staging:document-scanner', EHR_API_URL: EHR,
  DOCUMENT_BUCKET: BUCKET, OBJECT_PREFIX: 'clinical/objects/', MALWARE_PROTECTION_PLAN_ARN: PLAN,
  RESULTS_QUEUE_URL: QUEUE_URL, BRIDGE_MODE: 'write', ...overrides,
});
const configuration = bridgeConfiguration(environment());
const observe = bridgeConfiguration(environment({ BRIDGE_MODE: 'observe' }));

const scanEvent = ({ scanStatus = 'COMPLETED', scanResultStatus = 'NO_THREATS_FOUND', threats = null, key = KEY,
  versionId = VERSION, bucket = BUCKET, extra = {}, detail = {} } = {}) => ({
  version: '0', id: '6a7e8feb-b491-4cf7-a9f1-bf3703467718',
  'detail-type': 'GuardDuty Malware Protection Object Scan Result', source: 'aws.guardduty',
  account: ACCOUNT, time: '2026-10-31T12:00:00Z', region: 'eu-west-1', resources: [PLAN],
  detail: {
    schemaVersion: '1.0', scanStatus, resourceType: 'S3_OBJECT',
    s3ObjectDetails: { bucketName: bucket, objectKey: key, eTag: '0123456789abcdef', versionId, s3Throttled: false },
    scanResultDetails: { scanResultStatus, threats, ...detail },
  },
  ...extra,
});
const record = (event, { messageId = 'm-1', receiveCount = '1', source = QUEUE_ARN } = {}) => ({
  messageId, receiptHandle: `rh-${messageId}`, body: typeof event === 'string' ? event : JSON.stringify(event),
  attributes: { ApproximateReceiveCount: receiveCount }, eventSource: 'aws:sqs', eventSourceARN: source,
});
// The 200 answer of POST scan-targets/resolve, as ehr-api (0101) builds it.
const target = (overrides = {}) => ({
  documentId: DOCUMENT, objectVersionId: VERSION, sha256Hex: SHA, status: 'uploaded',
  declaredMediaType: 'application/pdf', latestEventType: null, sniffResult: 'supported', sniffedMediaType: 'application/pdf', ...overrides,
});
const json = (status, body, type = 'application/json') => new Response(body === undefined ? null : JSON.stringify(body), {
  status, headers: { 'content-type': type },
});
const problem = (status, code) => json(status, { status, code, title: 'x', detail: 'x' }, 'application/problem+json');

// A fake network: each handler matches method and URL and records the call.
function network(handlers) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const call = { url: String(url), method, headers: options.headers ?? {}, body: options.body };
    calls.push(call);
    const handler = handlers.find(item => item.method === method && item.match(call.url, call));
    if (!handler) throw new Error(`unexpected ${method} ${url}`);
    return handler.respond(call, calls);
  };
  return { fetch, calls };
}
const fakeTokens = () => ({ token: 'header.payload.signature', cleared: 0, get() { return Promise.resolve(this.token); }, clear() { this.cleared += 1; } });

function harness({ resolve = () => json(200, target()), post = () => json(202, { eventId: 'e-1' }), list, visibility = () => json(200, {}),
  guardduty = () => json(200, {}), mode = 'write', remaining = 30_000, now = Date.parse('2026-10-31T12:00:00Z') } = {}) {
  const net = network([
    { method: 'POST', match: url => url === `${EHR}/api/v1/ehr/documents/scan-targets/resolve`, respond: resolve },
    { method: 'POST', match: url => url === `${EHR}/api/v1/ehr/documents/scan-events`, respond: post },
    { method: 'GET', match: url => url.startsWith(`${EHR}/api/v1/ehr/documents/scan-targets?`), respond: list ?? (() => json(200, { items: [] })) },
    { method: 'POST', match: url => url === 'https://sqs.eu-west-1.amazonaws.com/', respond: visibility },
    { method: 'POST', match: url => url === 'https://guardduty.eu-west-1.amazonaws.com/object-malware-scan/send', respond: guardduty },
  ]);
  const config = mode === 'observe' ? observe : configuration;
  const tokens = fakeTokens();
  const lines = [];
  const logs = [];
  const logger = { info: line => logs.push(JSON.parse(line)), warn: line => logs.push(JSON.parse(line)), error: line => logs.push(JSON.parse(line)) };
  const sleeps = [];
  const context = {
    configuration: config, tokens, logger, now: () => now, requestId: 'c0ffee00-1111-4222-8333-444455556666',
    ehr: new EhrClient(config, { fetch: net.fetch, tokens }),
    aws: new AwsClient(config, { fetch: net.fetch, credentials: () => CREDENTIALS, now: () => now }),
    metrics: new Metrics(config, line => lines.push(JSON.parse(line)), () => now),
    sleep: async ms => { sleeps.push(ms); },
    remainingMs: typeof remaining === 'function' ? remaining : () => remaining,
  };
  const metric = name => {
    context.metrics.flush();
    return lines.reduce((sum, line) => sum + (line[name] ?? 0), 0);
  };
  return { context, net, tokens, logs, sleeps, metric, lines };
}
const posted = net => net.calls.filter(call => call.url.endsWith('/scan-events')).map(call => JSON.parse(call.body));
const DTO_REASON = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DTO_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const DTO_CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

// --- configuration --------------------------------------------------------
test('configuration is checked at load and binds account, Region, plan, bucket and queue', () => {
  assert.equal(configuration.accountId, ACCOUNT);
  assert.equal(configuration.queueArn, QUEUE_ARN);
  assert.equal(configuration.ehr, EHR);
  assert.throws(() => bridgeConfiguration(environment({ BRIDGE_MODE: 'on' })), /observe or write/);
  assert.throws(() => bridgeConfiguration(environment({ WORKLOAD_SUBJECT: 'hid:staging:ehr-api' })), /subject/);
  assert.throws(() => bridgeConfiguration(environment({ MALWARE_PROTECTION_PLAN_ARN: PLAN.replace('eu-west-1', 'us-east-1') })), /plan/);
  assert.throws(() => bridgeConfiguration(environment({ OBJECT_PREFIX: 'migration-quarantine/' })), /prefix/);
  assert.throws(() => bridgeConfiguration(environment({ EHR_API_URL: 'http://ehr.internal.staging.example.org' })), /ehr-api/);
  assert.throws(() => bridgeConfiguration(environment({ RESULTS_QUEUE_URL: QUEUE_URL.replace(ACCOUNT, '999999999999') })), /queue/);
  assert.throws(() => bridgeConfiguration(environment({ WORKLOAD_JWKS_URL: 'https://elsewhere.example.org/jwks.json' })), /JWKS/);
});

test('the Lambda entry point loads with the Terraform environment', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, environment(), { AWS_ACCESS_KEY_ID: CREDENTIALS.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: CREDENTIALS.SecretAccessKey, AWS_SESSION_TOKEN: CREDENTIALS.Token });
  try {
    const module = await import('../modules/application/runtime/document-scan-bridge/index.mjs');
    assert.equal(typeof module.handler, 'function');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

// --- 4a envelope validation ---------------------------------------------------
test('envelope validation accepts only our plan, account, Region, bucket and clinical/objects/ versions', () => {
  const valid = validateEnvelope(scanEvent(), configuration);
  assert.equal(valid.ok, true);
  assert.equal(valid.key, KEY);
  assert.equal(valid.versionId, VERSION);
  assert.equal(valid.schemaVersion, '1.0');
  const refused = (event, reason) => assert.deepEqual(validateEnvelope(event, configuration), { ok: false, reason });
  refused(null, 'not-an-object');
  refused({ ...scanEvent(), source: 'aws.s3' }, 'source');
  refused({ ...scanEvent(), 'detail-type': 'Object Created' }, 'detail-type');
  refused({ ...scanEvent(), account: '999999999999' }, 'account');
  refused({ ...scanEvent(), region: 'us-east-1' }, 'region');
  refused({ ...scanEvent(), resources: [PLAN.replace('b4c7', 'ffff')] }, 'plan');
  refused({ ...scanEvent(), id: 'x' }, 'event-id');
  refused(scanEvent({ bucket: 'hid-staging-releases-example' }), 'bucket');
  // GuardDuty's own permission check object, and other prefixes of the bucket.
  refused(scanEvent({ key: 'malware-protection-resource-validation-object' }), 'key');
  refused(scanEvent({ key: 'migration-quarantine/scan-me.pdf' }), 'key');
  refused(scanEvent({ key: `${KEY}/../other` }), 'key');
  // Only the key shape ehr-api writes and its resolve DTO accepts: a lower-case
  // UUID in 8-4-4-4-12 form.
  refused(scanEvent({ key: `clinical/objects/${'-'.repeat(36)}` }), 'key');
  refused(scanEvent({ key: 'clinical/objects/0f8fad5bd9cb469fa16570867728950e0000' }), 'key');
  refused(scanEvent({ key: KEY.toUpperCase().replace('CLINICAL/OBJECTS/', 'clinical/objects/') }), 'key');
  refused(scanEvent({ versionId: '' }), 'version');
  refused(scanEvent({ versionId: 'has space' }), 'version');
  refused(scanEvent({ scanStatus: 'PENDING' }), 'scan-status');
  const noSchema = scanEvent(); noSchema.detail.schemaVersion = 'latest';
  refused(noSchema, 'schema-version');
  const otherResource = scanEvent(); otherResource.detail.resourceType = 'EBS_VOLUME';
  refused(otherResource, 'resource-type');
  assert.equal(validateEnvelope(scanEvent({ scanResultStatus: 'THREATS_FOUND', threats: [{ name: 'EICAR-Test-File (not a virus)' }] }), configuration).threatName,
    'EICAR-Test-File (not a virus)');
});

// --- 4d the full mapping table, with owner decisions D2 and D3 -------------
test('mapping table: every GuardDuty status, with D2 (refuse unscannable) and D3 (accept the real type)', () => {
  const scan = overrides => ({ ...validateEnvelope(scanEvent(overrides), configuration) });
  const cases = [
    ['clean, sniffed equals declared', scan(), target(), { eventType: 'clean', detectedMediaType: 'application/pdf' }],
    ['clean, JPEG declared as PDF: D3 accepts it as image/jpeg', scan(), target({ sniffedMediaType: 'image/jpeg' }),
      { eventType: 'clean', detectedMediaType: 'image/jpeg' }],
    ['clean, PNG declared as JPEG: D3 accepts it as image/png', scan(), target({ declaredMediaType: 'image/jpeg', sniffedMediaType: 'image/png' }),
      { eventType: 'clean', detectedMediaType: 'image/png' }],
    ['clean, TIFF declared as PDF: D3 accepts it as image/tiff', scan(), target({ sniffedMediaType: 'image/tiff' }),
      { eventType: 'clean', detectedMediaType: 'image/tiff' }],
    ['clean bytes of no allowed type', scan(), target({ sniffResult: 'unsupported', sniffedMediaType: null }), { eventType: 'rejected', reasonCode: 'media.unsupported' }],
    ['threats found', scan({ scanResultStatus: 'THREATS_FOUND', threats: [{ name: 'EICAR-Test-File (not a virus)' }] }), target(),
      { eventType: 'rejected', reasonCode: 'guardduty.threats-found' }],
    ['D2: password-protected file', scan({ scanStatus: 'SKIPPED', scanResultStatus: 'UNSUPPORTED', detail: { statusReasons: ['PASSWORD_PROTECTED'] } }), target(),
      { eventType: 'rejected', reasonCode: 'guardduty.unsupported.password-protected' }],
    ['D2: reason given as an object', scan({ scanStatus: 'SKIPPED', scanResultStatus: 'UNSUPPORTED', detail: { statusReasons: [{ reason: 'EXCEEDS_MAX_SIZE' }] } }), target(),
      { eventType: 'rejected', reasonCode: 'guardduty.unsupported.exceeds-max-size' }],
    ['D2: no reason given', scan({ scanStatus: 'SKIPPED', scanResultStatus: 'UNSUPPORTED' }), target(),
      { eventType: 'rejected', reasonCode: 'guardduty.unsupported.unspecified' }],
    ['access denied (configuration fault)', scan({ scanStatus: 'SKIPPED', scanResultStatus: 'ACCESS_DENIED' }), target(),
      { eventType: 'failed', reasonCode: 'guardduty.access-denied' }],
    ['scan failed', scan({ scanStatus: 'FAILED', scanResultStatus: '' }), target(), { eventType: 'failed', reasonCode: 'guardduty.failed' }],
    ['scan failed with a result status', scan({ scanStatus: 'FAILED', scanResultStatus: 'FAILED' }), target(), { eventType: 'failed', reasonCode: 'guardduty.failed' }],
    ['a result GuardDuty does not document is never clean', scan({ scanStatus: 'COMPLETED', scanResultStatus: 'SOMETHING_NEW' }), target(),
      { eventType: 'failed', reasonCode: 'guardduty.unexpected.completed-something-new' }],
  ];
  for (const [name, input, resolved, expected] of cases) {
    const mapped = mapResult(input, resolved);
    assert.equal(mapped.eventType, expected.eventType, name);
    assert.equal(mapped.detectedMediaType, expected.detectedMediaType, name);
    assert.equal(mapped.reasonCode, expected.reasonCode, name);
    assert.equal(mapped.scannerEngine, SCANNER_ENGINE, name);
    assert.equal(mapped.scannerVersion, '1.0', name);
    if (mapped.reasonCode) {
      assert.match(mapped.reasonCode, DTO_REASON, name);
      assert.ok(mapped.reasonCode.length <= 120, name);
    }
    if (mapped.detectedMediaType) assert.ok(ALLOWED_MEDIA_TYPES.has(mapped.detectedMediaType), name);
  }
  // A clean result whose bytes could not be read, or an inconsistent sniff,
  // is never settled on: the record is retried.
  assert.deepEqual(mapResult(scan(), target({ sniffResult: 'unavailable', sniffedMediaType: null })), { retry: true });
  assert.deepEqual(mapResult(scan(), target({ sniffResult: 'supported', sniffedMediaType: 'image/gif' })), { retry: true });
  // A threat or an unscannable file needs no sniff.
  assert.equal(mapResult(scan({ scanResultStatus: 'THREATS_FOUND' }), target({ sniffResult: 'unavailable', sniffedMediaType: null })).eventType, 'rejected');
  assert.equal(reasonSlug('Password_Protected '), 'password-protected');
  assert.equal(reasonSlug('__'), 'unspecified');
  assert.ok(reasonSlug('X'.repeat(500)).length <= 64);
  assert.equal(OBJECT_PREFIX, 'clinical/objects/');
});

// --- 4e deterministic keys ----------------------------------------------------
test('idempotency and correlation keys are deterministic and fit the ehr-api patterns', () => {
  const scan = validateEnvelope(scanEvent(), configuration);
  const key = idempotencyKey(scan);
  assert.match(key, /^gdmp-[0-9a-f]{48}$/);
  assert.match(key, DTO_KEY);
  assert.equal(idempotencyKey({ ...scan }), key, 'a duplicate delivery gets the same key');
  assert.equal(idempotencyKey({ ...scan, threatName: 'other' }), key, 'threat names do not change the key');
  assert.notEqual(idempotencyKey({ ...scan, scanStatus: 'SKIPPED', scanResultStatus: 'UNSUPPORTED' }), key, 'a different result gets a fresh key');
  assert.notEqual(idempotencyKey({ ...scan, scanResultStatus: 'THREATS_FOUND' }), key);
  assert.notEqual(idempotencyKey({ ...scan, versionId: `${VERSION}x` }), key);
  assert.notEqual(idempotencyKey({ ...scan, key: KEY.replace('0f8f', '1f8f') }), key);
  const started = scanStartedKey(VERSION, 2);
  assert.match(started, /^gdod-[0-9a-f]{64}-2$/);
  assert.match(started, DTO_KEY);
  assert.notEqual(scanStartedKey(VERSION, 3), started);
  assert.match(correlationId('gdmp', scan.eventId), DTO_CORRELATION);
  assert.equal(correlationId('gdmp', scan.eventId), 'gdmp-6a7e8feb-b491-4cf7-a9f1-bf3703467718');
});

// --- SQS backoff and batch failures ---------------------------------------
test('backoff starts at one minute, doubles, and stops at the 12 hour SQS limit', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 40].map(backoffSeconds),
    [60, 120, 240, 480, 960, 1920, 3840, 7680, 15360, 30720, 43200, 43200, 43200]);
  assert.equal(backoffSeconds(Number.NaN), 60);
  assert.equal(backoffSeconds(0), 60);
});

test('a retry reports a batch item failure and delays the message with a signed ChangeMessageVisibility', async () => {
  const { context, net } = harness({ resolve: () => problem(409, 'DOCUMENT_NOT_UPLOADED') });
  const result = await handleSqsBatch({ Records: [record(scanEvent(), { messageId: 'm-7', receiveCount: '4' })] }, context);
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm-7' }] });
  const call = net.calls.find(item => item.url === 'https://sqs.eu-west-1.amazonaws.com/');
  assert.deepEqual(JSON.parse(call.body), { QueueUrl: QUEUE_URL, ReceiptHandle: 'rh-m-7', VisibilityTimeout: 480 });
  assert.equal(call.headers['x-amz-target'], 'AmazonSQS.ChangeMessageVisibility');
  assert.equal(call.headers['content-type'], 'application/x-amz-json-1.0');
  assert.match(call.headers.authorization, /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE000000001\/20261031\/eu-west-1\/sqs\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/);
  assert.equal(posted(net).length, 0, 'nothing is written while the upload is not complete');
});

test('a batch acknowledges what is done, fails only what must retry, and survives a failed delay', async () => {
  let resolves = 0;
  const { context, net } = harness({
    resolve: () => (++resolves === 2 ? problem(503, 'DEPENDENCY_UNAVAILABLE') : json(200, target())),
    visibility: () => problem(400, 'AWS.SimpleQueueService.InvalidParameterValue'),
  });
  const result = await handleSqsBatch({ Records: [
    record(scanEvent(), { messageId: 'ok' }),
    record(scanEvent(), { messageId: 'later' }),
    record('not json', { messageId: 'junk' }),
    record(scanEvent(), { messageId: 'foreign', source: QUEUE_ARN.replace('results', 'other') }),
  ] }, context);
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'later' }] });
  assert.equal(posted(net).length, 1);
});

test('an unexpected error retries the record instead of losing it', async () => {
  const { context } = harness({ resolve: () => json(200, { documentId: 'not-a-uuid' }) });
  assert.deepEqual(await handleSqsBatch({ Records: [record(scanEvent(), { messageId: 'bad' })] }, context),
    { batchItemFailures: [{ itemIdentifier: 'bad' }] });
});

test('records that would not finish before the Lambda timeout are left for redelivery', async () => {
  let remaining = 30_000;
  const { context, net } = harness({ remaining: () => remaining, post: () => { remaining = 10_000; return json(202, { eventId: 'e' }); } });
  const result = await handleSqsBatch({ Records: [record(scanEvent(), { messageId: 'first' }), record(scanEvent(), { messageId: 'second' })] }, context);
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'second' }] });
  assert.equal(posted(net).length, 1);
});

// --- every resolve outcome ---------------------------------------------------
test('resolve outcomes: orphan, not completed, stale version, duplicate, not scannable, failures, sniff unavailable', async () => {
  const outcome = async (response, { mode, event = scanEvent() } = {}) => {
    const h = harness({ resolve: () => response, mode });
    const result = await handleSqsBatch({ Records: [record(event)] }, h.context);
    return { failed: result.batchItemFailures.length === 1, writes: posted(h.net).length, h };
  };
  let r = await outcome(problem(404, 'DOCUMENT_NOT_FOUND'));
  assert.deepEqual([r.failed, r.writes, r.h.metric('Orphans')], [false, 0, 1], 'orphan: acknowledged');
  r = await outcome(problem(409, 'DOCUMENT_NOT_UPLOADED'));
  assert.deepEqual([r.failed, r.writes, r.h.metric('Retries')], [true, 0, 1], 'upload not completed: retried');
  r = await outcome(problem(409, 'OBJECT_VERSION_MISMATCH'));
  assert.deepEqual([r.failed, r.writes, r.h.metric('StaleVersions')], [false, 0, 1], 'stale version: acknowledged');
  r = await outcome(problem(409, 'SCAN_ALREADY_TERMINAL'));
  assert.deepEqual([r.failed, r.writes, r.h.metric('Duplicates')], [false, 0, 1], 'terminal already: acknowledged');
  r = await outcome(problem(409, 'DOCUMENT_NOT_SCANNABLE'));
  assert.deepEqual([r.failed, r.writes, r.h.metric('NotScannable')], [false, 0, 1], 'no longer awaiting a scan: acknowledged');
  r = await outcome(json(200, target({ objectVersionId: 'a-later-version' })));
  assert.deepEqual([r.failed, r.writes, r.h.metric('NotScannable')], [false, 0, 1], 'an answer for another version is never written');
  r = await outcome(problem(400, 'INVALID_SCAN_REQUEST'));
  assert.deepEqual([r.failed, r.writes, r.h.metric('ScanEventRefused')], [false, 0, 1], 'a refused request is acknowledged and alarmed');
  for (const [status, code] of [[503, 'DEPENDENCY_UNAVAILABLE'], [500, 'INTERNAL_ERROR'], [403, 'DOCUMENT_SCANNER_FORBIDDEN'], [429, 'RATE_LIMITED']]) {
    r = await outcome(problem(status, code));
    assert.deepEqual([r.failed, r.writes], [true, 0], `${status} ${code}: retried`);
  }
  r = await outcome(problem(401, 'WORKLOAD_AUTHENTICATION_REQUIRED'));
  assert.deepEqual([r.failed, r.writes, r.h.tokens.cleared], [true, 0, 1], 'a refused token is dropped and the record retried');
  r = await outcome(json(200, target({ sniffResult: 'unavailable', sniffedMediaType: null })));
  assert.deepEqual([r.failed, r.writes], [true, 0], 'a clean result waits until ehr-api can read the type');
  r = await outcome(json(200, target({ sniffResult: 'unavailable', sniffedMediaType: null })), { event: scanEvent({ scanResultStatus: 'THREATS_FOUND', threats: [{ name: 'EICAR' }] }) });
  assert.deepEqual([r.failed, r.writes, r.h.metric('ThreatsFound')], [false, 1, 1], 'a threat needs no sniff');
  r = await outcome(json(200, { ...target(), sniffResult: 'maybe' }));
  assert.deepEqual([r.failed, r.writes], [true, 0], 'an answer outside the contract is retried, never written');
  assert.throws(() => readResolvedTarget({ ...target(), sha256Hex: null }), /resolve/);
});

test('the resolve request names the bucket, key and version, with the token and correlation ID', async () => {
  const { context, net } = harness();
  await handleSqsBatch({ Records: [record(scanEvent())] }, context);
  const call = net.calls.find(item => item.url.endsWith('/scan-targets/resolve'));
  assert.deepEqual(JSON.parse(call.body), { storageBucket: BUCKET, storageKey: KEY, objectVersionId: VERSION });
  assert.equal(call.headers.authorization, 'Bearer header.payload.signature');
  assert.equal(call.headers['x-correlation-id'], 'gdmp-6a7e8feb-b491-4cf7-a9f1-bf3703467718');
  assert.equal(call.headers['content-type'], 'application/json');
});

// --- scan-events write and the response table -----------------------------
test('a clean result writes exactly the DTO fields, bound to the version and SHA-256', async () => {
  const { context, net, metric } = harness({ resolve: () => json(200, target({ sniffedMediaType: 'image/jpeg' })) });
  assert.deepEqual(await handleSqsBatch({ Records: [record(scanEvent())] }, context), { batchItemFailures: [] });
  const [event] = posted(net);
  assert.deepEqual(event, {
    documentId: DOCUMENT, objectVersionId: VERSION, objectSha256Hex: SHA, eventType: 'clean',
    detectedMediaType: 'image/jpeg', scannerEngine: SCANNER_ENGINE, scannerVersion: '1.0',
    idempotencyKey: idempotencyKey(validateEnvelope(scanEvent(), configuration)),
  });
  assert.equal(metric('EventsWritten'), 1);
  assert.equal(metric('MediaTypeCorrected'), 1);
});

test('a duplicate delivery replays the identical event, so ehr-api returns the original event ID', async () => {
  const { context, net } = harness();
  await handleSqsBatch({ Records: [record(scanEvent(), { messageId: 'a' }), record(scanEvent(), { messageId: 'b', receiveCount: '2' })] }, context);
  const [first, second] = posted(net);
  assert.deepEqual(first, second);
});

test('scan-events responses: written, terminal, not uploaded, auth, outage, refusals', async () => {
  const outcome = async response => {
    const h = harness({ post: () => response });
    const result = await handleSqsBatch({ Records: [record(scanEvent())] }, h.context);
    return { failed: result.batchItemFailures.length === 1, h };
  };
  let r = await outcome(json(202, { eventId: 'e-1' }));
  assert.deepEqual([r.failed, r.h.metric('EventsWritten')], [false, 1]);
  r = await outcome(problem(409, 'SCAN_ALREADY_TERMINAL'));
  assert.deepEqual([r.failed, r.h.metric('Duplicates')], [false, 1]);
  r = await outcome(problem(409, 'DOCUMENT_NOT_UPLOADED'));
  assert.deepEqual([r.failed, r.h.metric('Retries')], [true, 1]);
  for (const [status, code] of [[401, 'WORKLOAD_AUTHENTICATION_REQUIRED'], [403, 'ACCESS_DENIED'], [429, 'RATE_LIMITED'], [500, 'INTERNAL_ERROR'], [503, 'IDENTITY_SERVICE_UNAVAILABLE']]) {
    r = await outcome(problem(status, code));
    assert.equal(r.failed, true, `${status} retries`);
  }
  // A 404 right after resolve found the document is a database fault, not an
  // orphan: acknowledged with the refusal alarm, never counted as an orphan.
  r = await outcome(problem(404, 'DOCUMENT_NOT_FOUND'));
  assert.deepEqual([r.failed, r.h.metric('ScanEventRefused'), r.h.metric('Orphans')], [false, 1, 0]);
  assert.equal(r.h.logs.at(-1).level, 'error');
  r = await outcome(problem(409, 'DOCUMENT_NOT_SCANNABLE'));
  assert.deepEqual([r.failed, r.h.metric('NotScannable')], [false, 1]);
  r = await outcome(problem(409, 'OBJECT_VERSION_MISMATCH'));
  assert.deepEqual([r.failed, r.h.metric('StaleVersions')], [false, 1]);
  for (const [status, code] of [[400, 'INVALID_SCAN_REQUEST'], [409, 'SCAN_IDEMPOTENCY_CONFLICT'], [409, 'CONFLICT']]) {
    r = await outcome(problem(status, code));
    assert.deepEqual([r.failed, r.h.metric('ScanEventRefused')], [false, 1], `${code} is refused, not retried`);
  }
});

test('observe mode resolves and maps but never writes', async () => {
  const { context, net, metric, logs } = harness({ mode: 'observe', resolve: () => json(200, target({ sniffedMediaType: 'image/png' })) });
  assert.deepEqual(await handleSqsBatch({ Records: [record(scanEvent())] }, context), { batchItemFailures: [] });
  assert.equal(posted(net).length, 0);
  assert.equal(metric('Observed'), 1);
  const line = logs.find(item => item.message === 'Observe mode: scan event not written');
  assert.equal(line.eventType, 'clean');
  assert.equal(line.detectedMediaType, 'image/png');
});

test('logs carry no patient data: only IDs, statuses, codes and threat names', async () => {
  const { context, logs } = harness({ resolve: () => json(200, target({ patientName: 'should never be logged' })) });
  await handleSqsBatch({ Records: [record(scanEvent({ scanResultStatus: 'THREATS_FOUND', threats: [{ name: 'EICAR-Test-File (not a virus)' }] }))] }, context);
  const text = JSON.stringify(logs);
  assert.ok(!text.includes('should never be logged'));
  assert.ok(text.includes('EICAR-Test-File (not a virus)'));
});

// --- token fetch and cache ------------------------------------------------
function issuerKit() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kid-1', alg: 'ES256', use: 'sig' };
  const mint = (now, claims = {}) => {
    const iat = Math.floor(now / 1000);
    const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = { iss: ISSUER, sub: 'hid:staging:document-scanner', aud: 'hid-identity-api', iat, nbf: iat, exp: iat + 300,
      jti: 'jti-1', token_use: 'workload', ...claims };
    const message = `${encoded({ alg: 'ES256', kid: 'kid-1', typ: 'JWT' })}.${encoded(body)}`;
    const signature = sign('sha256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return { token: `${message}.${signature}`, expiresAt: new Date(body.exp * 1000).toISOString() };
  };
  return { jwks: { keys: [jwk] }, mint };
}

test('the token is minted with a signed /token request, checked against the JWKS, and cached until 60 s before expiry', async () => {
  const kit = issuerKit();
  let now = Date.parse('2026-10-31T12:00:00Z');
  let mints = 0;
  const net = network([
    { method: 'GET', match: url => url === `${ISSUER}/.well-known/jwks.json`, respond: () => json(200, kit.jwks) },
    { method: 'POST', match: url => url === `${ISSUER}/token`, respond: () => { mints += 1; return json(200, kit.mint(now)); } },
  ]);
  const cache = new TokenCache(configuration, { fetch: net.fetch, credentials: () => CREDENTIALS, now: () => now });
  const first = await cache.get();
  const tokenCall = net.calls.find(call => call.url === `${ISSUER}/token`);
  assert.equal(tokenCall.body, '{"audience":"hid-identity-api"}');
  assert.equal(tokenCall.headers['x-amz-security-token'], CREDENTIALS.Token);
  assert.match(tokenCall.headers.authorization, /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE000000001\/20261031\/eu-west-1\/execute-api\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  now += 239_000;
  assert.equal(await cache.get(), first, 'reused until 60 s before expiry');
  assert.equal(mints, 1);
  now += 2_000;
  const second = await cache.get();
  assert.equal(mints, 2, 'renewed inside the last 60 s');
  assert.notEqual(second, undefined);
  cache.clear();
  await cache.get();
  assert.equal(mints, 3, 'a cleared cache mints again');
});

test('the token check refuses the wrong subject, audience or issuer, a forged signature and an issuer error', async () => {
  const kit = issuerKit();
  const now = Date.parse('2026-10-31T12:00:00Z');
  const check = response => () => verifyMintedToken(response, kit.jwks, configuration, 'hid-identity-api', now);
  assert.doesNotThrow(check(kit.mint(now)));
  assert.throws(check(kit.mint(now, { sub: 'hid:staging:ehr-api' })), /claims/);
  assert.throws(check(kit.mint(now, { aud: 'hid-ehr-api' })), /claims/);
  assert.throws(check(kit.mint(now, { iss: 'https://evil.example.org/staging' })), /claims/);
  assert.throws(check(kit.mint(now, { exp: Math.floor(now / 1000) + 900 })), /claims/);
  const other = issuerKit().mint(now);
  assert.throws(check(other), /signature/);
  const refusing = network([
    { method: 'GET', match: url => url.endsWith('/jwks.json'), respond: () => json(200, kit.jwks) },
    { method: 'POST', match: url => url.endsWith('/token'), respond: () => json(403, { code: 'WORKLOAD_CALLER_DENIED' }) },
  ]);
  await assert.rejects(new TokenCache(configuration, { fetch: refusing.fetch, credentials: () => CREDENTIALS, now: () => now }).get(), /refused/);
  assert.throws(() => lambdaCredentials({ AWS_ACCESS_KEY_ID: 'AKIALONGTERMKEY00001', AWS_SECRET_ACCESS_KEY: 'x'.repeat(40), AWS_SESSION_TOKEN: 'y'.repeat(20) }), /credentials/);
  assert.deepEqual(lambdaCredentials({ AWS_ACCESS_KEY_ID: CREDENTIALS.AccessKeyId, AWS_SECRET_ACCESS_KEY: CREDENTIALS.SecretAccessKey, AWS_SESSION_TOKEN: CREDENTIALS.Token }), CREDENTIALS);
});

test('the signer matches botocore SigV4 for the three calls the bridge makes', () => {
  // Reference signatures computed offline with botocore SigV4Auth at the same
  // instant and with the same synthetic credentials.
  const now = new Date('2026-10-31T12:00:00Z');
  const signature = (url, service, body, headers) => signRequest({ url, service, region: 'eu-west-1', credentials: CREDENTIALS, body, headers, now })
    .headers.authorization.split('Signature=')[1];
  assert.equal(signature(`${ISSUER}/token`, 'execute-api', '{"audience":"hid-identity-api"}', { 'content-type': 'application/json' }),
    'bf0fe4276a84b72ea574d56b36253da89b0665f03b5f06a844902c252ecfdab3');
  assert.equal(signature('https://sqs.eu-west-1.amazonaws.com/', 'sqs',
    '{"QueueUrl":"https://sqs.eu-west-1.amazonaws.com/123456789012/q","ReceiptHandle":"rh","VisibilityTimeout":60}',
    { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AmazonSQS.ChangeMessageVisibility' }),
  'f87dd3a84bfddce214348ac5545184f97664a802eb2d6fff8b9c898047efa59e');
  assert.equal(signature('https://guardduty.eu-west-1.amazonaws.com/object-malware-scan/send', 'guardduty',
    '{"s3Object":{"bucket":"b","key":"k","versionId":"v"}}', { 'content-type': 'application/json' }),
  '42b4ec1069bbe3b296a7ee0e6a911eb4d0f6dc2ea760e858304764cf149b80be');
  assert.throws(() => signRequest({ url: 'http://sqs.eu-west-1.amazonaws.com/', service: 'sqs', region: 'eu-west-1', credentials: CREDENTIALS, body: '{}' }), /endpoint/);
  assert.throws(() => signRequest({ url: 'https://sqs.eu-west-1.amazonaws.com/?Action=x', service: 'sqs', region: 'eu-west-1', credentials: CREDENTIALS, body: '{}' }), /endpoint/);
});

// --- reconcile ----------------------------------------------------------------
// An item of GET scan-targets, as ehr-api (0101) builds it.
const item = (overrides = {}) => ({
  documentId: DOCUMENT, storageBucket: BUCKET, storageKey: KEY, objectVersionId: VERSION, sha256Hex: SHA,
  declaredMediaType: 'application/pdf', updatedAt: '2026-10-31T10:00:00Z', latestEventType: null,
  scanStartedCount: 0, lastScanStartedAt: null, ...overrides,
});

test('reconcile records scan_started first, then asks GuardDuty to scan that exact version, about two per second', async () => {
  const second = item({ documentId: 'c56a4180-65aa-42ec-a945-5fd21dec0538', storageKey: 'clinical/objects/c56a4180-65aa-42ec-a945-5fd21dec0538',
    objectVersionId: 'v2', scanStartedCount: 1, lastScanStartedAt: '2026-10-31T09:00:00Z', latestEventType: 'scan_started', updatedAt: '2026-10-30T12:00:00Z' });
  const { context, net, sleeps, metric } = harness({ list: () => json(200, { items: [item(), second] }) });
  const summary = await route({ action: 'reconcile' }, context);
  assert.equal(summary.started, 2);
  const list = net.calls.find(call => call.method === 'GET');
  assert.equal(list.url, `${EHR}/api/v1/ehr/documents/scan-targets?olderThanSeconds=900&limit=50`);
  assert.equal(list.headers['x-correlation-id'], 'gdrc-c0ffee00-1111-4222-8333-444455556666');
  const events = posted(net);
  assert.deepEqual(events[0], { documentId: DOCUMENT, objectVersionId: VERSION, objectSha256Hex: SHA, eventType: 'scan_started',
    scannerEngine: SCANNER_ENGINE, scannerVersion: 'on-demand', idempotencyKey: scanStartedKey(VERSION, 1) });
  assert.equal(events[1].idempotencyKey, scanStartedKey('v2', 2));
  const scans = net.calls.filter(call => call.url.endsWith('/object-malware-scan/send'));
  assert.deepEqual(scans.map(call => JSON.parse(call.body)), [
    { s3Object: { bucket: BUCKET, key: KEY, versionId: VERSION } },
    { s3Object: { bucket: BUCKET, key: second.storageKey, versionId: 'v2' } },
  ]);
  assert.match(scans[0].headers.authorization, /\/eu-west-1\/guardduty\/aws4_request, /);
  // scan_started is written before each scan request.
  const order = net.calls.filter(call => call.url.endsWith('/scan-events') || call.url.endsWith('/send')).map(call => (call.url.endsWith('/send') ? 'scan' : 'started'));
  assert.deepEqual(order, ['started', 'scan', 'started', 'scan']);
  assert.deepEqual(sleeps, [500]);
  assert.equal(metric('OldestPendingScanSeconds'), 86_400);
  assert.equal(metric('ReconcileStarted'), 2);
});

test('reconcile skips recent attempts, gives up after three with an alarm, and ignores other buckets and prefixes', async () => {
  const { context, net, metric } = harness({ list: () => json(200, { items: [
    item({ scanStartedCount: 1, lastScanStartedAt: '2026-10-31T11:30:00Z' }),
    item({ scanStartedCount: 3, lastScanStartedAt: '2026-10-30T11:30:00Z' }),
    item({ storageBucket: 'another-bucket' }),
    item({ storageKey: 'migration-quarantine/x.pdf' }),
    item({ storageKey: `clinical/objects/${'-'.repeat(36)}` }),
  ] }) });
  const summary = await reconcile({ action: 'reconcile' }, context);
  assert.deepEqual([summary.inProgress, summary.exhausted, summary.skipped, summary.started], [1, 1, 3, 0]);
  assert.equal(posted(net).length, 0);
  assert.equal(net.calls.filter(call => call.url.endsWith('/send')).length, 0);
  assert.equal(metric('ReconcileExhausted'), 1);
});

test('reconcile in observe mode lists but writes nothing and starts no scan', async () => {
  const { context, net } = harness({ mode: 'observe', list: () => json(200, { items: [item()] }) });
  const summary = await reconcile({ action: 'reconcile', olderThanSeconds: 0, limit: 10 }, context);
  assert.equal(summary.started, 0);
  assert.equal(net.calls.find(call => call.method === 'GET').url, `${EHR}/api/v1/ehr/documents/scan-targets?olderThanSeconds=0&limit=10`);
  assert.equal(posted(net).length, 0);
  assert.equal(net.calls.filter(call => call.url.endsWith('/send')).length, 0);
});

test('reconcile: a refused scan_started skips the scan; a GuardDuty refusal is counted; the deadline defers the rest', async () => {
  let posts = 0;
  const { context, net, metric } = harness({
    list: () => json(200, { items: [item(), item({ objectVersionId: 'v2' }), item({ objectVersionId: 'v3' })] }),
    post: () => (++posts === 1 ? problem(409, 'SCAN_ALREADY_TERMINAL') : json(202, { eventId: 'e' })),
    guardduty: () => json(403, { __type: 'AccessDeniedException' }),
    remaining: (() => { let calls = 0; return () => (++calls >= 3 ? 1_000 : 30_000); })(),
  });
  const summary = await reconcile({ action: 'reconcile' }, context);
  assert.deepEqual([summary.skipped, summary.failed, summary.deferred, summary.started], [1, 1, 1, 0]);
  assert.equal(net.calls.filter(call => call.url.endsWith('/send')).length, 1);
  assert.equal(metric('ScanAccessDenied'), 1);
});

test('reconcile requests are checked, and a failed listing fails the run', async () => {
  assert.deepEqual(reconcileRequest({ action: 'reconcile' }), { olderThanSeconds: 900, limit: 50 });
  assert.deepEqual(reconcileRequest({ action: 'reconcile', olderThanSeconds: 0, limit: 50 }), { olderThanSeconds: 0, limit: 50 });
  assert.throws(() => reconcileRequest({ action: 'reconcile', limit: 51 }), /limit/);
  assert.throws(() => reconcileRequest({ action: 'reconcile', olderThanSeconds: -1 }), /olderThanSeconds/);
  assert.throws(() => reconcileRequest({ action: 'reconcile', bucket: 'x' }), /Unknown/);
  const { context } = harness({ list: () => problem(503, 'DEPENDENCY_UNAVAILABLE') });
  await assert.rejects(route({ action: 'reconcile' }, context), /503/);
});

// --- plan status, routing and metrics ------------------------------------
test('plan status warnings and errors raise the plan alarm metric; others are ignored', async () => {
  const status = (resources = [PLAN]) => ({ source: 'aws.guardduty', 'detail-type': 'GuardDuty Malware Protection Resource Status Error',
    account: ACCOUNT, region: 'eu-west-1', resources, detail: { status: 'ERROR', statusReasons: 'EVENTBRIDGE_MANAGED_EVENTS_DELIVERY_DISABLED' } });
  let h = harness();
  assert.deepEqual(await route(status(), h.context), { recorded: true });
  assert.equal(h.metric('PlanStatusProblem'), 1);
  h = harness();
  assert.deepEqual(await route(status([PLAN.replace('b4c7', 'ffff')]), h.context), { ignored: true });
  h = harness();
  assert.deepEqual(await route({ hello: 'world' }, h.context), { ignored: true });
  assert.equal(h.metric('EnvelopeRejected'), 1);
});

test('metrics are written as one embedded-metric-format line per invocation', async () => {
  const { context, lines } = harness();
  await route({ Records: [record(scanEvent())] }, context);
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line._aws.CloudWatchMetrics[0].Namespace, 'HID/DocumentScanning');
  assert.deepEqual(line._aws.CloudWatchMetrics[0].Dimensions, [['Environment']]);
  assert.equal(line.Environment, 'staging');
  assert.equal(line.EventsWritten, 1);
  assert.ok(line._aws.CloudWatchMetrics[0].Metrics.some(metric => metric.Name === 'EventsWritten' && metric.Unit === 'Count'));
});
