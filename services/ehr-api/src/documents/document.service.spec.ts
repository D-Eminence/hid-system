import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DataAccessContext } from '../common/request-context';
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
    await expect(service.complete(documentId, uploader)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.complete(documentId, contextFor(uploaderAccountId, uploaderMembershipId, otherFacilityId)))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(storage.inspect).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
    expect(stored.status).toBe('initiated');
  });

  it('refuses completion with 409 while uploads are disabled, before Identity, storage or any write (0091)', async () => {
    const { service, stored, identity, storage, updates, completionAudits, disableControl, issued } = harness();
    disableControl('uploads_enabled');
    const refusal = service.complete(documentId, uploader);
    await expect(refusal).rejects.toBeInstanceOf(ConflictException);
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
    await expect(service.complete(documentId, uploader)).rejects.toBeInstanceOf(ConflictException);
    expect(updates()).toHaveLength(0);
    expect(stored.status).toBe('initiated');
  });
});
