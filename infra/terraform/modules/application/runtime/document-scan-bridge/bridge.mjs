import { createHash } from 'node:crypto';
import { boundedJson, signRequest } from './sigv4.mjs';

// GuardDuty Malware Protection for S3 -> ehr-api scan-events bridge.
//
// The bridge never reads object bytes, tags, metadata or KMS. It turns each
// GuardDuty scan result into one ehr-api scan event bound to the document's
// exact S3 VersionId and SHA-256, through the internal ALB, with a workload
// token from the managed issuer. Logs carry object keys (random UUIDs),
// document IDs, statuses and threat names; never patient data.

export const SCANNER_ENGINE = 'aws-guardduty-malware-protection-s3';
export const ON_DEMAND_SCANNER_VERSION = 'on-demand';
export const SCAN_RESULT_DETAIL_TYPE = 'GuardDuty Malware Protection Object Scan Result';
export const PLAN_STATUS_DETAIL_TYPES = new Set([
  'GuardDuty Malware Protection Resource Status Warning',
  'GuardDuty Malware Protection Resource Status Error',
  'GuardDuty Malware Protection Post Scan Action Failed',
]);
// The four types ehr-api accepts (dto/document-scan-event.dto.ts).
export const ALLOWED_MEDIA_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/tiff']);
export const OBJECT_PREFIX = 'clinical/objects/';
export const MAX_VISIBILITY_SECONDS = 43_200;
export const FIRST_BACKOFF_SECONDS = 60;
export const RECONCILE_MAX_ATTEMPTS = 3;
export const RECONCILE_RESTART_SECONDS = 3_600;
export const RECONCILE_MAX_LIMIT = 50;
export const RECONCILE_DEFAULT_OLDER_THAN_SECONDS = 900;
export const RECONCILE_SCAN_SPACING_MS = 500;
// Exactly the key shape ehr-api's upload intent writes and its resolve DTO
// accepts (clinical/objects/<lower-case UUID>); anything else is not a document.
const KEY_PATTERN = /^clinical\/objects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function bridgeConfiguration(environment) {
  const deployment = environment.HID_DEPLOYMENT_ENV;
  if (!['staging', 'production'].includes(deployment)) throw new Error('Invalid bridge environment');
  const region = environment.AWS_REGION;
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region ?? '')) throw new Error('Invalid bridge AWS region');
  const issuer = new URL(environment.WORKLOAD_ISSUER_URL);
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.port || issuer.search || issuer.hash
    || issuer.pathname !== `/${deployment}` || !new RegExp(`^[a-z0-9]+\\.execute-api\\.${region}\\.amazonaws\\.com$`).test(issuer.hostname)) {
    throw new Error('Invalid workload issuer URL');
  }
  if (environment.WORKLOAD_JWKS_URL !== `${issuer.href}/.well-known/jwks.json`) throw new Error('JWKS must belong to the configured issuer');
  const subject = environment.WORKLOAD_SUBJECT;
  if (subject !== `hid:${deployment}:document-scanner`) throw new Error('Invalid workload subject');
  const ehr = new URL(environment.EHR_API_URL);
  if (ehr.protocol !== 'https:' || ehr.username || ehr.password || ehr.port || ehr.search || ehr.hash || ehr.pathname !== '/') {
    throw new Error('Invalid ehr-api URL');
  }
  const bucket = environment.DOCUMENT_BUCKET;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '')) throw new Error('Invalid document bucket');
  if (environment.OBJECT_PREFIX !== OBJECT_PREFIX) throw new Error('Only the clinical/objects/ prefix is scanned');
  const plan = /^arn:aws:guardduty:([a-z0-9-]+):(\d{12}):malware-protection-plan\/[A-Za-z0-9]{1,64}$/.exec(environment.MALWARE_PROTECTION_PLAN_ARN ?? '');
  if (!plan || plan[1] !== region) throw new Error('Invalid malware protection plan');
  const queue = new RegExp(`^https://sqs\\.${region}\\.amazonaws\\.com/${plan[2]}/([A-Za-z0-9_-]{1,80})$`).exec(environment.RESULTS_QUEUE_URL ?? '');
  if (!queue) throw new Error('Invalid results queue');
  const mode = environment.BRIDGE_MODE;
  if (!['observe', 'write'].includes(mode)) throw new Error('Bridge mode must be observe or write');
  return Object.freeze({
    deployment, region, issuer: issuer.href, jwks: environment.WORKLOAD_JWKS_URL, subject,
    ehr: ehr.origin, bucket, accountId: plan[2], planArn: plan[0],
    queueUrl: queue[0], queueArn: `arn:aws:sqs:${region}:${plan[2]}:${queue[1]}`, mode,
  });
}

// ---------------------------------------------------------------------------
// 4a. Envelope validation. Anything that is not a scan result for an object
// version under clinical/objects/ of our bucket, from our plan, account and
// Region, is dropped (and counted). That includes GuardDuty's root-level
// malware-protection-resource-validation-object.
export function validateEnvelope(event, configuration) {
  const refuse = reason => ({ ok: false, reason });
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return refuse('not-an-object');
  if (event.source !== 'aws.guardduty') return refuse('source');
  if (event['detail-type'] !== SCAN_RESULT_DETAIL_TYPE) return refuse('detail-type');
  if (event.account !== configuration.accountId) return refuse('account');
  if (event.region !== configuration.region) return refuse('region');
  if (!Array.isArray(event.resources) || !event.resources.includes(configuration.planArn)) return refuse('plan');
  if (typeof event.id !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(event.id)) return refuse('event-id');
  const detail = event.detail;
  if (typeof detail !== 'object' || detail === null) return refuse('detail');
  if (typeof detail.schemaVersion !== 'string' || !/^\d{1,4}(\.\d{1,4}){0,3}$/.test(detail.schemaVersion)) return refuse('schema-version');
  if (detail.resourceType !== undefined && detail.resourceType !== 'S3_OBJECT') return refuse('resource-type');
  const object = detail.s3ObjectDetails;
  if (typeof object !== 'object' || object === null) return refuse('object');
  if (object.bucketName !== configuration.bucket) return refuse('bucket');
  if (typeof object.objectKey !== 'string' || !KEY_PATTERN.test(object.objectKey)) return refuse('key');
  if (typeof object.versionId !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(object.versionId)) return refuse('version');
  if (!['COMPLETED', 'SKIPPED', 'FAILED'].includes(detail.scanStatus)) return refuse('scan-status');
  const result = detail.scanResultDetails ?? {};
  const scanResultStatus = result.scanResultStatus ?? '';
  if (typeof scanResultStatus !== 'string' || !/^[A-Z_]{0,64}$/.test(scanResultStatus)) return refuse('scan-result-status');
  const threat = Array.isArray(result.threats) ? result.threats.find(item => typeof item?.name === 'string') : undefined;
  return {
    ok: true,
    eventId: event.id,
    schemaVersion: detail.schemaVersion,
    bucket: object.bucketName,
    key: object.objectKey,
    versionId: object.versionId,
    scanStatus: detail.scanStatus,
    scanResultStatus,
    threatName: threat ? threat.name.slice(0, 200) : undefined,
    statusReason: firstReason(result),
    s3Throttled: object.s3Throttled === true,
  };
}

function firstReason(result) {
  const candidates = [result.statusReasons, result.statusReason, result.skippedReason, result.reason];
  for (const candidate of candidates) {
    const values = Array.isArray(candidate) ? candidate : [candidate];
    for (const value of values) {
      const text = typeof value === 'string' ? value
        : typeof value === 'object' && value !== null
          ? [value.reason, value.code, value.name, value.statusReason].find(item => typeof item === 'string')
          : undefined;
      if (text && text.trim()) return text;
    }
  }
  return undefined;
}

// Lower case with dashes, as ehr-api's reasonCode forbids '_' (dto:47).
export function reasonSlug(value) {
  const slug = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
  return slug || 'unspecified';
}

// ---------------------------------------------------------------------------
// 4d. Result mapping. D2: what GuardDuty cannot scan is refused. D3: a clean
// file whose sniffed type is allowed is accepted under its real type even if
// it was declared as another one.
export function mapResult(scan, target) {
  const base = { scannerEngine: SCANNER_ENGINE, scannerVersion: scan.schemaVersion };
  const resultStatus = scan.scanResultStatus;
  if (resultStatus === 'UNSUPPORTED') {
    return { ...base, eventType: 'rejected', reasonCode: `guardduty.unsupported.${reasonSlug(scan.statusReason)}` };
  }
  if (resultStatus === 'ACCESS_DENIED') {
    return { ...base, eventType: 'failed', reasonCode: 'guardduty.access-denied', accessDenied: true };
  }
  if (scan.scanStatus === 'FAILED' || resultStatus === 'FAILED') {
    return { ...base, eventType: 'failed', reasonCode: 'guardduty.failed' };
  }
  if (scan.scanStatus === 'COMPLETED' && resultStatus === 'THREATS_FOUND') {
    return { ...base, eventType: 'rejected', reasonCode: 'guardduty.threats-found', threatFound: true };
  }
  if (scan.scanStatus === 'COMPLETED' && resultStatus === 'NO_THREATS_FOUND') {
    const sniffed = target.sniffedMediaType;
    if (target.sniffResult === 'supported' && ALLOWED_MEDIA_TYPES.has(sniffed)) {
      return { ...base, eventType: 'clean', detectedMediaType: sniffed, declaredMismatch: sniffed !== target.declaredMediaType };
    }
    if (target.sniffResult === 'unsupported') return { ...base, eventType: 'rejected', reasonCode: 'media.unsupported' };
    // The bytes could not be read, or the answer is inconsistent: never a
    // terminal result on that; the record is retried.
    return { retry: true };
  }
  // A SKIPPED or COMPLETED result GuardDuty documents no meaning for: never
  // clean. 'failed' is not terminal, so a reconcile scan can still settle it.
  return { ...base, eventType: 'failed', reasonCode: `guardduty.unexpected.${reasonSlug(`${scan.scanStatus}-${resultStatus}`)}` };
}

// 4e. Deterministic keys: a duplicate delivery of the same result replays the
// original event; a later, different scan result of the same version gets a
// fresh key. The object key is hashed in as well, so equal version IDs of two
// different objects can never collide.
export function idempotencyKey(scan) {
  return `gdmp-${sha256(`${scan.key}|${scan.versionId}|${scan.scanStatus}|${scan.scanResultStatus}`).slice(0, 48)}`;
}

export function scanStartedKey(versionId, attempt) {
  return `gdod-${sha256(versionId)}-${attempt}`;
}

export function correlationId(prefix, id) {
  const value = `${prefix}-${String(id).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 100)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw new Error('Invalid correlation ID');
  return value;
}

export function backoffSeconds(receiveCount) {
  const count = Number.isSafeInteger(receiveCount) && receiveCount > 0 ? receiveCount : 1;
  return Math.min(FIRST_BACKOFF_SECONDS * 2 ** Math.min(count - 1, 20), MAX_VISIBILITY_SECONDS);
}

// ---------------------------------------------------------------------------
// ehr-api client. Routes and bodies are the backend line's; see the contract
// section of the build report.
export class EhrClient {
  constructor(configuration, dependencies) {
    this.configuration = configuration;
    this.fetch = dependencies.fetch;
    this.tokens = dependencies.tokens;
  }
  async call(method, path, correlation, body) {
    const token = await this.tokens.get();
    const response = await this.fetch(`${this.configuration.ehr}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(7000),
      headers: {
        authorization: `Bearer ${token}`,
        'x-correlation-id': correlation,
        accept: 'application/json, application/problem+json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json;
    try { json = await boundedJson(response, 262_144); } catch { json = undefined; }
    // A refused token is dropped so the next call mints a fresh one.
    if (response.status === 401 || response.status === 403) this.tokens.clear();
    return { status: response.status, body: json, code: typeof json?.code === 'string' ? json.code : undefined };
  }
  resolveTarget(scan, correlation) {
    return this.call('POST', '/api/v1/ehr/documents/scan-targets/resolve', correlation, {
      storageBucket: scan.bucket, storageKey: scan.key, objectVersionId: scan.versionId,
    });
  }
  listTargets(olderThanSeconds, limit, correlation) {
    return this.call('GET', `/api/v1/ehr/documents/scan-targets?olderThanSeconds=${olderThanSeconds}&limit=${limit}`, correlation);
  }
  postScanEvent(event, correlation) {
    return this.call('POST', '/api/v1/ehr/documents/scan-events', correlation, event);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

// The 200 answer of POST scan-targets/resolve (ehr-api, 0101): only for an
// uploaded document bound to exactly this version with no clean or rejected
// result yet; every other case is a 404 or 409 refusal with a code. ehr-api
// also reads the first KiB of that version: sniffResult 'supported' (and
// sniffedMediaType names one of the four types), 'unsupported' or
// 'unavailable' (it could not read them; never a reason to refuse).
export function readResolvedTarget(body) {
  if (typeof body !== 'object' || body === null || !UUID.test(body.documentId ?? '')
    || typeof body.status !== 'string' || typeof body.objectVersionId !== 'string'
    || !SHA.test(body.sha256Hex ?? '') || typeof body.declaredMediaType !== 'string'
    || !(body.latestEventType === null || typeof body.latestEventType === 'string')
    || !['supported', 'unsupported', 'unavailable'].includes(body.sniffResult)
    || !(body.sniffedMediaType === null || typeof body.sniffedMediaType === 'string')) {
    throw new Error('Unexpected resolve response');
  }
  return body;
}

export function readTargetList(body) {
  if (typeof body !== 'object' || body === null || !Array.isArray(body.items) || body.items.length > 100) {
    throw new Error('Unexpected scan-targets response');
  }
  return body.items.map(item => {
    if (typeof item !== 'object' || item === null || !UUID.test(item.documentId ?? '')
      || typeof item.storageBucket !== 'string' || typeof item.storageKey !== 'string'
      || typeof item.objectVersionId !== 'string' || !SHA.test(item.sha256Hex ?? '')
      || !(item.latestEventType === null || typeof item.latestEventType === 'string')
      || !Number.isSafeInteger(item.scanStartedCount) || item.scanStartedCount < 0
      || !(item.lastScanStartedAt === null || Number.isFinite(Date.parse(item.lastScanStartedAt)))
      || !Number.isFinite(Date.parse(item.updatedAt))) {
      throw new Error('Unexpected scan-targets item');
    }
    return item;
  });
}

// ---------------------------------------------------------------------------
// AWS calls the bridge signs itself with its Lambda role (no SDK dependency).
export class AwsClient {
  constructor(configuration, dependencies) {
    this.configuration = configuration;
    this.fetch = dependencies.fetch;
    this.credentials = dependencies.credentials;
    this.now = dependencies.now ?? Date.now;
  }
  async send(url, service, body, headers) {
    const signed = signRequest({
      url, service, region: this.configuration.region, credentials: this.credentials(),
      body: JSON.stringify(body), headers, now: new Date(this.now()),
    });
    const response = await this.fetch(signed.url, { ...signed, signal: AbortSignal.timeout(5000) });
    let json;
    try { json = await boundedJson(response); } catch { json = undefined; }
    if (!response.ok) {
      const error = new Error(`${service} refused the request`);
      error.status = response.status;
      error.code = json?.__type ?? json?.code ?? json?.Code;
      throw error;
    }
    return json;
  }
  changeVisibility(receiptHandle, seconds) {
    return this.send(`https://sqs.${this.configuration.region}.amazonaws.com/`, 'sqs', {
      QueueUrl: this.configuration.queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds,
    }, { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AmazonSQS.ChangeMessageVisibility' });
  }
  // GuardDuty SendObjectMalwareScan (POST /object-malware-scan/send, rest-json).
  sendObjectMalwareScan(bucket, key, versionId) {
    return this.send(`https://guardduty.${this.configuration.region}.amazonaws.com/object-malware-scan/send`, 'guardduty', {
      s3Object: { bucket, key, versionId },
    }, { 'content-type': 'application/json' });
  }
}

// ---------------------------------------------------------------------------
// CloudWatch embedded metric format, one line per invocation. Written straight
// to stdout so the Lambda runtime adds no prefix to the JSON.
export class Metrics {
  constructor(configuration, write = line => process.stdout.write(`${line}\n`), now = Date.now) {
    this.configuration = configuration; this.write = write; this.now = now;
    this.counts = new Map(); this.maxima = new Map();
  }
  count(name, value = 1) { this.counts.set(name, (this.counts.get(name) ?? 0) + value); }
  max(name, value) { this.maxima.set(name, Math.max(this.maxima.get(name) ?? 0, value)); }
  flush() {
    if (this.counts.size === 0 && this.maxima.size === 0) return;
    const metrics = [
      ...[...this.counts.keys()].map(Name => ({ Name, Unit: 'Count' })),
      ...[...this.maxima.keys()].map(Name => ({ Name, Unit: 'Seconds' })),
    ];
    this.write(JSON.stringify({
      _aws: { Timestamp: this.now(), CloudWatchMetrics: [{ Namespace: 'HID/DocumentScanning', Dimensions: [['Environment']], Metrics: metrics }] },
      Environment: this.configuration.deployment,
      ...Object.fromEntries(this.counts), ...Object.fromEntries(this.maxima),
    }));
    this.counts.clear(); this.maxima.clear();
  }
}

const log = (logger, level, message, fields) => logger[level](JSON.stringify({ level, message, ...fields }));

// Resolve refusals (ehr-api scan-errors.ts): what each one means for the
// result in hand. Anything not listed (401, 403, 429, 5xx) is retried.
const RESOLVE_REFUSALS = {
  DOCUMENT_NOT_FOUND: { outcome: 'ack', metric: 'Orphans', level: 'info', message: 'No document holds this object; acknowledged' },
  DOCUMENT_NOT_UPLOADED: { outcome: 'retry', metric: 'Retries', level: 'info', message: 'Upload not completed yet; will retry' },
  DOCUMENT_NOT_SCANNABLE: { outcome: 'ack', metric: 'NotScannable', level: 'info', message: 'Document is no longer awaiting a scan; acknowledged' },
  OBJECT_VERSION_MISMATCH: { outcome: 'ack', metric: 'StaleVersions', level: 'info', message: 'Result is for a version the document is not bound to; acknowledged' },
  SCAN_ALREADY_TERMINAL: { outcome: 'ack', metric: 'Duplicates', level: 'info', message: 'Document already has a terminal scan result; acknowledged' },
};

function resolveRefusal({ status, code }) {
  if (status === 200) return undefined;
  if (status === 404) return RESOLVE_REFUSALS.DOCUMENT_NOT_FOUND;
  if (status === 409 && RESOLVE_REFUSALS[code]) return RESOLVE_REFUSALS[code];
  if (status === 400 || status === 409) {
    return { outcome: 'ack', metric: 'ScanEventRefused', level: 'error', message: 'ehr-api refused the resolve request' };
  }
  return { outcome: 'retry', metric: 'Retries', level: 'warn', message: 'Resolve failed; will retry' };
}

// ---------------------------------------------------------------------------
// One SQS record: validate, resolve, map, write. Returns 'ack' or 'retry'.
export async function processRecord(record, context) {
  const { configuration, ehr, metrics, logger } = context;
  let event;
  try { event = JSON.parse(record.body); } catch { event = undefined; }
  const scan = validateEnvelope(event, configuration);
  if (!scan.ok) {
    metrics.count('EnvelopeRejected');
    log(logger, 'warn', 'Dropped a message that is not a scan result for this bucket', { reason: scan.reason, messageId: record.messageId });
    return 'ack';
  }
  const correlation = correlationId('gdmp', scan.eventId);
  const fields = { correlationId: correlation, key: scan.key, scanStatus: scan.scanStatus, scanResultStatus: scan.scanResultStatus };
  if (scan.threatName) log(logger, 'warn', 'GuardDuty found a threat', { ...fields, threatName: scan.threatName });

  const resolved = await ehr.resolveTarget(scan, correlation);
  const refusal = resolveRefusal(resolved);
  if (refusal) {
    metrics.count(refusal.metric);
    log(logger, refusal.level, refusal.message, { ...fields, status: resolved.status, code: resolved.code });
    return refusal.outcome;
  }
  const target = readResolvedTarget(resolved.body);
  const documentFields = { ...fields, documentId: target.documentId, latestEventType: target.latestEventType, sniffResult: target.sniffResult };
  // ehr-api answers 200 only for this exact, uploaded, unsettled version; the
  // bridge checks again rather than write on a surprise.
  if (target.status !== 'uploaded' || target.objectVersionId !== scan.versionId) {
    metrics.count('NotScannable');
    log(logger, 'warn', 'Resolve answered for another state or version; acknowledged', { ...documentFields, documentStatus: target.status });
    return 'ack';
  }

  const mapped = mapResult(scan, target);
  if (mapped.retry) {
    metrics.count('Retries');
    log(logger, 'warn', 'The media type of a clean result is not known yet; will retry', documentFields);
    return 'retry';
  }
  if (mapped.threatFound) metrics.count('ThreatsFound');
  if (mapped.accessDenied) metrics.count('ScanAccessDenied');
  const scanEvent = {
    documentId: target.documentId,
    objectVersionId: target.objectVersionId,
    objectSha256Hex: target.sha256Hex,
    eventType: mapped.eventType,
    ...(mapped.detectedMediaType ? { detectedMediaType: mapped.detectedMediaType } : {}),
    scannerEngine: mapped.scannerEngine,
    scannerVersion: mapped.scannerVersion,
    ...(mapped.reasonCode ? { reasonCode: mapped.reasonCode } : {}),
    idempotencyKey: idempotencyKey(scan),
  };
  const outcome = { ...documentFields, eventType: scanEvent.eventType, reasonCode: scanEvent.reasonCode,
    detectedMediaType: scanEvent.detectedMediaType, declaredMediaType: target.declaredMediaType };
  if (mapped.declaredMismatch) {
    metrics.count('MediaTypeCorrected');
    log(logger, 'info', 'Accepted under its real media type, not the declared one', outcome);
  }
  if (configuration.mode === 'observe') {
    metrics.count('Observed');
    log(logger, 'info', 'Observe mode: scan event not written', outcome);
    return 'ack';
  }
  return writeOutcome(await ehr.postScanEvent(scanEvent, correlation), outcome, context);
}

function writeOutcome(response, fields, { metrics, logger }) {
  const { status, code } = response;
  if (status === 202 || status === 200) {
    metrics.count('EventsWritten');
    log(logger, 'info', 'Scan event written', { ...fields, eventId: response.body?.eventId });
    return 'ack';
  }
  if (status === 409 && code === 'SCAN_ALREADY_TERMINAL') {
    metrics.count('Duplicates');
    log(logger, 'info', 'Document reached a terminal result first; acknowledged', fields);
    return 'ack';
  }
  if (status === 409 && code === 'DOCUMENT_NOT_UPLOADED') {
    metrics.count('Retries');
    log(logger, 'info', 'Document is not uploaded yet; will retry', fields);
    return 'retry';
  }
  if (status === 409 && code === 'DOCUMENT_NOT_SCANNABLE') {
    metrics.count('NotScannable');
    log(logger, 'info', 'Document is no longer awaiting a scan; acknowledged', fields);
    return 'ack';
  }
  if (status === 409 && code === 'OBJECT_VERSION_MISMATCH') {
    metrics.count('StaleVersions');
    log(logger, 'info', 'Document is bound to another version now; acknowledged', fields);
    return 'ack';
  }
  if (status === 404) {
    // Resolve has just found this document, and documents are never deleted:
    // a 404 here means the append cannot see the row (a database fault, such
    // as a missing row-level security policy), not an orphan. Acknowledged
    // with the refusal alarm; reconcile scans the document again once fixed.
    metrics.count('ScanEventRefused');
    log(logger, 'error', 'ehr-api could not find a document it had just resolved', { ...fields, status, code });
    return 'ack';
  }
  if (status === 401 || status === 403 || status === 429 || status >= 500) {
    metrics.count('Retries');
    log(logger, 'warn', 'ehr-api did not accept the scan event now; will retry', { ...fields, status, code });
    return 'retry';
  }
  // 400, SCAN_IDEMPOTENCY_CONFLICT and any other refusal:
  // retrying the same deterministic event cannot succeed. The document stays
  // blocked (fail closed) and the alarm asks a person to look.
  metrics.count('ScanEventRefused');
  log(logger, 'error', 'ehr-api refused the scan event', { ...fields, status, code });
  return 'ack';
}

export async function handleSqsBatch(event, context) {
  const { configuration, aws, metrics, logger, remainingMs } = context;
  const batchItemFailures = [];
  for (const record of event.Records) {
    let outcome;
    if (record.eventSource !== 'aws:sqs' || record.eventSourceARN !== configuration.queueArn) {
      metrics.count('EnvelopeRejected');
      log(logger, 'warn', 'Dropped a record from an unexpected source', { messageId: record.messageId });
      continue;
    }
    // A record needs at most 7 s per ehr-api call (two), 5 s to delay a retry
    // and 8 s to mint a token. Leave the rest of the batch for its next
    // delivery (queue visibility 180 s) rather than time out mid-write.
    if (remainingMs() < 20_000) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      outcome = await processRecord(record, context);
    } catch (error) {
      metrics.count('Retries');
      log(logger, 'error', 'Scan result could not be processed; will retry', { messageId: record.messageId, error: error.message });
      outcome = 'retry';
    }
    if (outcome !== 'retry') continue;
    batchItemFailures.push({ itemIdentifier: record.messageId });
    const receiveCount = Number.parseInt(record.attributes?.ApproximateReceiveCount ?? '1', 10);
    try {
      await aws.changeVisibility(record.receiptHandle, backoffSeconds(receiveCount));
    } catch (error) {
      // The queue's own 180 s visibility then applies.
      log(logger, 'warn', 'Could not extend the retry delay', { messageId: record.messageId, error: error.message, status: error.status });
    }
  }
  return { batchItemFailures };
}

// ---------------------------------------------------------------------------
// 5. Reconcile and backfill: on-demand scans for uploaded documents that have
// no terminal result for their current version. Each attempt is recorded as
// scan_started first, so a run skips anything started in the last hour and
// gives up after three attempts (with an alarm).
export function reconcileRequest(event) {
  const older = event.olderThanSeconds ?? RECONCILE_DEFAULT_OLDER_THAN_SECONDS;
  const limit = event.limit ?? RECONCILE_MAX_LIMIT;
  if (!Number.isSafeInteger(older) || older < 0 || older > 2_592_000) throw new Error('olderThanSeconds must be 0 to 2592000');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECONCILE_MAX_LIMIT) throw new Error(`limit must be 1 to ${RECONCILE_MAX_LIMIT}`);
  const keys = Object.keys(event).filter(key => !['action', 'olderThanSeconds', 'limit'].includes(key));
  if (keys.length > 0) throw new Error('Unknown reconcile option');
  return { olderThanSeconds: older, limit };
}

export async function reconcile(event, context) {
  const { configuration, ehr, aws, metrics, logger, now, sleep, remainingMs, requestId } = context;
  const { olderThanSeconds, limit } = reconcileRequest(event);
  const correlation = correlationId('gdrc', requestId);
  const listed = await ehr.listTargets(olderThanSeconds, limit, correlation);
  if (listed.status !== 200) throw new Error(`scan-targets answered ${listed.status}`);
  const items = readTargetList(listed.body);
  const summary = { mode: configuration.mode, listed: items.length, started: 0, inProgress: 0, exhausted: 0, skipped: 0, failed: 0, deferred: 0 };
  let oldest = 0;
  let scansSent = 0;
  for (const item of items) {
    oldest = Math.max(oldest, Math.floor((now() - Date.parse(item.updatedAt)) / 1000));
    if (remainingMs() < 14_000) { summary.deferred += 1; continue; }
    const fields = { correlationId: correlation, documentId: item.documentId, key: item.storageKey, attempts: item.scanStartedCount };
    if (item.storageBucket !== configuration.bucket || !KEY_PATTERN.test(item.storageKey)) {
      summary.skipped += 1;
      log(logger, 'warn', 'Not a clinical/objects/ object of this bucket; skipped', fields);
      continue;
    }
    if (item.scanStartedCount >= RECONCILE_MAX_ATTEMPTS) {
      summary.exhausted += 1;
      log(logger, 'error', 'Three scan attempts gave no result; needs a person', fields);
      continue;
    }
    if (item.lastScanStartedAt && now() - Date.parse(item.lastScanStartedAt) < RECONCILE_RESTART_SECONDS * 1000) {
      summary.inProgress += 1;
      continue;
    }
    if (configuration.mode === 'observe') {
      summary.skipped += 1;
      log(logger, 'info', 'Observe mode: would start an on-demand scan', fields);
      continue;
    }
    const attempt = item.scanStartedCount + 1;
    const started = await ehr.postScanEvent({
      documentId: item.documentId,
      objectVersionId: item.objectVersionId,
      objectSha256Hex: item.sha256Hex,
      eventType: 'scan_started',
      scannerEngine: SCANNER_ENGINE,
      scannerVersion: ON_DEMAND_SCANNER_VERSION,
      idempotencyKey: scanStartedKey(item.objectVersionId, attempt),
    }, correlation);
    if (started.status !== 202 && started.status !== 200) {
      summary.skipped += 1;
      log(logger, started.status >= 500 ? 'warn' : 'info', 'Could not record the scan attempt; skipped', { ...fields, status: started.status, code: started.code });
      continue;
    }
    if (scansSent > 0) await sleep(RECONCILE_SCAN_SPACING_MS);
    try {
      await aws.sendObjectMalwareScan(configuration.bucket, item.storageKey, item.objectVersionId);
      scansSent += 1;
      summary.started += 1;
      log(logger, 'info', 'On-demand scan started', { ...fields, attempt });
    } catch (error) {
      summary.failed += 1;
      if (error.status === 403) metrics.count('ScanAccessDenied');
      log(logger, 'error', 'GuardDuty did not start the scan', { ...fields, attempt, status: error.status, code: error.code });
    }
  }
  metrics.max('OldestPendingScanSeconds', oldest);
  metrics.count('ReconcileStarted', summary.started);
  if (summary.exhausted) metrics.count('ReconcileExhausted', summary.exhausted);
  log(logger, 'info', 'Reconcile finished', summary);
  return summary;
}

export function handlePlanStatus(event, { configuration, metrics, logger }) {
  if (event.account !== configuration.accountId || !Array.isArray(event.resources) || !event.resources.includes(configuration.planArn)) {
    metrics.count('EnvelopeRejected');
    return { ignored: true };
  }
  metrics.count('PlanStatusProblem');
  const detail = event.detail ?? {};
  log(logger, 'error', 'GuardDuty reported a problem with the malware protection plan', {
    detailType: event['detail-type'],
    status: typeof detail.status === 'string' ? detail.status : undefined,
    reason: typeof detail.statusReasons === 'string' ? detail.statusReasons : JSON.stringify(detail.statusReasons ?? detail.reason ?? null).slice(0, 500),
  });
  return { recorded: true };
}

export async function route(event, context) {
  try {
    if (Array.isArray(event?.Records)) return await handleSqsBatch(event, context);
    if (event?.action === 'reconcile') return await reconcile(event, context);
    if (event?.source === 'aws.guardduty' && PLAN_STATUS_DETAIL_TYPES.has(event['detail-type'])) return handlePlanStatus(event, context);
    context.metrics.count('EnvelopeRejected');
    log(context.logger, 'warn', 'Ignored an unrecognised invocation', {});
    return { ignored: true };
  } finally {
    context.metrics.flush();
  }
}
