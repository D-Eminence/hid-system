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
 * (fix/ehr-lab-handoff-resend). Each reaches the problem filter unchanged and
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

/**
 * GET lab/imports?patientId=…: one patient's imported evidence for the chart,
 * on the same read_records decision and audit pattern as GET :importId.
 */
describe('LabImportsService.listForPatient', () => {
  const patientId = command.patientId;
  const otherPatientId = '50000000-0000-4000-8000-000000000002';
  const evidence = (n: number, patient = patientId, facility = context.facilityId) => ({
    id: `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`, patient_id: patient, facility_id: facility,
    source_type: 'IMPORTED_EXTERNAL', status: 'accepted', external_lab_name: 'Synthetic Reference Lab',
    external_reference: null, collected_at: new Date('2026-10-01T08:00:00Z'), reported_at: new Date('2026-10-02T08:00:00Z'),
    received_at: new Date(Date.UTC(2026, 9, 10, 0, 0, 0) - n * 60_000), source_document_id: command.sourceDocumentId,
    ocr_job_id: command.ocrJobId, extraction_id: command.extractionId, validation_id: command.validationId,
    validation_version: 3, publication_id: command.publicationId, row_version: '1', created_at: new Date() });

  /** A stand-in database that applies the WHERE clauses the service sends: patient, facility, cursor and limit. */
  const harness = (stored: ReturnType<typeof evidence>[], decision = { allowed: true, breakGlass: false }) => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const client = { query: jest.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('from lab.imported_evidence e')) {
        const [patient, facility, cursor, limit] = params as [string, string, string | null, number];
        const visible = stored.filter((row) => row.patient_id === patient && row.facility_id === facility)
          .sort((a, b) => b.received_at.getTime() - a.received_at.getTime() || b.id.localeCompare(a.id));
        const at = cursor ? visible.findIndex((row) => row.id === cursor) : -1;
        if (cursor && at < 0) return { rows: [], rowCount: 0 };
        const rows = visible.slice(at + 1, at + 1 + limit);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('from lab.imported_observations')) {
        const [ids] = params as [string[]];
        const rows = ids.map((id) => ({ importId: id, id: `c-${id}`, ordinal: 1, testName: 'Haemoglobin', value: '12.5' }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }) } as unknown as PoolClient;
    const database = { withTransaction: jest.fn(async <T>(_context: DataAccessContext,
      operation: (db: PoolClient) => Promise<T>) => operation(client)) } as unknown as DatabaseService;
    const identity = { authorize: jest.fn().mockResolvedValue(decision) } as unknown as IdentityService;
    const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    return { service: new LabImportsService(database, identity, audit), queries, database, identity, audit };
  };

  it('returns the patient\'s evidence newest first with observations, provenance ids and one ids-only audit row', async () => {
    const { service, identity, audit, queries } = harness([evidence(2), evidence(1), evidence(3)]);
    const page = await service.listForPatient(context, { patientId });
    expect(identity.authorize).toHaveBeenCalledWith(patientId, 'read_records', 'direct-care', context);
    expect(page.nextCursor).toBeNull();
    expect(page.records.map((record) => record.id)).toEqual([evidence(1).id, evidence(2).id, evidence(3).id]);
    expect(page.records[0]).toMatchObject({ patientId, facilityId: context.facilityId, externalLabName: 'Synthetic Reference Lab',
      reportedAt: evidence(1).reported_at, collectedAt: evidence(1).collected_at, sourceDocumentId: command.sourceDocumentId,
      ocrJobId: command.ocrJobId, extractionId: command.extractionId, validationId: command.validationId,
      validationVersion: 3, publicationId: command.publicationId,
      observations: [{ id: `c-${evidence(1).id}`, ordinal: 1, testName: 'Haemoglobin', value: '12.5' }] });
    expect(page.records[0]!.observations[0]).not.toHaveProperty('importId');
    expect(queries[0]!.sql).toMatch(/order by e\.received_at desc, e\.id desc limit \$4/);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    const event = (audit.recordWithClient as jest.Mock).mock.calls[0][1];
    expect(event).toMatchObject({ action: 'lab.import.list', patientId, facilityId: context.facilityId,
      resourceType: 'lab-imported-evidence-collection', purposeOfUse: 'direct-care',
      details: { recordCount: 3, observationCount: 3, importIds: page.records.map((record) => record.id) } });
    expect(JSON.stringify(event)).not.toMatch(/Haemoglobin|12\.5|Synthetic Reference Lab/);
  });

  it('refuses before any query or audit when canonical authorization is absent', async () => {
    const { service, database, audit } = harness([evidence(1)], { allowed: false, breakGlass: false });
    await expect(service.listForPatient(context, { patientId })).rejects.toMatchObject({ status: 403, code: 'LAB_IMPORT_ACCESS_DENIED' });
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('allows a break-glass read, as get() does', async () => {
    const { service } = harness([evidence(1)], { allowed: true, breakGlass: true });
    await expect(service.listForPatient(context, { patientId })).resolves.toMatchObject({ records: [{ id: evidence(1).id }] });
  });

  it('returns no other patient\'s evidence and no other facility\'s, and binds both in the query', async () => {
    const otherFacility = '10000000-0000-4000-8000-000000000009';
    const { service, queries } = harness([evidence(1), evidence(2, otherPatientId), evidence(3, patientId, otherFacility)]);
    const page = await service.listForPatient(context, { patientId });
    expect(page.records.map((record) => record.id)).toEqual([evidence(1).id]);
    expect(queries[0]!.params.slice(0, 2)).toEqual([patientId, context.facilityId]);
    expect(queries[1]!.params).toEqual([[evidence(1).id], patientId, context.facilityId]);
  });

  it('pages by cursor within the default and maximum bounds', async () => {
    const stored = Array.from({ length: 60 }, (_, index) => evidence(index + 1));
    const { service, queries } = harness(stored);
    const first = await service.listForPatient(context, { patientId });
    expect(first.records).toHaveLength(20);
    expect(queries[0]!.params[3]).toBe(21);
    expect(first.nextCursor).toBe(evidence(20).id);
    const second = await service.listForPatient(context, { patientId, cursor: first.nextCursor!, limit: 50 });
    expect(second.records.map((record) => record.id)).toEqual(stored.slice(20, 60).map((row) => row.id));
    expect(second.nextCursor).toBeNull();
    const clamped = await service.listForPatient(context, { patientId, limit: 10_000 });
    expect(clamped.records).toHaveLength(50);
  });

  it('answers an empty page, without an observation query, when there is no evidence', async () => {
    const { service, queries, audit } = harness([]);
    await expect(service.listForPatient(context, { patientId })).resolves.toEqual({ records: [], nextCursor: null });
    expect(queries.some((query) => query.sql.includes('lab.imported_observations'))).toBe(false);
    expect((audit.recordWithClient as jest.Mock).mock.calls[0][1].details).toEqual({ recordCount: 0, observationCount: 0, importIds: [] });
  });
});
