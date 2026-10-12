import { Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { ProblemDetailsFilter } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
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

/**
 * OCR stores a Lab 5xx from POST /lab/imports/from-ocr as the retryable
 * OWNING_SERVICE_UNAVAILABLE and a Lab 4xx as a terminal refusal of the
 * reviewed publication (ocr-api, ocr.service.ts). Lab maps no database refusal
 * of an import: only EHR-order acceptance maps its own
 * (D-Eminence/hid-system#56). Each reaches the problem filter unchanged and
 * answers 500, as before.
 */
describe('LabImportsService database refusals', () => {
  const answer = (exception: unknown, route: string) => {
    const request = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ', method: 'POST', route: { path: route } } as unknown as HidRequest;
    const response = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis() } as unknown as Response;
    const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as unknown as ArgumentsHost;
    new ProblemDetailsFilter().catch(exception, host);
    return (response.json as jest.Mock).mock.calls[0]?.[0] as { status: number; code: string; detail: string };
  };
  const serviceRefusing = (refusal: Error) => {
    const client = { query: jest.fn(async (sql: string) => {
      if (sql.includes('from lab.imported_evidence where')) return { rows: [], rowCount: 0 };
      if (sql.includes('insert into lab.imported_evidence')) throw refusal;
      return { rows: [], rowCount: 1 };
    }) } as unknown as PoolClient;
    const database = { withTransaction: async <T>(_context: DataAccessContext,
      operation: (db: PoolClient) => Promise<T>) => operation(client) } as unknown as DatabaseService;
    const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) } as unknown as IdentityService;
    return new LabImportsService(database, identity, { recordWithClient: jest.fn() } as unknown as AuditService);
  };
  const refusals = [
    // lab.validate_imported_evidence (0077).
    ['23514', 'Lab import is not bound to exact governed OCR publication evidence'],
    // unique(publication_id) left after DatabaseService's one retry, for example an import hidden by row-level security.
    ['23505', 'duplicate key value violates unique constraint "imported_evidence_publication_id_key"'],
    // Row-level security refuses the insert.
    ['42501', 'new row violates row-level security policy for table "imported_evidence"'],
  ] as const;

  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it.each(refusals)('passes refusal %s of an OCR import on unchanged, and it answers 500 INTERNAL_ERROR', async (code, message) => {
    const refusal = Object.assign(new Error(message), { code });
    const error = await serviceRefusing(refusal).createFromOcr(context, command).catch((caught: unknown) => caught);
    expect(error).toBe(refusal);
    const problem = answer(error, '/lab/imports/from-ocr');
    expect(problem).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', detail: 'The service could not complete the request.' });
    expect(JSON.stringify(problem)).not.toContain(message);
  });

  it.each(refusals)('passes refusal %s of an external import on unchanged, and it answers 500 INTERNAL_ERROR', async (code, message) => {
    const refusal = Object.assign(new Error(message), { code });
    const { patientId, sourceDocumentId, externalLabName, observations } = command;
    const error = await serviceRefusing(refusal).createExternal(context,
      { patientId, sourceDocumentId, externalLabName, observations, reason: 'Synthetic external report', purpose: 'direct-care' },
      'external-import-key-0000000001').catch((caught: unknown) => caught);
    expect(error).toBe(refusal);
    expect(answer(error, '/lab/imports')).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });
});
