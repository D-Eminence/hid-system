import type { PoolClient } from 'pg';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { resetEnvironmentForTests } from '../../config/environment';
import type { DatabaseService } from '../../database/database.service';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import { S3StorageProvider } from '../../storage/s3-storage.provider';
import type { ClinicalRepository } from '../shared/clinical.repository';
import { attachPatientEntryDocuments, patientEntryItem } from './patient-entries.query';
import { PatientEntryDocumentsService, leadingBytesMatch, normalizePatientDocument } from './patient-entry-documents.service';

// Photos and files on the records patients add (0117). Synthetic values only.
const actor = { kind: 'patient', patientId: 'patient-id', accountId: 'account-id', subject: 'subject', sessionId: 'session-id' };
const request = { actor, correlationId: 'patient-documents-test', header: () => undefined } as unknown as HidRequest;
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const DOCUMENT_ID = '44444444-4444-4444-8444-444444444444';
const KEY = 'clinical/objects/55555555-5555-4555-8555-555555555555';
const BUCKET = 'hid-staging-documents';
const SHA = 'ab'.repeat(32);
const IDEMPOTENCY_KEY = 'patient-file-key-0001';
const body = { fileName: 'malaria-test.jpg', mediaType: 'image/jpeg', sizeBytes: 2048, sha256Hex: SHA };
const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const intentRow = (outcome: string, overrides: Record<string, unknown> = {}) => ({ outcome, document_id: DOCUMENT_ID,
  document_status: 'initiated', document_scan_status: 'pending', document_storage_bucket: BUCKET, document_storage_key: KEY,
  document_media_type: 'image/jpeg', document_size_bytes: '2048', document_sha256_hex: SHA, retry_after_seconds: null,
  ...overrides });
const stored = (overrides: Record<string, unknown> = {}) => ({ id: DOCUMENT_ID, status: 'initiated', scan_status: 'pending',
  storage_bucket: BUCKET, storage_key: KEY, object_version_id: null, declared_media_type: 'image/jpeg',
  detected_media_type: null, size_bytes: '2048', sha256_hex: SHA, original_file_name: 'malaria-test.jpg', ...overrides });

function setup(answers: Array<{ rows: unknown[] } | Error> = []) {
  const authorization = { ...actor, expiresAt: new Date(Date.now() + 30_000).toISOString() };
  const authorizeSelf = jest.fn().mockResolvedValue(authorization);
  const query = jest.fn();
  for (const answer of answers) {
    if (answer instanceof Error) query.mockRejectedValueOnce(answer); else query.mockResolvedValueOnce(answer);
  }
  const client = { query } as unknown as PoolClient;
  const transaction = jest.fn(async (_auth: unknown, _correlation: string, work: (c: PoolClient) => Promise<unknown>) => work(client));
  const run = jest.fn(async (_context: unknown, _patient: string, _access: string, _event: unknown,
    operation: (c: PoolClient) => Promise<{ value: unknown }>, lookup?: (c: PoolClient) => Promise<boolean>) => {
    if (lookup && !await lookup(client)) throw new DomainProblem(404, 'CLINICAL_RESOURCE_NOT_FOUND', 'Clinical resource was not found');
    return (await operation(client)).value;
  });
  const storage = {
    bucket: jest.fn(() => BUCKET),
    createUpload: jest.fn(async (intent: { key: string }) => ({ method: 'PUT', url: `https://s3.example/${intent.key}?signed=1`,
      expiresInSeconds: 300, requiredHeaders: { 'content-type': 'image/jpeg' } })),
    inspect: jest.fn(async () => ({ versionId: 'version-1', sizeBytes: 2048, mediaType: 'image/jpeg', sha256Hex: SHA })),
    readPrefix: jest.fn(async () => JPEG),
    createDownload: jest.fn(async () => ({ url: 'https://s3.example/download', expiresInSeconds: 60 })),
  };
  const service = new PatientEntryDocumentsService({ withPatientTransaction: transaction } as unknown as DatabaseService,
    { authorizeSelf } as unknown as IdentityApiService, { run } as unknown as ClinicalRepository, storage as never);
  return { service, query, transaction, run, storage, authorizeSelf };
}

async function problem(promise: Promise<unknown>): Promise<DomainProblem> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return error;
    throw error;
  }
  throw new Error('No problem was raised');
}

describe('A file\'s request', () => {
  it('trims the name, lower-cases the SHA-256 and takes the three types from 1 byte to 10 MB', () => {
    expect(normalizePatientDocument({ ...body, fileName: '  scan.pdf ', mediaType: 'application/pdf', sizeBytes: 10_485_760,
      sha256Hex: SHA.toUpperCase() })).toEqual({ fileName: 'scan.pdf', mediaType: 'application/pdf', sizeBytes: 10_485_760,
      sha256Hex: SHA });
    expect(normalizePatientDocument({ ...body, mediaType: 'image/png', sizeBytes: 1 }).sizeBytes).toBe(1);
  });

  it.each([
    ['a type outside the three', { mediaType: 'image/tiff' }, 'mediaType'],
    ['a type with parameters', { mediaType: 'image/jpeg; charset=binary' }, 'mediaType'],
    ['no bytes', { sizeBytes: 0 }, 'sizeBytes'],
    ['one byte over 10 MB', { sizeBytes: 10_485_761 }, 'sizeBytes'],
    ['a fraction', { sizeBytes: 2.5 }, 'sizeBytes'],
    ['a short SHA-256', { sha256Hex: 'ab' }, 'sha256Hex'],
    ['an empty name', { fileName: '   ' }, 'fileName'],
    ['a name over 255 characters', { fileName: 'x'.repeat(256) }, 'fileName'],
    ['a name with a control character', { fileName: 'scan\u0000.jpg' }, 'fileName'],
  ])('refuses %s (400 VALIDATION_FAILED naming the field)', (_name, change, field) => {
    let refused: unknown;
    try { normalizePatientDocument({ ...body, ...change } as never); } catch (error) { refused = error; }
    expect(refused).toBeInstanceOf(DomainProblem);
    expect([(refused as DomainProblem).getStatus(), (refused as DomainProblem).code]).toEqual([400, 'VALIDATION_FAILED']);
    expect((refused as DomainProblem).errors?.map(error => error.field)).toEqual([field]);
  });

  it('reads the leading bytes of each type, and nothing else as one', () => {
    expect(leadingBytesMatch(JPEG, 'image/jpeg')).toBe(true);
    expect(leadingBytesMatch(PNG, 'image/png')).toBe(true);
    expect(leadingBytesMatch(PDF, 'application/pdf')).toBe(true);
    expect(leadingBytesMatch(PDF, 'image/png')).toBe(false);
    expect(leadingBytesMatch(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]), 'image/png')).toBe(false);
    expect(leadingBytesMatch(Uint8Array.from([0x49, 0x49, 0x2a, 0x00]), 'image/jpeg')).toBe(false);
    expect(leadingBytesMatch(Uint8Array.from([0xff, 0xd8]), 'image/jpeg')).toBe(false);
  });
});

describe('Asking for an upload link', () => {
  it('opens the file through the command and answers the staff shape with a 300-second PUT link to its key', async () => {
    const s = setup([{ rows: [intentRow('created')] }]);
    const answer = await s.service.createUploadIntent(request, ENTRY_ID, body, IDEMPOTENCY_KEY);
    expect(answer).toEqual({ document: { id: DOCUMENT_ID, status: 'initiated', scanStatus: 'pending' },
      upload: { method: 'PUT', url: `https://s3.example/${KEY}?signed=1`, expiresInSeconds: 300,
        requiredHeaders: { 'content-type': 'image/jpeg' } } });
    const [sql, values] = s.query.mock.calls[0]!;
    expect(sql).toContain('from ehr.create_my_patient_entry_document_intent($1, $2, $3, $4, $5, $6, $7, $8, $9)');
    expect(values.slice(0, 6)).toEqual([ENTRY_ID, 'malaria-test.jpg', 'image/jpeg', 2048, SHA, IDEMPOTENCY_KEY]);
    expect(values[6]).toBe(requestDigest('ehr.patient-entry.document.upload-intent', { entryId: ENTRY_ID,
      fileName: 'malaria-test.jpg', mediaType: 'image/jpeg', sizeBytes: 2048, sha256Hex: SHA }));
    expect(values[7]).toBe(BUCKET);
    // A new key in the staff format, never a new prefix.
    expect(values[8]).toMatch(/^clinical\/objects\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(s.storage.createUpload).toHaveBeenCalledWith({ key: KEY, mediaType: 'image/jpeg', sizeBytes: 2048,
      sha256Hex: SHA, expiresInSeconds: 300 });
  });

  it('answers a replay before the confirm with 201 again for the same document and a fresh link', async () => {
    const s = setup([{ rows: [intentRow('created')] }, { rows: [intentRow('replayed')] }]);
    const first = await s.service.createUploadIntent(request, ENTRY_ID, body, IDEMPOTENCY_KEY);
    const replay = await s.service.createUploadIntent(request, ENTRY_ID, body, IDEMPOTENCY_KEY);
    expect(replay.document).toEqual(first.document);
    expect(s.storage.createUpload).toHaveBeenCalledTimes(2);
    expect(s.storage.createUpload.mock.calls[1]![0]).toEqual(s.storage.createUpload.mock.calls[0]![0]);
  });

  it('answers a replay after the confirm with 409 PATIENT_DOCUMENT_ALREADY_UPLOADED and the document, and no link', async () => {
    const s = setup([{ rows: [intentRow('already_uploaded', { document_status: 'available', document_scan_status: 'clean' })] }]);
    const refused = await problem(s.service.createUploadIntent(request, ENTRY_ID, body, IDEMPOTENCY_KEY));
    expect([refused.getStatus(), refused.code]).toEqual([409, 'PATIENT_DOCUMENT_ALREADY_UPLOADED']);
    expect(refused.extensions?.members).toEqual({ document: { id: DOCUMENT_ID, status: 'available', scanStatus: 'clean' } });
    expect(s.storage.createUpload).not.toHaveBeenCalled();
  });

  it('answers the day\'s limit with 429 PATIENT_DOCUMENT_DAILY_LIMIT and Retry-After to Lagos midnight, and no link', async () => {
    const s = setup([{ rows: [intentRow('daily_limit', { document_id: null, retry_after_seconds: 3600 })] }]);
    const refused = await problem(s.service.createUploadIntent(request, ENTRY_ID, body, 'patient-file-key-0011'));
    expect([refused.getStatus(), refused.code]).toEqual([429, 'PATIENT_DOCUMENT_DAILY_LIMIT']);
    expect(refused.extensions?.headers).toEqual({ 'Retry-After': '3600' });
    expect(s.storage.createUpload).not.toHaveBeenCalled();
  });

  it.each([
    ['entry_not_found', 404, 'PATIENT_ENTRY_NOT_FOUND'],
    ['entry_full', 409, 'PATIENT_DOCUMENT_ENTRY_LIMIT'],
    ['key_reused', 409, 'IDEMPOTENCY_KEY_REUSED'],
  ])('answers %s as %i %s', async (outcome, status, code) => {
    const s = setup([{ rows: [intentRow(outcome, { document_id: null })] }]);
    const refused = await problem(s.service.createUploadIntent(request, ENTRY_ID, body, IDEMPOTENCY_KEY));
    expect([refused.getStatus(), refused.code]).toEqual([status, code]);
    expect(s.storage.createUpload).not.toHaveBeenCalled();
  });

  it('requires an Idempotency-Key and checks the file before Identity or the database', async () => {
    const s = setup();
    expect((await problem(s.service.createUploadIntent(request, ENTRY_ID, body, undefined))).code)
      .toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await problem(s.service.createUploadIntent(request, ENTRY_ID, { ...body, mediaType: 'text/html' },
      IDEMPOTENCY_KEY))).code).toBe('VALIDATION_FAILED');
    expect(s.authorizeSelf).not.toHaveBeenCalled();
    expect(s.query).not.toHaveBeenCalled();
  });

  it('maps the database\'s refusals: another patient\'s context 403, invalid values 400', async () => {
    const s = setup([Object.assign(new Error('Patient self context is required'), { code: '42501' }),
      Object.assign(new Error('PATIENT_DOCUMENT_INVALID'), { code: '22023' })]);
    expect((await problem(s.service.createUploadIntent(request, ENTRY_ID, body, IDEMPOTENCY_KEY))).code)
      .toBe('PATIENT_ACCESS_DENIED');
    expect((await problem(s.service.createUploadIntent(request, ENTRY_ID, body, IDEMPOTENCY_KEY))).code)
      .toBe('PATIENT_DOCUMENT_INVALID');
  });

  it('requires a patient session', async () => {
    const s = setup();
    const staff = { ...request, actor: { kind: 'staff', accountId: 'a', subject: 's' } } as unknown as HidRequest;
    expect((await problem(s.service.createUploadIntent(staff, ENTRY_ID, body, IDEMPOTENCY_KEY))).code)
      .toBe('PATIENT_SESSION_REQUIRED');
  });
});

describe('The presigned PUT, exactly as staff document uploads', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('signs the size, checksum, declared SHA-256 and KMS headers the browser sends, for the clinical key', async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://synthetic:test@localhost/hid', CORS_ORIGINS: 'https://app.example',
      STORAGE_MODE: 's3', S3_BUCKET: BUCKET, S3_REGION: 'eu-west-1', S3_KMS_KEY_ID: 'kms-key',
      S3_ACCESS_KEY_ID: 'synthetic-test-access-key-id', S3_SECRET_ACCESS_KEY: 'synthetic-secret-never-a-real-credential',
    });
    resetEnvironmentForTests();
    const s = setup([{ rows: [intentRow('created', { document_media_type: 'application/pdf' })] }]);
    const storage = new S3StorageProvider();
    (s.service as unknown as { storage: S3StorageProvider }).storage = storage;
    const answer = await s.service.createUploadIntent(request, ENTRY_ID, { ...body, mediaType: 'application/pdf' },
      IDEMPOTENCY_KEY);
    const url = new URL(answer.upload.url);
    expect(url.pathname).toContain(KEY);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    // The size and the checksum are signed, so S3 refuses any other bytes; the content type is not (the confirm reads
    // the object's leading bytes instead, never its Content-Type).
    expect((url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';')).toEqual(expect.arrayContaining(['content-length',
      'x-amz-checksum-sha256', 'x-amz-meta-declared-sha256', 'x-amz-server-side-encryption',
      'x-amz-server-side-encryption-aws-kms-key-id']));
    expect(answer.upload).toMatchObject({ method: 'PUT', expiresInSeconds: 300, requiredHeaders: {
      'content-type': 'application/pdf', 'x-amz-checksum-sha256': Buffer.from(SHA, 'hex').toString('base64'),
      'x-amz-meta-declared-sha256': SHA, 'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': 'kms-key' } });
  });
});

describe('Confirming a file', () => {
  const completed = { rows: [{ outcome: 'uploaded', document_id: DOCUMENT_ID, document_status: 'uploaded',
    document_scan_status: 'pending' }] };

  it('reads the stored object (HEAD, then its first 8 bytes of that version) and confirms with its version', async () => {
    const s = setup([{ rows: [stored()] }, completed]);
    await expect(s.service.complete(request, ENTRY_ID, DOCUMENT_ID)).resolves.toEqual({
      document: { id: DOCUMENT_ID, status: 'uploaded', scanStatus: 'pending' } });
    expect(s.query.mock.calls[0]![1]).toEqual([DOCUMENT_ID, ENTRY_ID, 'patient-id', 'account-id']);
    expect(s.query.mock.calls[0]![0]).toContain('created_by_account_id = $4');
    expect(s.storage.inspect).toHaveBeenCalledWith(KEY);
    expect(s.storage.readPrefix).toHaveBeenCalledWith(KEY, 'version-1', 8);
    expect(s.query.mock.calls[1]![0]).toContain('from ehr.complete_my_patient_entry_document($1, $2, $3, $4, $5)');
    expect(s.query.mock.calls[1]![1]).toEqual([ENTRY_ID, DOCUMENT_ID, 'version-1', 2048, SHA]);
  });

  it.each([
    ['a missing object', (s: ReturnType<typeof setup>) => s.storage.inspect.mockRejectedValueOnce(
      Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }))],
    // Production: ehr-api has no s3:ListBucket there, so S3 answers HEAD on a missing key with 403.
    ['a missing object read without s3:ListBucket (403 Forbidden)', (s: ReturnType<typeof setup>) =>
      s.storage.inspect.mockRejectedValueOnce(
        Object.assign(new Error('UnknownError'), { name: 'Forbidden', $metadata: { httpStatusCode: 403 } }))],
    ['a missing object read without s3:ListBucket (AccessDenied)', (s: ReturnType<typeof setup>) =>
      s.storage.inspect.mockRejectedValueOnce(Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }))],
    ['another size', (s: ReturnType<typeof setup>) => s.storage.inspect.mockResolvedValueOnce(
      { versionId: 'version-1', sizeBytes: 2047, mediaType: 'image/jpeg', sha256Hex: SHA })],
    ['another SHA-256', (s: ReturnType<typeof setup>) => s.storage.inspect.mockResolvedValueOnce(
      { versionId: 'version-1', sizeBytes: 2048, mediaType: 'image/jpeg', sha256Hex: 'cd'.repeat(32) })],
  ])('answers %s with 409 PATIENT_DOCUMENT_UPLOAD_INCOMPLETE and confirms nothing', async (_name, arrange) => {
    const s = setup([{ rows: [stored()] }]);
    arrange(s);
    const refused = await problem(s.service.complete(request, ENTRY_ID, DOCUMENT_ID));
    expect([refused.getStatus(), refused.code]).toEqual([409, 'PATIENT_DOCUMENT_UPLOAD_INCOMPLETE']);
    expect(s.query).toHaveBeenCalledTimes(1);
  });

  it('lets any other storage failure through, confirming nothing', async () => {
    const s = setup([{ rows: [stored()] }]);
    const failure = Object.assign(new Error('SlowDown'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } });
    s.storage.inspect.mockRejectedValueOnce(failure);
    await expect(s.service.complete(request, ENTRY_ID, DOCUMENT_ID)).rejects.toBe(failure);
    expect(s.query).toHaveBeenCalledTimes(1);
  });

  it('answers leading bytes that are not the declared type\'s with 409 PATIENT_DOCUMENT_TYPE_MISMATCH, whatever the HEAD says', async () => {
    const s = setup([{ rows: [stored()] }]);
    s.storage.readPrefix.mockResolvedValueOnce(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]));
    const refused = await problem(s.service.complete(request, ENTRY_ID, DOCUMENT_ID));
    expect([refused.getStatus(), refused.code]).toEqual([409, 'PATIENT_DOCUMENT_TYPE_MISMATCH']);
    expect(s.query).toHaveBeenCalledTimes(1);
  });

  it('answers a confirmed file as it is now, without reading the object again', async () => {
    const s = setup([{ rows: [stored({ status: 'available', scan_status: 'clean', object_version_id: 'version-1' })] }]);
    await expect(s.service.complete(request, ENTRY_ID, DOCUMENT_ID)).resolves.toEqual({
      document: { id: DOCUMENT_ID, status: 'available', scanStatus: 'clean' } });
    expect(s.storage.inspect).not.toHaveBeenCalled();
  });

  it('answers a file that is not this uploader\'s, another record\'s or a removed record\'s with 404 PATIENT_DOCUMENT_NOT_FOUND', async () => {
    const s = setup([{ rows: [] }, { rows: [stored()] }, { rows: [{ outcome: 'not_found', document_id: DOCUMENT_ID,
      document_status: null, document_scan_status: null }] }]);
    expect((await problem(s.service.complete(request, ENTRY_ID, DOCUMENT_ID))).code).toBe('PATIENT_DOCUMENT_NOT_FOUND');
    expect(s.storage.inspect).not.toHaveBeenCalled();
    // Removed between the read and the confirm.
    expect((await problem(s.service.complete(request, ENTRY_ID, DOCUMENT_ID))).code).toBe('PATIENT_DOCUMENT_NOT_FOUND');
  });

  it('answers the command\'s own size or SHA-256 refusal as incomplete', async () => {
    const s = setup([{ rows: [stored()] }, { rows: [{ outcome: 'mismatch', document_id: DOCUMENT_ID,
      document_status: 'initiated', document_scan_status: 'pending' }] }]);
    expect((await problem(s.service.complete(request, ENTRY_ID, DOCUMENT_ID))).code)
      .toBe('PATIENT_DOCUMENT_UPLOAD_INCOMPLETE');
  });
});

describe('A clinician opens a file', () => {
  const context = { purposeOfUse: 'direct-care', facilityId: 'facility' } as DataAccessContext;
  const clean = stored({ status: 'available', scan_status: 'clean', object_version_id: 'version-1',
    detected_media_type: 'image/jpeg', original_file_name: 'Malaria test.png' });

  it('only with the patient\'s access, audited as ehr.document.download, a 60-second link to that version', async () => {
    const s = setup([{ rows: [clean] }, { rows: [clean] }]);
    await expect(s.service.staffDownload('patient-id', ENTRY_ID, DOCUMENT_ID, context)).resolves.toEqual({
      url: 'https://s3.example/download', expiresInSeconds: 60 });
    expect(s.run.mock.calls[0]!.slice(0, 4)).toEqual([context, 'patient-id', 'read_records', {
      action: 'ehr.document.download', resourceType: 'patient-entry-document', resourceId: DOCUMENT_ID,
      details: { entryId: ENTRY_ID } }]);
    expect(s.storage.createDownload).toHaveBeenCalledWith(KEY, 'version-1', { fileName: 'Malaria_test.jpg',
      mediaType: 'image/jpeg', disposition: 'inline' });
  });

  it('refuses a file not scanned clean (409) and one the clinician cannot see (404)', async () => {
    const pending = stored({ status: 'uploaded', object_version_id: 'version-1' });
    const s = setup([{ rows: [pending] }, { rows: [pending] }, { rows: [] }]);
    expect((await problem(s.service.staffDownload('patient-id', ENTRY_ID, DOCUMENT_ID, context))).code)
      .toBe('PATIENT_DOCUMENT_NOT_AVAILABLE');
    expect((await problem(s.service.staffDownload('patient-id', ENTRY_ID, DOCUMENT_ID, context))).code)
      .toBe('CLINICAL_RESOURCE_NOT_FOUND');
    expect(s.storage.createDownload).not.toHaveBeenCalled();
  });
});

describe('The records answer\'s documents', () => {
  const entry = patientEntryItem({ id: ENTRY_ID, kind: 'test', title: 'Malaria test', facility_name: null,
    occurred_on: '2026-10-20', notes: null, created_at: '2026-11-04T09:00:00Z' });

  it('lists each record\'s confirmed files, oldest first, with the scanner\'s state as the website reads it', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [
      { id: 'd1', entry_id: ENTRY_ID, original_file_name: 'a.jpg', media_type: 'image/jpeg', size_bytes: '2048',
        status: 'available', scan_status: 'clean', created_at: '2026-11-04T09:01:00Z' },
      { id: 'd2', entry_id: ENTRY_ID, original_file_name: 'b.pdf', media_type: 'application/pdf', size_bytes: '10',
        status: 'uploaded', scan_status: 'scan_started', created_at: '2026-11-04T09:02:00Z' },
      { id: 'd3', entry_id: ENTRY_ID, original_file_name: 'c.png', media_type: 'image/png', size_bytes: '99',
        status: 'rejected', scan_status: 'rejected', created_at: '2026-11-04T09:03:00Z' },
    ] });
    const [item] = await attachPatientEntryDocuments({ query }, 'patient-id', [entry]);
    expect(item!.documents).toEqual([
      { id: 'd1', fileName: 'a.jpg', mediaType: 'image/jpeg', sizeBytes: 2048, status: 'available', scanStatus: 'clean',
        createdAt: '2026-11-04T09:01:00.000Z' },
      { id: 'd2', fileName: 'b.pdf', mediaType: 'application/pdf', sizeBytes: 10, status: 'uploaded', scanStatus: 'pending',
        createdAt: '2026-11-04T09:02:00.000Z' },
      { id: 'd3', fileName: 'c.png', mediaType: 'image/png', sizeBytes: 99, status: 'rejected', scanStatus: 'rejected',
        createdAt: '2026-11-04T09:03:00.000Z' },
    ]);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('from ehr.patient_entry_documents_effective');
    expect(sql).toContain("status in ('uploaded', 'available', 'rejected')");
    expect(values).toEqual(['patient-id', [ENTRY_ID]]);
  });

  it('asks nothing for an empty page', async () => {
    const query = jest.fn();
    await expect(attachPatientEntryDocuments({ query }, 'patient-id', [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
