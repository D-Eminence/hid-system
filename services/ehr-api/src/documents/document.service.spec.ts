import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DataAccessContext } from '../common/request-context';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import { DocumentService } from './document.service';

const documentId = '123e4567-e89b-42d3-a456-426614174010';
const patientId = '123e4567-e89b-42d3-a456-426614174011';
const facilityId = '123e4567-e89b-42d3-a456-426614174012';
const otherFacilityId = '123e4567-e89b-42d3-a456-426614174013';
const uploaderAccountId = '123e4567-e89b-42d3-a456-426614174014';
const uploaderMembershipId = '123e4567-e89b-42d3-a456-426614174015';
const colleagueAccountId = '123e4567-e89b-42d3-a456-426614174016';
const colleagueMembershipId = '123e4567-e89b-42d3-a456-426614174017';
const sha256Hex = 'a'.repeat(64);
const objectVersionId = 'synthetic-object-version-1';

const contextFor = (accountId: string, membershipId: string, facility = facilityId) => ({
  correlationId: 'correlation-123456', facilityId: facility, membershipId,
  purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: { id: accountId,
    subject: `staff:${accountId}`, accountId, authenticationMethod: 'local', roles: ['doctor'],
    permissions: ['ehr.document.write'], facilityIds: [facility], facilities: [],
    facility: { id: facility, membershipId, organizationId: facility, name: 'Test',
      roles: ['doctor'], permissions: ['ehr.document.write'], isPrimary: true } } }) as DataAccessContext;

const uploader = contextFor(uploaderAccountId, uploaderMembershipId);
const colleague = contextFor(colleagueAccountId, colleagueMembershipId);

interface StoredDocument {
  id: string;
  patient_id: string;
  facility_id: string;
  created_by: string;
  storage_bucket: string;
  storage_key: string;
  object_version_id: string | null;
  declared_media_type: string;
  size_bytes: string;
  sha256_hex: string;
  status: string;
  row_version: number;
}

interface IssuedQuery { sql: string; params: unknown[]; readOnly: boolean }

/**
 * A stand-in for ehr.documents behind the EHR runtime: the read returns
 * created_by only when the statement selects it, and the completing UPDATE
 * applies exactly the predicate the statement carries.
 */
function harness() {
  const stored: StoredDocument = {
    id: documentId, patient_id: patientId, facility_id: facilityId, created_by: uploaderAccountId,
    storage_bucket: 'synthetic-bucket', storage_key: 'clinical/objects/synthetic', object_version_id: null,
    declared_media_type: 'application/pdf', size_bytes: '1024', sha256_hex: sha256Hex, status: 'initiated',
    row_version: 1,
  };
  const issued: IssuedQuery[] = [];
  // Simulates a creator read inside the completing transaction that differs from the
  // first read, so the replay branch's own check is exercised on its own.
  let creatorInWriteTransaction: string | undefined;

  const rowFor = (sql: string, readOnly: boolean) => ({
    id: stored.id, patient_id: stored.patient_id, facility_id: stored.facility_id,
    storage_bucket: stored.storage_bucket, storage_key: stored.storage_key,
    object_version_id: stored.object_version_id, declared_media_type: stored.declared_media_type,
    detected_media_type: null, size_bytes: stored.size_bytes, sha256_hex: stored.sha256_hex,
    scan_status: null, status: stored.status, row_version: String(stored.row_version),
    ...(/\bcreated_by\b/.test(sql)
      ? { created_by: !readOnly && creatorInWriteTransaction ? creatorInWriteTransaction : stored.created_by }
      : {}),
  });

  const clientFor = (readOnly: boolean) => ({
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params, readOnly });
      if (/^\s*select set_config/.test(sql)) return { rows: [], rowCount: 1 };
      if (/from ehr\.documents_effective/.test(sql)) {
        const [id, facility] = params;
        return id === stored.id && facility === stored.facility_id
          ? { rows: [rowFor(sql, readOnly)], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/^\s*update ehr\.documents\b/.test(sql)) {
        const [id, facility, versionId, sizeBytes, sha] = params as [string, string, string, number, string];
        const bindsCreator = /\bcreated_by = \$6\b/.test(sql);
        const matches = id === stored.id && facility === stored.facility_id && stored.status === 'initiated'
          && (!bindsCreator || params[5] === stored.created_by);
        if (!matches) return { rows: [], rowCount: 0 };
        Object.assign(stored, {
          object_version_id: versionId, size_bytes: String(sizeBytes), sha256_hex: sha,
          status: 'uploaded', row_version: stored.row_version + 1,
        });
        return { rows: [rowFor(sql, readOnly)], rowCount: 1 };
      }
      throw new Error(`Unexpected statement in DocumentService spec: ${sql}`);
    }),
  });

  const database = {
    withTransaction: jest.fn(async (_context: DataAccessContext, operation: (client: unknown) => Promise<unknown>,
      options: { readOnly?: boolean } = {}) => operation(clientFor(options.readOnly === true))),
  };
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true }) };
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined), record: jest.fn().mockResolvedValue(undefined) };
  const storage = {
    inspect: jest.fn().mockResolvedValue({
      versionId: objectVersionId, sizeBytes: 1024, mediaType: 'application/pdf', sha256Hex,
    }),
  };
  const service = new DocumentService(database as never, identity as never, audit as never, storage as never);
  const updates = () => issued.filter((query) => /^\s*update ehr\.documents\b/.test(query.sql));
  const completionAudits = () => audit.recordWithClient.mock.calls
    .filter(([, event]) => (event as { action?: string }).action === 'ehr.document.upload.complete');
  return {
    service, stored, issued, identity, audit, storage, updates, completionAudits,
    readCreatorInWriteTransactionAs: (accountId: string) => { creatorInWriteTransaction = accountId; },
  };
}

const uploadedView = {
  id: documentId, patientId, facilityId, mediaType: 'application/pdf', sizeBytes: 1024,
  scanStatus: 'pending', status: 'uploaded', version: 2,
};

describe('DocumentService.complete: only the uploader completes an upload', () => {
  it('lets the uploader complete their own upload with the unchanged view and one success audit', async () => {
    const { service, stored, identity, storage, completionAudits } = harness();
    await expect(service.complete(documentId, uploader)).resolves.toStrictEqual(uploadedView);
    expect(identity.authorize).toHaveBeenCalledWith(patientId, 'write_records', 'direct-care', uploader);
    expect(storage.inspect).toHaveBeenCalledWith('clinical/objects/synthetic');
    expect(stored).toMatchObject({ status: 'uploaded', object_version_id: objectVersionId, row_version: 2 });
    expect(completionAudits()).toHaveLength(1);
    expect(completionAudits()[0]?.[1]).toMatchObject({
      outcome: 'success', actorAccountId: uploaderAccountId, actorMembershipId: uploaderMembershipId,
      patientId, resourceId: documentId,
    });
  });

  it('refuses a colleague at the same facility with 404 before Identity, storage or any write', async () => {
    const { service, stored, identity, storage, updates, completionAudits } = harness();
    const refusal = service.complete(documentId, colleague);
    await expect(refusal).rejects.toBeInstanceOf(NotFoundException);
    await expect(refusal).rejects.toThrow('Document not found');
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(storage.inspect).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
    expect(completionAudits()).toHaveLength(0);
    expect(stored).toMatchObject({ status: 'initiated', object_version_id: null, row_version: 1 });
  });

  it('refuses a colleague with 404, not the idempotent 200, after the uploader completed', async () => {
    const { service, identity, storage, completionAudits } = harness();
    await service.complete(documentId, uploader);
    identity.authorize.mockClear();
    storage.inspect.mockClear();
    await expect(service.complete(documentId, colleague)).rejects.toBeInstanceOf(NotFoundException);
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(storage.inspect).not.toHaveBeenCalled();
    expect(completionAudits()).toHaveLength(1);
  });

  it('re-checks the creator read in the completing transaction before the idempotent reply', async () => {
    const { service, readCreatorInWriteTransactionAs } = harness();
    await service.complete(documentId, uploader);
    readCreatorInWriteTransactionAs(colleagueAccountId);
    await expect(service.complete(documentId, uploader)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('binds the completing UPDATE to the caller as creator, facility and initiated status', async () => {
    const { service, updates } = harness();
    await service.complete(documentId, uploader);
    expect(updates()).toHaveLength(1);
    const [update] = updates();
    expect(update?.sql).toMatch(/where id = \$1 and facility_id = \$2 and status = 'initiated' and created_by = \$6\b/);
    expect(update?.params).toEqual([documentId, facilityId, objectVersionId, 1024, sha256Hex, uploaderAccountId]);
  });

  it('answers the uploader\'s own repeat with the same view and no second success audit', async () => {
    const { service, completionAudits } = harness();
    await service.complete(documentId, uploader);
    await expect(service.complete(documentId, uploader)).resolves.toStrictEqual(uploadedView);
    expect(completionAudits()).toHaveLength(1);
  });

  it('keeps refusing the uploader without a write grant (403) and at another facility (404)', async () => {
    const { service, stored, identity, storage, updates } = harness();
    identity.authorize.mockResolvedValueOnce({ allowed: false });
    await expect(service.complete(documentId, uploader)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.complete(documentId, contextFor(uploaderAccountId, uploaderMembershipId, otherFacilityId)))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(storage.inspect).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
    expect(stored.status).toBe('initiated');
  });

  it('keeps refusing the uploader with 409 when the stored object does not match the declaration', async () => {
    const { service, stored, storage, updates } = harness();
    storage.inspect.mockResolvedValueOnce({
      versionId: objectVersionId, sizeBytes: 2048, mediaType: 'application/pdf', sha256Hex,
    });
    await expect(service.complete(documentId, uploader)).rejects.toBeInstanceOf(ConflictException);
    expect(updates()).toHaveLength(0);
    expect(stored.status).toBe('initiated');
  });
});

// Offline contract A8.6: a device that lost the first answer replays the same
// complete. The replay is answered 2xx from the row, with no write, no second
// audit event and no new storage read, after the same uploader, facility and
// write-grant checks as the first call.
describe('DocumentService.complete: a replayed complete', () => {
  it('answers the first complete and its replay with the same body, writing and auditing once', async () => {
    const { service, storage, updates, completionAudits } = harness();
    const first = await service.complete(documentId, uploader);
    storage.inspect.mockClear();
    const replay = await service.complete(documentId, uploader);
    expect(replay).toStrictEqual(first);
    expect(replay).toStrictEqual(uploadedView);
    expect(storage.inspect).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(1);
    expect(completionAudits()).toHaveLength(1);
  });

  it.each(['available', 'rejected'])('answers 2xx with the current view once the scanner made it %s', async (status) => {
    const { service, stored, updates, completionAudits } = harness();
    await service.complete(documentId, uploader);
    stored.status = status;
    await expect(service.complete(documentId, uploader)).resolves.toStrictEqual({ ...uploadedView, status });
    expect(updates()).toHaveLength(1);
    expect(completionAudits()).toHaveLength(1);
  });

  it('still refuses another account (404) and another facility (404) after the upload completed', async () => {
    const { service, identity, completionAudits } = harness();
    await service.complete(documentId, uploader);
    identity.authorize.mockClear();
    await expect(service.complete(documentId, colleague)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.complete(documentId, contextFor(uploaderAccountId, uploaderMembershipId, otherFacilityId)))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(completionAudits()).toHaveLength(1);
  });

  it('still refuses the uploader without a write grant (403) on a replay', async () => {
    const { service, identity } = harness();
    await service.complete(documentId, uploader);
    identity.authorize.mockResolvedValueOnce({ allowed: false });
    await expect(service.complete(documentId, uploader)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 409 INVALID_DOCUMENT_TRANSITION for a document entered in error, not a replayed success', async () => {
    const { service, stored } = harness();
    await service.complete(documentId, uploader);
    stored.status = 'entered_in_error';
    await expect(service.complete(documentId, uploader)).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_TRANSITION', status: 409 });
  });
});

// The document scanner (0105): resolve, the work list and scan-events, through
// the isolated workload pool, and what downstream serves after a clean scan
// under the detected type (owner decision D3).
describe('DocumentService: the document scanner', () => {
  const scanner = { subject: 'hid:staging:document-scanner', accountId: 'd0c5ca40-0105-4000-8000-000000000001' };
  const bucket = 'hid-staging-documents-a1b2c3';
  const storageKey = 'clinical/objects/0c9e8a7b-6d5c-4b3a-9f8e-7d6c5b4a3f2e';
  const target = { storageBucket: bucket, storageKey, objectVersionId };

  function scannerHarness(rows: Record<string, unknown>[] = []) {
    const events: string[] = [];
    const client = { query: jest.fn(async (sql: string, params: unknown[]) => {
      events.push(`query ${sql.includes('resolve_document_scan_target') ? 'resolve'
        : sql.includes('list_documents_awaiting_scan') ? 'list' : 'append'}`);
      void params;
      return { rows, rowCount: rows.length };
    }) };
    const database = {
      withWorkloadTransaction: jest.fn(async (_subject: string, _correlation: string,
        operation: (value: typeof client) => Promise<unknown>) => {
        events.push('begin');
        try { return await operation(client); } finally { events.push('end'); }
      }),
    };
    const storage = {
      bucket: jest.fn(() => bucket),
      readPrefix: jest.fn(async () => { events.push('readPrefix'); return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]); }),
    };
    const service = new DocumentService(database as never, {} as never, {} as never, storage as never);
    return { service, client, database, storage, events };
  }
  const resolvedRow = {
    document_id: documentId, object_version_id: objectVersionId, sha256_hex: sha256Hex, status: 'uploaded',
    declared_media_type: 'application/pdf', latest_event_type: null,
  };

  it('resolves through the scanner pool, then reads 1 KB of the bound version outside the transaction', async () => {
    const { service, client, database, storage, events } = scannerHarness([resolvedRow]);
    await expect(service.resolveScanTarget(target, scanner, 'gdmp-correlation-0001')).resolves.toStrictEqual({
      documentId, objectVersionId, sha256Hex, status: 'uploaded', declaredMediaType: 'application/pdf',
      latestEventType: null, sniffResult: 'supported', sniffedMediaType: 'image/jpeg',
    });
    expect(database.withWorkloadTransaction).toHaveBeenCalledWith(scanner.subject, 'gdmp-correlation-0001',
      expect.any(Function));
    expect(client.query.mock.calls[0]?.[1]).toEqual([bucket, storageKey, objectVersionId, 'gdmp-correlation-0001']);
    expect(client.query.mock.calls[0]?.[0]).toMatch(/from ehr\.resolve_document_scan_target\(\$1, \$2, \$3, \$4\)/);
    expect(storage.readPrefix).toHaveBeenCalledWith(storageKey, objectVersionId, 1024);
    expect(events).toEqual(['begin', 'query resolve', 'end', 'readPrefix']);
  });

  it('says unsupported when the bytes are none of the four types, and unavailable when they cannot be read', async () => {
    const first = scannerHarness([resolvedRow]);
    first.storage.readPrefix.mockResolvedValueOnce(Uint8Array.from(Buffer.from('<html>')));
    await expect(first.service.resolveScanTarget(target, scanner, 'gdmp-correlation-0001')).resolves
      .toMatchObject({ sniffResult: 'unsupported', sniffedMediaType: null });
    const second = scannerHarness([resolvedRow]);
    second.storage.readPrefix.mockRejectedValueOnce(Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }));
    await expect(second.service.resolveScanTarget(target, scanner, 'gdmp-correlation-0001')).resolves
      .toMatchObject({ sniffResult: 'unavailable', sniffedMediaType: null, documentId });
  });

  it('answers 404 for another bucket without a database call or a read', async () => {
    const { service, database, storage } = scannerHarness([resolvedRow]);
    await expect(service.resolveScanTarget({ ...target, storageBucket: 'someone-elses-bucket' }, scanner,
      'gdmp-correlation-0001')).rejects.toMatchObject({ status: 404, code: 'DOCUMENT_NOT_FOUND' });
    expect(database.withWorkloadTransaction).not.toHaveBeenCalled();
    expect(storage.readPrefix).not.toHaveBeenCalled();
  });

  it.each([
    ['P0002', 'Document not found', 404, 'DOCUMENT_NOT_FOUND'],
    ['55000', 'Only an uploaded document can be scanned', 409, 'DOCUMENT_NOT_UPLOADED'],
    ['55000', 'Document is no longer awaiting a scan', 409, 'DOCUMENT_NOT_SCANNABLE'],
    ['55000', 'Scan result does not match the current immutable document object', 409, 'OBJECT_VERSION_MISMATCH'],
    ['55000', 'Document object scan has already reached a terminal result', 409, 'SCAN_ALREADY_TERMINAL'],
    ['42501', 'Authorized document scanner context is required', 403, 'DOCUMENT_SCANNER_FORBIDDEN'],
    ['22023', 'Invalid document scan target', 400, 'INVALID_SCAN_REQUEST'],
  ])('answers a resolve refused with %s "%s" as %i %s, and reads nothing', async (sqlstate, message, status, code) => {
    const { service, client, storage } = scannerHarness([resolvedRow]);
    client.query.mockRejectedValueOnce(Object.assign(new Error(message), { code: sqlstate }));
    await expect(service.resolveScanTarget(target, scanner, 'gdmp-correlation-0001')).rejects
      .toMatchObject({ status, code });
    expect(storage.readPrefix).not.toHaveBeenCalled();
  });

  it.each([
    ['23505', 'Scanner idempotency key payload mismatch', 409, 'SCAN_IDEMPOTENCY_CONFLICT'],
    ['55000', 'Document object scan has already reached a terminal result', 409, 'SCAN_ALREADY_TERMINAL'],
    ['55000', 'Only an uploaded document can be scanned', 409, 'DOCUMENT_NOT_UPLOADED'],
    ['55000', 'Scan result does not match the current immutable document object', 409, 'OBJECT_VERSION_MISMATCH'],
    ['P0002', 'Document not found', 404, 'DOCUMENT_NOT_FOUND'],
    ['42501', 'Authorized document scanner context is required', 403, 'DOCUMENT_SCANNER_FORBIDDEN'],
    ['22023', 'A supported detected media type is required for a clean scan', 400, 'INVALID_SCAN_REQUEST'],
  ])('answers a scan event refused with %s "%s" as %i %s instead of 500', async (sqlstate, message, status, code) => {
    const { service, client } = scannerHarness();
    client.query.mockRejectedValueOnce(Object.assign(new Error(message), { code: sqlstate }));
    await expect(service.recordScan({
      documentId, objectVersionId, objectSha256Hex: sha256Hex, eventType: 'clean', detectedMediaType: 'image/jpeg',
      scannerEngine: 'aws-guardduty-malware-protection-s3', scannerVersion: '1.0',
      idempotencyKey: 'gdmp-0123456789abcdef0123456789abcdef0123456789abcdef',
    }, scanner, 'gdmp-correlation-0001')).rejects.toMatchObject({ status, code });
  });

  it('keeps any other database failure a 500 (the original error)', async () => {
    const { service, client } = scannerHarness();
    const failure = Object.assign(new Error('terminating connection'), { code: '57P01' });
    client.query.mockRejectedValueOnce(failure);
    await expect(service.recordScan({
      documentId, objectVersionId, objectSha256Hex: sha256Hex, eventType: 'scan_started',
      scannerEngine: 'aws-guardduty-malware-protection-s3', scannerVersion: '1.0',
      idempotencyKey: 'gdod-0123456789abcdef0123456789abcdef0123456789abcdef-1',
    }, scanner, 'gdmp-correlation-0001')).rejects.toBe(failure);
  });

  it('records a scan event with the bridge\'s values and answers its event ID', async () => {
    const { service, client } = scannerHarness([{ event_id: 'event-1' }]);
    await expect(service.recordScan({
      documentId, objectVersionId, objectSha256Hex: sha256Hex, eventType: 'clean', detectedMediaType: 'image/jpeg',
      scannerEngine: 'aws-guardduty-malware-protection-s3', scannerVersion: '1.0',
      idempotencyKey: 'gdmp-0123456789abcdef0123456789abcdef0123456789abcdef',
    }, scanner, 'gdmp-correlation-0001')).resolves.toEqual({ eventId: 'event-1' });
    expect(client.query.mock.calls[0]?.[1]).toEqual([documentId, objectVersionId, sha256Hex, 'clean', 'image/jpeg',
      'aws-guardduty-malware-protection-s3', '1.0', null, 'gdmp-0123456789abcdef0123456789abcdef0123456789abcdef',
      'gdmp-correlation-0001']);
  });

  it('lists the work list with ISO times and no patient or facility field', async () => {
    const { service, client } = scannerHarness([{
      document_id: documentId, storage_bucket: bucket, storage_key: storageKey, object_version_id: objectVersionId,
      sha256_hex: sha256Hex, declared_media_type: 'image/png', updated_at: new Date('2026-10-31T09:00:00Z'),
      latest_event_type: 'scan_started', scan_started_count: 1, last_scan_started_at: new Date('2026-10-31T10:00:00Z'),
    }]);
    const answer = await service.listScanTargets({ olderThanSeconds: 900, limit: 50 }, scanner, 'gdmp-correlation-0002');
    expect(answer).toStrictEqual({ items: [{
      documentId, storageBucket: bucket, storageKey, objectVersionId, sha256Hex, declaredMediaType: 'image/png',
      updatedAt: '2026-10-31T09:00:00.000Z', latestEventType: 'scan_started', scanStartedCount: 1,
      lastScanStartedAt: '2026-10-31T10:00:00.000Z',
    }] });
    expect(client.query.mock.calls[0]?.[1]).toEqual([900, 50, 'gdmp-correlation-0002']);
    expect(JSON.stringify(answer)).not.toMatch(/patient|facility/i);
  });
});

describe('DocumentService: downstream uses the detected media type (owner decision D3)', () => {
  // A JPEG uploaded as image/png, scanned clean with detectedMediaType image/jpeg.
  function cleanHarness(overrides: Record<string, unknown> = {}) {
    const row = {
      id: documentId, patient_id: patientId, facility_id: facilityId, created_by: uploaderAccountId,
      storage_bucket: 'synthetic-bucket', storage_key: 'clinical/objects/synthetic', object_version_id: objectVersionId,
      declared_media_type: 'image/png', detected_media_type: 'image/jpeg', original_file_name: 'Ward scan.png',
      size_bytes: '1024', sha256_hex: sha256Hex, scan_status: 'clean', status: 'available', row_version: '3',
      ...overrides,
    };
    const issued: string[] = [];
    const client = { query: jest.fn(async (sql: string) => {
      issued.push(sql);
      return /from ehr\.documents_effective/.test(sql) ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }) };
    const database = { withTransaction: jest.fn(async (_c: unknown, operation: (value: typeof client) => unknown) =>
      operation(client)) };
    const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true }) };
    const audit = { record: jest.fn().mockResolvedValue(undefined), recordWithClient: jest.fn().mockResolvedValue(undefined) };
    const storage = { createDownload: jest.fn().mockResolvedValue({ url: 'https://s3.example/signed', expiresInSeconds: 60 }) };
    const service = new DocumentService(database as never, identity as never, audit as never, storage as never);
    return { service, storage, issued, identity, audit };
  }

  it('signs the download as the detected type, inline, under a name with its extension', async () => {
    const { service, storage } = cleanHarness();
    await service.createDownload(documentId, uploader);
    expect(storage.createDownload).toHaveBeenCalledWith('clinical/objects/synthetic', objectVersionId, {
      fileName: 'Ward_scan.jpg', mediaType: 'image/jpeg', disposition: 'inline',
    });
  });

  it('refuses a download without a supported detected type', async () => {
    const { service, storage } = cleanHarness({ detected_media_type: null });
    await expect(service.createDownload(documentId, uploader)).rejects.toBeInstanceOf(ConflictException);
    expect(storage.createDownload).not.toHaveBeenCalled();
  });

  it('gives OCR the detected type, never the declared one', async () => {
    const { service } = cleanHarness();
    await expect(service.getOcrSource(documentId, uploader)).resolves.toMatchObject({ mediaType: 'image/jpeg' });
    const pending = cleanHarness({ detected_media_type: null, scan_status: null, status: 'uploaded' });
    await expect(pending.service.getOcrSource(documentId, uploader)).resolves
      .toMatchObject({ mediaType: null, scanStatus: 'pending' });
  });

  it('lists from ehr.documents_effective, the detected type first', async () => {
    const { service, issued } = cleanHarness();
    await service.list(patientId, '123e4567-e89b-42d3-a456-426614174099', uploader);
    const listSql = issued.find(sql => /"fileName"/.test(sql)) ?? '';
    expect(listSql).toMatch(/from ehr\.documents_effective document/);
    expect(listSql).toMatch(/coalesce\(document\.detected_media_type, document\.declared_media_type\) as "mediaType"/);
    expect(listSql).not.toMatch(/document_scan_events/);
  });
});

describe('DocumentService: a source the OCR worker deleted after 7 days (migration 0112)', () => {
  function deletedHarness(status = 'source_deleted') {
    const row = {
      id: documentId, patient_id: patientId, facility_id: facilityId, created_by: uploaderAccountId,
      storage_bucket: 'synthetic-bucket', storage_key: 'clinical/objects/synthetic', object_version_id: objectVersionId,
      declared_media_type: 'application/pdf', detected_media_type: 'application/pdf',
      original_file_name: 'Source page deleted after 7 days', size_bytes: '1024', sha256_hex: sha256Hex,
      scan_status: 'clean', status, row_version: '4',
    };
    const client = { query: jest.fn(async (sql: string) =>
      /from ehr\.documents_effective/.test(sql) ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }) };
    const database = { withTransaction: jest.fn(async (_c: unknown, operation: (value: typeof client) => unknown) =>
      operation(client)) };
    const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true }) };
    const audit = { record: jest.fn().mockResolvedValue(undefined), recordWithClient: jest.fn().mockResolvedValue(undefined) };
    const storage = { createDownload: jest.fn(), inspect: jest.fn() };
    const service = new DocumentService(database as never, identity as never, audit as never, storage as never);
    return { service, storage, identity, audit };
  }

  it('answers a download 410 DOCUMENT_SOURCE_DELETED "Source page deleted after 7 days", signing nothing', async () => {
    const { service, storage, audit } = deletedHarness();
    const refusal = await service.createDownload(documentId, uploader).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DomainProblem);
    expect((refusal as DomainProblem).getStatus()).toBe(410);
    expect((refusal as DomainProblem).code).toBe('DOCUMENT_SOURCE_DELETED');
    expect((refusal as DomainProblem).message).toBe('Source page deleted after 7 days');
    expect(storage.createDownload).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers 410 too while the OCR worker is deleting it (source_deleting)', async () => {
    const { service, storage } = deletedHarness('source_deleting');
    await expect(service.createDownload(documentId, uploader)).rejects.toMatchObject({ code: 'DOCUMENT_SOURCE_DELETED' });
    expect(storage.createDownload).not.toHaveBeenCalled();
  });

  it('checks read access first: a caller without it gets the 403, not the 410', async () => {
    const { service, identity, storage } = deletedHarness();
    identity.authorize.mockResolvedValue({ allowed: false });
    await expect(service.createDownload(documentId, uploader)).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.createDownload).not.toHaveBeenCalled();
  });

  it('is rendered as an RFC 7807 problem with status 410 and the code', () => {
    const response = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const host = { switchToHttp: () => ({
      getRequest: () => ({ correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ', method: 'POST',
        route: { path: '/ehr/documents/:documentId/download' } }),
      getResponse: () => response }) };
    new ProblemDetailsFilter().catch(new DomainProblem(410, 'DOCUMENT_SOURCE_DELETED', 'Source page deleted after 7 days'),
      host as never);
    expect(response.status).toHaveBeenCalledWith(410);
    expect(response.json.mock.calls[0]?.[0]).toMatchObject({ status: 410, title: 'GONE', code: 'DOCUMENT_SOURCE_DELETED',
      detail: 'Source page deleted after 7 days' });
  });

  it('still gives the OCR API the source metadata (it authorizes the job read by its patient) with status source_deleted', async () => {
    const { service } = deletedHarness();
    await expect(service.getOcrSource(documentId, uploader)).resolves.toMatchObject({ id: documentId,
      patientId, status: 'source_deleted' });
  });

  it('cannot be completed again', async () => {
    const { service, storage } = deletedHarness();
    await expect(service.complete(documentId, uploader)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_TRANSITION' });
    expect(storage.inspect).not.toHaveBeenCalled();
  });
});
