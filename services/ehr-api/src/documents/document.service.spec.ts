import { HttpException, NotFoundException } from '@nestjs/common';
import type { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DocumentService } from './document.service';
import type { CreateDocumentUploadDto } from './dto/create-document-upload.dto';

const documentId = '123e4567-e89b-42d3-a456-426614174010';
const patientId = '123e4567-e89b-42d3-a456-426614174011';
const facilityId = '123e4567-e89b-42d3-a456-426614174012';
const otherFacilityId = '123e4567-e89b-42d3-a456-426614174013';
const uploaderAccountId = '123e4567-e89b-42d3-a456-426614174014';
const uploaderMembershipId = '123e4567-e89b-42d3-a456-426614174015';
const colleagueAccountId = '123e4567-e89b-42d3-a456-426614174016';
const colleagueMembershipId = '123e4567-e89b-42d3-a456-426614174017';
const encounterId = '123e4567-e89b-42d3-a456-426614174018';
const pendingDocumentId = '123e4567-e89b-42d3-a456-426614174019';
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

const uploadKey = 'synthetic-upload-intent-0001';
const uploadInput = (overrides: Partial<CreateDocumentUploadDto> = {}) => ({
  patientId, fileName: 'synthetic-referral.pdf', mediaType: 'application/pdf', sizeBytes: 1024, sha256Hex,
  classification: 'phi', retentionClass: 'clinical-10y', ...overrides,
}) as CreateDocumentUploadDto;

/** How a call is refused: [status, code] for an HTTP refusal (no code on a plain Nest exception). */
async function refusalOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error instanceof HttpException ? [error.getStatus(), (error as Partial<DomainProblem>).code] : error;
  }
  return 'accepted';
}

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

interface IdempotencyClaim { request_sha256: string; state: string; result_resource_id: string | null }

/**
 * A stand-in for ehr.documents behind the EHR runtime: the read returns
 * created_by only when the statement selects it, and the completing UPDATE
 * applies exactly the predicate the statement carries. An upload intent's
 * insert replaces the stored document, and its Idempotency-Key claim is kept
 * per key with the request hash it was taken for.
 */
function harness() {
  const stored: StoredDocument = {
    id: documentId, patient_id: patientId, facility_id: facilityId, created_by: uploaderAccountId,
    storage_bucket: 'synthetic-bucket', storage_key: 'clinical/objects/synthetic', object_version_id: null,
    declared_media_type: 'application/pdf', size_bytes: '1024', sha256_hex: sha256Hex, status: 'initiated',
    row_version: 1,
  };
  const issued: IssuedQuery[] = [];
  const idempotencyKeys = new Map<string, IdempotencyClaim>();
  // Rows the list statement returns, as pg returns them.
  const listed: Record<string, unknown>[] = [];
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
      if (/^\s*insert into ehr\.idempotency_keys\b/.test(sql)) {
        const [, , , , key, requestHash] = params as string[];
        if (key === undefined || requestHash === undefined || idempotencyKeys.has(key)) return { rows: [], rowCount: 0 };
        idempotencyKeys.set(key, { request_sha256: requestHash, state: 'processing', result_resource_id: null });
        return { rows: [{ id: `claim-${key}` }], rowCount: 1 };
      }
      if (/from ehr\.idempotency_keys\b/.test(sql)) {
        const claim = idempotencyKeys.get(params[2] as string);
        return claim ? { rows: [{ ...claim }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/^\s*update ehr\.idempotency_keys\b/.test(sql)) {
        const [, , key, requestHash, resourceId] = params as string[];
        const claim = key === undefined ? undefined : idempotencyKeys.get(key);
        if (!claim || claim.request_sha256 !== requestHash) return { rows: [], rowCount: 0 };
        Object.assign(claim, { state: 'completed', result_resource_id: resourceId });
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*insert into ehr\.documents\b/.test(sql)) {
        const [id, , patient, facility, createdBy, , , bucket, key, mediaType, sizeBytes, sha] = params as string[];
        Object.assign(stored, {
          id, patient_id: patient, facility_id: facility, created_by: createdBy, storage_bucket: bucket,
          storage_key: key, object_version_id: null, declared_media_type: mediaType, size_bytes: String(sizeBytes),
          sha256_hex: sha, status: 'initiated', row_version: 1,
        });
        return { rows: [rowFor(sql, readOnly)], rowCount: 1 };
      }
      if (/from ehr\.documents document\b/.test(sql)) {
        return { rows: listed.map((row) => ({ ...row })), rowCount: listed.length };
      }
      throw new Error(`Unexpected statement in DocumentService spec: ${sql}`);
    }),
  });

  // platform.require_control_enabled: the uploads control is on unless a test turns it off.
  const controls = { uploads_enabled: true } as Record<string, boolean>;
  const database = {
    withTransaction: jest.fn(async (_context: DataAccessContext, operation: (client: unknown) => Promise<unknown>,
      options: { readOnly?: boolean } = {}) => operation(clientFor(options.readOnly === true))),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params, readOnly: false });
      if (/platform\.require_control_enabled\(\$1\)/.test(sql)) {
        const key = String(params[0]);
        if (controls[key] === false) {
          throw Object.assign(new Error(`PLATFORM_CONTROL_DISABLED:${key}`), { code: '55000' });
        }
        return { rows: [{}], rowCount: 1 };
      }
      throw new Error(`Unexpected statement in DocumentService spec: ${sql}`);
    }),
  };
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true }) };
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined), record: jest.fn().mockResolvedValue(undefined) };
  const storage = {
    bucket: jest.fn(() => 'synthetic-bucket'),
    inspect: jest.fn().mockResolvedValue({
      versionId: objectVersionId, sizeBytes: 1024, mediaType: 'application/pdf', sha256Hex,
    }),
    createUpload: jest.fn().mockResolvedValue({
      method: 'PUT', url: 'https://storage.invalid/upload', expiresInSeconds: 300, requiredHeaders: {},
    }),
    createDownload: jest.fn().mockResolvedValue({ url: 'https://storage.invalid/download', expiresInSeconds: 60 }),
  };
  const service = new DocumentService(database as never, identity as never, audit as never, storage as never);
  const updates = () => issued.filter((query) => /^\s*update ehr\.documents\b/.test(query.sql));
  const documentInserts = () => issued.filter((query) => /^\s*insert into ehr\.documents\b/.test(query.sql));
  const completionAudits = () => audit.recordWithClient.mock.calls
    .filter(([, event]) => (event as { action?: string }).action === 'ehr.document.upload.complete');
  return {
    service, stored, issued, database, identity, audit, storage, updates, documentInserts, completionAudits,
    idempotencyKeys, listed,
    readCreatorInWriteTransactionAs: (accountId: string) => { creatorInWriteTransaction = accountId; },
    disableControl: (key: string) => { controls[key] = false; },
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
    expect(await refusalOf(service.complete(documentId, uploader))).toEqual([403, 'CONSENT_REQUIRED']);
    await expect(service.complete(documentId, contextFor(uploaderAccountId, uploaderMembershipId, otherFacilityId)))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(storage.inspect).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
    expect(stored.status).toBe('initiated');
  });

  // 0091 answered this 409 CONFLICT; it is the upload intent's 423 UPLOADS_DISABLED (ADR-059).
  it('refuses completion with 423 UPLOADS_DISABLED while uploads are disabled, before Identity, storage or any write (0091)', async () => {
    const { service, stored, identity, storage, updates, completionAudits, disableControl, issued } = harness();
    disableControl('uploads_enabled');
    const refusal = service.complete(documentId, uploader);
    expect(await refusalOf(refusal)).toEqual([423, 'UPLOADS_DISABLED']);
    await expect(refusal).rejects.toThrow('Document uploads are temporarily disabled');
    expect(issued.some((query) => /platform\.require_control_enabled/.test(query.sql)
      && query.params[0] === 'uploads_enabled')).toBe(true);
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(storage.inspect).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
    expect(completionAudits()).toHaveLength(0);
    expect(stored).toMatchObject({ status: 'initiated', object_version_id: null, row_version: 1 });
  });

  it('keeps refusing the uploader with 409 when the stored object does not match the declaration', async () => {
    const { service, stored, storage, updates } = harness();
    storage.inspect.mockResolvedValueOnce({
      versionId: objectVersionId, sizeBytes: 2048, mediaType: 'application/pdf', sha256Hex,
    });
    expect(await refusalOf(service.complete(documentId, uploader))).toEqual([409, 'DOCUMENT_INTEGRITY_MISMATCH']);
    expect(updates()).toHaveLength(0);
    expect(stored.status).toBe('initiated');
  });
});

describe('DocumentService.complete: refusals name what failed', () => {
  it.each([
    ['sha256', { sha256Hex: 'b'.repeat(64) }],
    ['media type', { mediaType: 'image/png' }],
  ])('refuses the uploader with 409 DOCUMENT_INTEGRITY_MISMATCH when the object\'s %s differs', async (_field, differs) => {
    const { service, stored, storage, updates, completionAudits } = harness();
    storage.inspect.mockResolvedValueOnce({
      versionId: objectVersionId, sizeBytes: 1024, mediaType: 'application/pdf', sha256Hex, ...differs,
    });
    const refused = service.complete(documentId, uploader);
    expect(await refusalOf(refused)).toEqual([409, 'DOCUMENT_INTEGRITY_MISMATCH']);
    await expect(refused).rejects.toThrow('Uploaded object does not match the declared content metadata');
    expect(updates()).toHaveLength(0);
    expect(completionAudits()).toHaveLength(0);
    expect(stored.status).toBe('initiated');
  });

  it.each(['available', 'rejected'])(
    'refuses the uploader\'s repeat with 409 DOCUMENT_NOT_COMPLETABLE once the document is %s', async (status) => {
      const { service, stored, completionAudits } = harness();
      await service.complete(documentId, uploader);
      stored.status = status;
      const refused = service.complete(documentId, uploader);
      expect(await refusalOf(refused)).toEqual([409, 'DOCUMENT_NOT_COMPLETABLE']);
      await expect(refused).rejects.toThrow('Document is not in an upload-completable state');
      expect(completionAudits()).toHaveLength(1);
    },
  );
});

describe('DocumentService.createUploadIntent: refusals before anything is written', () => {
  it.each(['', 'short-key'])(
    'refuses the Idempotency-Key %j with 400 IDEMPOTENCY_KEY_REQUIRED before the uploads control, Identity or a transaction',
    async (key) => {
      const { service, database, identity } = harness();
      const refused = service.createUploadIntent(uploadInput(), key, uploader);
      expect(await refusalOf(refused)).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
      await expect(refused).rejects.toThrow('Idempotency-Key must contain 16 to 128 URL-safe characters');
      expect(database.query).not.toHaveBeenCalled();
      expect(identity.authorize).not.toHaveBeenCalled();
      expect(database.withTransaction).not.toHaveBeenCalled();
    },
  );

  it('answers 423 UPLOADS_DISABLED while uploads_enabled is off, before Identity or a transaction', async () => {
    const { service, database, identity, storage, disableControl } = harness();
    disableControl('uploads_enabled');
    const refused = service.createUploadIntent(uploadInput(), uploadKey, uploader);
    expect(await refusalOf(refused)).toEqual([423, 'UPLOADS_DISABLED']);
    await expect(refused).rejects.toThrow('Document uploads are temporarily disabled');
    expect(database.query).toHaveBeenCalledWith('select platform.require_control_enabled($1)', ['uploads_enabled']);
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(storage.createUpload).not.toHaveBeenCalled();
  });

  it('rethrows an unreadable uploads control unchanged, so it stays a 500 with the generic detail', async () => {
    const { service, database, identity } = harness();
    const unavailable = Object.assign(new Error('PLATFORM_CONTROL_UNAVAILABLE'), { code: '55000' });
    database.query.mockRejectedValueOnce(unavailable);
    await expect(service.createUploadIntent(uploadInput(), uploadKey, uploader)).rejects.toBe(unavailable);
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(database.withTransaction).not.toHaveBeenCalled();
  });
});

describe('DocumentService.createUploadIntent: a repeated Idempotency-Key', () => {
  it('answers a completed repeat of the same request with the same document and no second insert', async () => {
    const { service, documentInserts } = harness();
    const first = await service.createUploadIntent(uploadInput(), uploadKey, uploader);
    const repeat = await service.createUploadIntent(uploadInput(), uploadKey, uploader);
    expect(repeat.document).toStrictEqual(first.document);
    expect(documentInserts()).toHaveLength(1);
  });

  it('refuses the key with a different request with 409 IDEMPOTENCY_KEY_REUSED and no insert', async () => {
    const { service, documentInserts } = harness();
    await service.createUploadIntent(uploadInput(), uploadKey, uploader);
    const refused = service.createUploadIntent(uploadInput({ fileName: 'synthetic-discharge.pdf' }), uploadKey, uploader);
    expect(await refusalOf(refused)).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    expect(documentInserts()).toHaveLength(1);
  });

  it('refuses a repeat of a request that has not completed with 409 REQUEST_IN_PROGRESS', async () => {
    const { service, idempotencyKeys, documentInserts } = harness();
    await service.createUploadIntent(uploadInput(), uploadKey, uploader);
    const claim = idempotencyKeys.get(uploadKey);
    if (!claim) throw new Error('the first request took no Idempotency-Key claim');
    // The claim as a first attempt still holding it leaves it: same request, no result yet.
    Object.assign(claim, { state: 'processing', result_resource_id: null });
    const refused = service.createUploadIntent(uploadInput(), uploadKey, uploader);
    expect(await refusalOf(refused)).toEqual([409, 'REQUEST_IN_PROGRESS']);
    expect(documentInserts()).toHaveLength(1);
  });
});

describe('DocumentService: Identity\'s refusal is 403 CONSENT_REQUIRED, as on the clinical routes', () => {
  const writeRefused = 'Patient write access is not authorized';
  const readRefused = 'Patient read access is not authorized';
  const calls: ReadonlyArray<readonly [string, (service: DocumentService) => Promise<unknown>, string]> = [
    ['createUploadIntent', (service) => service.createUploadIntent(uploadInput(), uploadKey, uploader), writeRefused],
    ['list', (service) => service.list(patientId, encounterId, uploader), readRefused],
    ['complete', (service) => service.complete(documentId, uploader), writeRefused],
    ['createDownload', (service) => service.createDownload(documentId, uploader), readRefused],
    ['getOcrSource', (service) => service.getOcrSource(documentId, uploader), readRefused],
  ];

  it.each(calls)('%s keeps its detail and runs nothing further', async (_name, call, detail) => {
    const { service, stored, issued, identity, audit, storage } = harness();
    identity.authorize.mockResolvedValueOnce({ allowed: false });
    const refused = call(service);
    expect(await refusalOf(refused)).toEqual([403, 'CONSENT_REQUIRED']);
    await expect(refused).rejects.toThrow(detail);
    expect(identity.authorize).toHaveBeenCalledTimes(1);
    expect(storage.inspect).not.toHaveBeenCalled();
    expect(storage.createUpload).not.toHaveBeenCalled();
    expect(storage.createDownload).not.toHaveBeenCalled();
    // The uploads control read (database.query, outside any transaction) is a read, not a write.
    expect(issued.filter((query) => !query.readOnly && !/platform\.require_control_enabled/.test(query.sql))).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
    expect(stored.status).toBe('initiated');
  });
});

describe('DocumentService.createDownload', () => {
  it('refuses a document not yet available and clean with 409 DOCUMENT_NOT_AVAILABLE and issues no download', async () => {
    const { service, stored, audit, storage } = harness();
    Object.assign(stored, { status: 'uploaded', object_version_id: objectVersionId });
    const refused = service.createDownload(documentId, uploader);
    expect(await refusalOf(refused)).toEqual([409, 'DOCUMENT_NOT_AVAILABLE']);
    await expect(refused).rejects.toThrow('Document is not available for download');
    expect(storage.createDownload).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('DocumentService.list', () => {
  it('returns sizeBytes and version as integers, as the upload and completion views do', async () => {
    const { service, listed, audit } = harness();
    const createdAt = new Date('2026-10-12T09:00:00.000Z');
    const available = { id: documentId, patientId, encounterId, fileName: 'synthetic-referral.pdf',
      mediaType: 'application/pdf', status: 'available', scanStatus: 'clean', createdAt };
    const pending = { id: pendingDocumentId, patientId, encounterId, fileName: 'synthetic-scan.png',
      mediaType: 'image/png', status: 'initiated', scanStatus: 'pending', createdAt };
    // As pg returns the statement's ::text casts.
    listed.push({ ...available, sizeBytes: '1024', version: '2' }, { ...pending, sizeBytes: null, version: '1' });
    await expect(service.list(patientId, encounterId, uploader)).resolves.toStrictEqual({ items: [
      { ...available, sizeBytes: 1024, version: 2 },
      { ...pending, sizeBytes: null, version: 1 },
    ] });
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ehr.document.list', outcome: 'success', patientId, resourceId: encounterId,
    }));
  });
});
