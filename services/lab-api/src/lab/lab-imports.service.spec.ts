import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { LabImportsService } from './lab-imports.service';

const context = {
  correlationId: 'lab-import-correlation', facilityId: '10000000-0000-4000-8000-000000000001',
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care',
  actor: { id: 'actor', subject: 'staff:doctor', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['doctor'], permissions: ['lab.import.write'], facilityIds: [], facilities: [], authenticationMethod: 'local' },
} satisfies DataAccessContext;

const command = {
  patientId: '50000000-0000-4000-8000-000000000001',
  sourceDocumentId: '60000000-0000-4000-8000-000000000001',
  ocrJobId: '70000000-0000-4000-8000-000000000001',
  extractionId: '80000000-0000-4000-8000-000000000001',
  validationId: '90000000-0000-4000-8000-000000000001', validationVersion: 3,
  publicationId: 'a0000000-0000-4000-8000-000000000001',
  reviewedBy: '20000000-0000-4000-8000-000000000002',
  externalLabName: 'External Reference Laboratory',
  observations: [{ testName: 'Haemoglobin', value: '12.5', unit: 'g/dL' }],
};

describe('LabImportsService', () => {
  it('atomically creates imported evidence, immutable observations, provenance, audit, and outbox', async () => {
    const queries: string[] = [];
    const row = { id: 'b0000000-0000-4000-8000-000000000001', patient_id: command.patientId,
      facility_id: context.facilityId, source_type: 'IMPORTED_EXTERNAL', status: 'accepted',
      external_lab_name: command.externalLabName, external_reference: null, collected_at: null,
      reported_at: null, received_at: new Date(), source_document_id: command.sourceDocumentId,
      ocr_job_id: command.ocrJobId, extraction_id: command.extractionId, validation_id: command.validationId,
      validation_version: 3, publication_id: command.publicationId, row_version: '1', created_at: new Date() };
    const client = { query: jest.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('from lab.imported_evidence where')) return { rows: [], rowCount: 0 };
      if (sql.includes('insert into lab.imported_evidence')) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }) } as unknown as PoolClient;
    const database = { withTransaction: async <T>(_context: DataAccessContext,
      operation: (db: PoolClient) => Promise<T>) => operation(client) } as unknown as DatabaseService;
    const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) } as unknown as IdentityService;
    const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const service = new LabImportsService(database, identity, audit);

    const result = await service.createFromOcr(context, command);

    expect(result).toMatchObject({ id: row.id, status: 'accepted', version: 1 });
    expect(queries.some((sql) => sql.includes('insert into lab.imported_evidence'))).toBe(true);
    expect(queries.some((sql) => sql.includes('insert into lab.imported_observations'))).toBe(true);
    expect(queries.some((sql) => sql.includes('insert into lab.outbox_events'))).toBe(true);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    expect(identity.authorize).toHaveBeenCalledWith(command.patientId, 'write_records', 'direct-care', context);
  });

  it('denies mutations when canonical patient authorization is absent or break-glass-only', async () => {
    const database = { withTransaction: jest.fn() } as unknown as DatabaseService;
    const audit = { recordWithClient: jest.fn() } as unknown as AuditService;
    for (const decision of [{ allowed: false, breakGlass: false }, { allowed: true, breakGlass: true }]) {
      const identity = { authorize: jest.fn().mockResolvedValue(decision) } as unknown as IdentityService;
      const service = new LabImportsService(database, identity, audit);
      await expect(service.createFromOcr(context, command))
        .rejects.toMatchObject({ code: 'LAB_IMPORT_ACCESS_DENIED' });
    }
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('replays the same OCR publication and rejects a mismatched idempotent request', async () => {
    const row = { id: 'b0000000-0000-4000-8000-000000000001', patient_id: command.patientId,
      facility_id: context.facilityId, source_type: 'IMPORTED_EXTERNAL', status: 'accepted',
      external_lab_name: command.externalLabName, external_reference: null, collected_at: null,
      reported_at: null, received_at: new Date(), source_document_id: command.sourceDocumentId,
      ocr_job_id: command.ocrJobId, extraction_id: command.extractionId, validation_id: command.validationId,
      validation_version: 3, publication_id: command.publicationId, row_version: '1', created_at: new Date() };
    const digest = requestDigest('lab.imported-evidence.create', {
      facilityId: context.facilityId, patientId: command.patientId, sourceDocumentId: command.sourceDocumentId,
      externalLabName: command.externalLabName, externalReference: null, collectedAt: null, reportedAt: null,
      observations: command.observations, publicationId: command.publicationId,
      validationId: command.validationId, validationVersion: command.validationVersion,
    });
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ ...row, request_sha256: digest }], rowCount: 1 }) } as unknown as PoolClient;
    const database = { withTransaction: async <T>(_context: DataAccessContext,
      operation: (db: PoolClient) => Promise<T>) => operation(client) } as unknown as DatabaseService;
    const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) } as unknown as IdentityService;
    const service = new LabImportsService(database, identity, { recordWithClient: jest.fn() } as unknown as AuditService);
    await expect(service.createFromOcr(context, command)).resolves.toMatchObject({ id: row.id });
    client.query = jest.fn().mockResolvedValue({ rows: [{ ...row, request_sha256: 'f'.repeat(64) }], rowCount: 1 });
    await expect(service.createFromOcr(context, command)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});
