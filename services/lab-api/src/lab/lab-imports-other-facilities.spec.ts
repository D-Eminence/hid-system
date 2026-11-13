import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { AUDIT_ACTION, INTERNAL_CALLER, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { LAB_IMPORT_PAGE_MAX, ListOtherFacilityLabImportsQueryDto } from './dto/create-lab-import.dto';
import { LabImportsController } from './lab-imports.controller';
import { decodeOtherFacilityCursor, encodeOtherFacilityCursor, LabImportsService, OTHER_FACILITIES_REFUSAL_QUERY,
  OTHER_FACILITY_IMPORTS_QUERY }
  from './lab-imports.service';

// Synthetic test data only.
const ids = {
  patient: '50000000-0000-4000-8000-000000000001', facility: '10000000-0000-4000-8000-000000000001',
  source: '10000000-0000-4000-8000-000000000002', account: '20000000-0000-4000-8000-000000000001',
  membership: '40000000-0000-4000-8000-000000000001',
};
const context = {
  correlationId: 'lab-other-facilities-correlation', facilityId: ids.facility, membershipId: ids.membership,
  purposeOfUse: 'direct-care',
  actor: { id: 'actor', subject: 'staff:doctor', accountId: ids.account, roles: ['doctor'],
    permissions: ['lab.import.read'], facilityIds: [], facilities: [], authenticationMethod: 'local' },
} satisfies DataAccessContext;

const row = (n: number) => ({
  import_id: `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`, source_facility_id: ids.source,
  source_facility_name: 'Synthetic District Clinic', status: 'accepted', external_lab_name: 'Synthetic Reference Lab',
  external_reference: 'REF-0001', collected_at: new Date('2026-10-01T08:00:00Z'), reported_at: null,
  received_at: new Date(Date.UTC(2026, 9, 10) - n * 60_000), created_at: new Date('2026-10-10T00:00:00Z'),
  observations: [{ ordinal: 1, testCode: null, testName: 'Haemoglobin', value: '12.5', valueText: null, unit: 'g/dL',
    referenceRange: null, abnormalFlag: 'unknown', reportedAt: null }],
  cursor_at: `2026-10-0${n}T09:00:00.123456Z`,
});

function harness(answer: unknown[] | Error, refused: string | null = null) {
  const client = { query: jest.fn(async (sql: string) => {
    if (sql === OTHER_FACILITIES_REFUSAL_QUERY) return { rows: [{ refused }], rowCount: 1 };
    if (answer instanceof Error) throw answer;
    return { rows: answer, rowCount: answer.length };
  }) };
  const database = { withTransaction: jest.fn(async <T>(_context: DataAccessContext,
    operation: (db: PoolClient) => Promise<T>) => operation(client as unknown as PoolClient)) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn() } as unknown as IdentityService;
  const audit = { recordWithClient: jest.fn() } as unknown as AuditService;
  return { service: new LabImportsService(database, identity, audit), client, database, identity, audit };
}

const dbError = (code: string, message: string) => Object.assign(new Error(message), { code });

async function errors(input: Record<string, unknown>) {
  return (await validate(plainToInstance(ListOtherFacilityLabImportsQueryDto, input),
    { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true })).map((error) => error.property);
}

describe('GET lab/imports/other-facilities (0124)', () => {
  it('is a browser route needing lab.import.read, audited as a request, declared before :importId', () => {
    const prototype = LabImportsController.prototype as unknown as Record<string, object>;
    const handler = prototype.listOtherFacilities!;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('other-facilities');
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['lab.import.read']);
    expect(Reflect.getMetadata(AUDIT_ACTION, handler)).toBe('lab.import.other-facilities.list.request');
    expect(Reflect.getMetadata(INTERNAL_CALLER, handler)).toBeUndefined();
    expect(Reflect.getMetadata(PUBLIC_ROUTE, handler)).toBeUndefined();
    const names = Object.getOwnPropertyNames(LabImportsController.prototype);
    expect(names.indexOf('listOtherFacilities')).toBeLessThan(names.indexOf('get'));
  });

  it('reads through the SQL function in the request transaction, without Identity or a service audit row', async () => {
    const rows = [row(1), row(2)];
    const { service, client, database, identity, audit } = harness(rows);
    const page = await service.listOtherFacilities(context, { patientId: ids.patient });
    expect(database.withTransaction).toHaveBeenCalledWith(context, expect.any(Function));
    expect(client.query).toHaveBeenCalledWith(OTHER_FACILITY_IMPORTS_QUERY, [ids.patient, null, null, 20]);
    expect(OTHER_FACILITY_IMPORTS_QUERY).toMatch(/from lab\.patient_imports_other_facilities\(\$1::uuid,\$2::timestamptz,\$3::uuid,\$4::integer\)/);
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
    expect(page.nextCursor).toBeNull();
    expect(page.records[0]).toEqual({ id: rows[0]!.import_id, sourceFacilityId: ids.source,
      sourceFacilityName: 'Synthetic District Clinic', status: 'accepted', externalLabName: 'Synthetic Reference Lab',
      externalReference: 'REF-0001', collectedAt: rows[0]!.collected_at, reportedAt: null, receivedAt: rows[0]!.received_at,
      createdAt: rows[0]!.created_at, observations: rows[0]!.observations, provenance: 'imported-from-paper-other-facility' });
    expect(page.records[0]).not.toHaveProperty('patientId');
  });

  it('answers a cursor (microsecond time and id) when a full page came back, and passes it back decoded', async () => {
    const { service, client } = harness([row(1), row(2)]);
    const first = await service.listOtherFacilities(context, { patientId: ids.patient, limit: 2 });
    expect(first.nextCursor).toBe(encodeOtherFacilityCursor('2026-10-02T09:00:00.123456Z', row(2).import_id));
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    await service.listOtherFacilities(context, { patientId: ids.patient, limit: 2, cursor: first.nextCursor! });
    expect(client.query).toHaveBeenCalledWith(OTHER_FACILITY_IMPORTS_QUERY,
      [ids.patient, '2026-10-02T09:00:00.123456Z', row(2).import_id, 2]);
    const clamped = harness([]);
    await clamped.service.listOtherFacilities(context, { patientId: ids.patient, limit: 10_000 });
    expect(clamped.client.query).toHaveBeenCalledWith(OTHER_FACILITY_IMPORTS_QUERY, [ids.patient, null, null, LAB_IMPORT_PAGE_MAX]);
  });

  it('refuses a malformed cursor before the database (400 INVALID_CURSOR)', async () => {
    for (const cursor of ['bm90LWEtY3Vyc29y', Buffer.from(`2026-10-02T09:00:00Z|${row(1).import_id}`).toString('base64url'),
      Buffer.from('2026-10-02T09:00:00.123456Z|not-an-id').toString('base64url'),
      Buffer.from(`2026-10-02T09:00:00.123456Z|${row(1).import_id}|x`).toString('base64url')]) {
      expect(() => decodeOtherFacilityCursor(cursor)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
      const { service, database } = harness([]);
      await expect(service.listOtherFacilities(context, { patientId: ids.patient, cursor }))
        .rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
      expect(database.withTransaction).not.toHaveBeenCalled();
    }
  });

  it('answers a refusal the function flagged (denied audit row kept) with 403, after the transaction', async () => {
    const refused = harness([], 'OTHER_FACILITIES_NOT_SHARED');
    await expect(refused.service.listOtherFacilities(context, { patientId: ids.patient }))
      .rejects.toMatchObject({ status: 403, code: 'OTHER_FACILITIES_NOT_SHARED' });
    expect(refused.client.query).toHaveBeenCalledWith(OTHER_FACILITIES_REFUSAL_QUERY);
    expect(refused.database.withTransaction).toHaveBeenCalledTimes(1);
    await expect((refused.database.withTransaction as jest.Mock).mock.results[0]!.value).resolves.toEqual({ found: [], refused: true });
    const empty = harness([], '');
    await expect(empty.service.listOtherFacilities(context, { patientId: ids.patient }))
      .resolves.toEqual({ records: [], nextCursor: null });
  });

  it('maps raised errors: invalid request 400; a raised 42501 OTHER_FACILITIES_NOT_SHARED (not raised since the denied audit row) still 403; others unchanged', async () => {
    const notShared = harness(dbError('42501', 'OTHER_FACILITIES_NOT_SHARED'));
    await expect(notShared.service.listOtherFacilities(context, { patientId: ids.patient }))
      .rejects.toMatchObject({ status: 403, code: 'OTHER_FACILITIES_NOT_SHARED' });
    const invalid = harness(dbError('22023', 'OTHER_FACILITIES_REQUEST_INVALID'));
    await expect(invalid.service.listOtherFacilities(context, { patientId: ids.patient }))
      .rejects.toMatchObject({ status: 400, code: 'OTHER_FACILITIES_REQUEST_INVALID' });
    const grant = dbError('42501', 'permission denied for function patient_imports_other_facilities');
    await expect(harness(grant).service.listOtherFacilities(context, { patientId: ids.patient })).rejects.toBe(grant);
  });

  it('bounds the query: patientId a UUID, limit 1-50 digits only, cursor base64url, nothing else', async () => {
    expect(await errors({ patientId: ids.patient })).toEqual([]);
    expect(await errors({ patientId: ids.patient, limit: '50', cursor: encodeOtherFacilityCursor('2026-10-02T09:00:00.123456Z',
      row(1).import_id) })).toEqual([]);
    expect(await errors({})).toEqual(['patientId']);
    for (const limit of ['0', '51', '-1', '2.5', 'ten']) expect(await errors({ patientId: ids.patient, limit })).toEqual(['limit']);
    for (const cursor of ['a b', 'a+b/c=', 'x'.repeat(129)]) expect(await errors({ patientId: ids.patient, cursor })).toEqual(['cursor']);
    expect(await errors({ patientId: ids.patient, facilityId: ids.source })).toEqual(['facilityId']);
  });
});
