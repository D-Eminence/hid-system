import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { INTERNAL_CALLER, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import type { DataAccessContext } from '../common/request-context';
import { IMPORT_PAGE_MAX, ListOtherFacilityImportedMedicationsQueryDto } from './dto/ocr-medication-import.dto';
import { PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards } from './order-route-cards';
import { PharmacyController } from './pharmacy.controller';
import { decodeOtherFacilityCursor, encodeOtherFacilityCursor, OTHER_FACILITY_IMPORTS_QUERY, PharmacyService }
  from './pharmacy.service';

// Synthetic test data only.
const ids = {
  patient: '123e4567-e89b-42d3-a456-426614174001', facility: '123e4567-e89b-42d3-a456-426614174002',
  account: '123e4567-e89b-42d3-a456-426614174003', membership: '123e4567-e89b-42d3-a456-426614174004',
  source: '123e4567-e89b-42d3-a456-42661417400c',
};
const context: DataAccessContext = {
  correlationId: 'correlation-123456', facilityId: ids.facility, membershipId: ids.membership,
  purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: {
    id: ids.account, subject: 'staff:test', accountId: ids.account, authenticationMethod: 'local',
    roles: ['pharmacist'], permissions: ['pharmacy.import.read'], facilityIds: [ids.facility], facilities: [],
  },
};

function row(index: number) {
  return { import_id: `323e4567-e89b-42d3-a456-4266141740${String(index).padStart(2, '0')}`,
    source_facility_id: ids.source, source_facility_name: 'Synthetic Community Pharmacy',
    medication_text: `Fictional medicine ${index}`, strength_text: '5mg', dose_text: null, frequency_text: 'once daily',
    historical_context: 'From a paper record, page 1', activity_status: 'unknown',
    created_at: new Date(Date.UTC(2026, 10, 5, 10, 0, 60 - index)),
    cursor_at: `2026-11-05T10:00:${String(60 - index).padStart(2, '0')}.000123Z` };
}

function harness(answer: unknown[] | Error) {
  const query = jest.fn(async () => {
    if (answer instanceof Error) throw answer;
    return { rows: answer };
  });
  const identity = { authorize: jest.fn() };
  const audit = { recordWithClient: jest.fn() };
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown) =>
    operation({ query })) };
  const service = new PharmacyService(database as never, identity as never, audit as never,
    new PharmacyOrderRouteAccess(identity as never), new PharmacyOrderRouteCards(database as never));
  return { service, identity, audit, database, query };
}

const dbError = (code: string, message: string) => Object.assign(new Error(message), { code });

async function errors(input: Record<string, unknown>) {
  return (await validate(plainToInstance(ListOtherFacilityImportedMedicationsQueryDto, input),
    { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true })).map((error) => error.property);
}

describe('GET pharmacy/imports/other-facilities (0124)', () => {
  it('is a browser route needing pharmacy.import.read, declared before imports/:importId', () => {
    const prototype = PharmacyController.prototype as unknown as Record<string, object>;
    const handler = prototype.listOtherFacilityImports!;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('imports/other-facilities');
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['pharmacy.import.read']);
    expect(Reflect.getMetadata(INTERNAL_CALLER, handler)).toBeUndefined();
    expect(Reflect.getMetadata(PUBLIC_ROUTE, handler)).toBeUndefined();
    const names = Object.getOwnPropertyNames(PharmacyController.prototype);
    expect(names.indexOf('listOtherFacilityImports')).toBeLessThan(names.indexOf('getImport'));
  });

  it('reads through the SQL function in the request transaction, without Identity or a service audit row', async () => {
    const rows = [row(1), row(2)];
    const { service, identity, audit, database, query } = harness(rows);
    const page = await service.listOtherFacilityImports(context, { patientId: ids.patient });
    expect(database.withTransaction).toHaveBeenCalledWith(context, expect.any(Function));
    expect(query).toHaveBeenCalledWith(OTHER_FACILITY_IMPORTS_QUERY, [ids.patient, null, null, 50]);
    expect(OTHER_FACILITY_IMPORTS_QUERY)
      .toMatch(/from pharmacy\.patient_imports_other_facilities\(\$1::uuid,\$2::timestamptz,\$3::uuid,\$4::integer\)/);
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toEqual({ id: rows[0]!.import_id, sourceFacilityId: ids.source,
      sourceFacilityName: 'Synthetic Community Pharmacy', medicationText: 'Fictional medicine 1', strengthText: '5mg',
      doseText: null, frequencyText: 'once daily', historicalContext: 'From a paper record, page 1',
      activityStatus: 'unknown', createdAt: rows[0]!.created_at, provenance: 'imported-from-paper-other-facility' });
    expect(page.items[0]).not.toHaveProperty('patientId');
  });

  it('answers a cursor (microsecond time and id) when a full page came back, and passes it back decoded', async () => {
    const { service, query } = harness([row(1), row(2)]);
    const first = await service.listOtherFacilityImports(context, { patientId: ids.patient, limit: 2 });
    expect(first.nextCursor).toBe(encodeOtherFacilityCursor('2026-11-05T10:00:58.000123Z', row(2).import_id));
    expect(decodeOtherFacilityCursor(first.nextCursor!)).toEqual({ at: '2026-11-05T10:00:58.000123Z', id: row(2).import_id });
    await service.listOtherFacilityImports(context, { patientId: ids.patient, limit: 2, cursor: first.nextCursor! });
    expect(query).toHaveBeenLastCalledWith(OTHER_FACILITY_IMPORTS_QUERY,
      [ids.patient, '2026-11-05T10:00:58.000123Z', row(2).import_id, 2]);
    const clamped = harness([]);
    await clamped.service.listOtherFacilityImports(context, { patientId: ids.patient, limit: 10_000 });
    expect(clamped.query).toHaveBeenCalledWith(OTHER_FACILITY_IMPORTS_QUERY, [ids.patient, null, null, IMPORT_PAGE_MAX]);
  });

  it('refuses a malformed cursor before the database (400 INVALID_CURSOR)', async () => {
    for (const cursor of ['bm90LWEtY3Vyc29y', Buffer.from(`2026-11-05|${row(1).import_id}`).toString('base64url')]) {
      const { service, database } = harness([]);
      await expect(service.listOtherFacilityImports(context, { patientId: ids.patient, cursor }))
        .rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
      expect(database.withTransaction).not.toHaveBeenCalled();
    }
  });

  it('maps the function\'s refusals: no qualifying share 403, invalid request 400; others unchanged', async () => {
    await expect(harness(dbError('42501', 'OTHER_FACILITIES_NOT_SHARED')).service
      .listOtherFacilityImports(context, { patientId: ids.patient }))
      .rejects.toMatchObject({ status: 403, code: 'OTHER_FACILITIES_NOT_SHARED' });
    await expect(harness(dbError('22023', 'OTHER_FACILITIES_REQUEST_INVALID')).service
      .listOtherFacilityImports(context, { patientId: ids.patient }))
      .rejects.toMatchObject({ status: 400, code: 'OTHER_FACILITIES_REQUEST_INVALID' });
    const grant = dbError('42501', 'permission denied for function patient_imports_other_facilities');
    await expect(harness(grant).service.listOtherFacilityImports(context, { patientId: ids.patient })).rejects.toBe(grant);
  });

  it('bounds the query: patientId a UUID, limit 1-100 digits only, cursor base64url, nothing else', async () => {
    expect(await errors({ patientId: ids.patient })).toEqual([]);
    expect(await errors({ patientId: ids.patient, limit: '100',
      cursor: encodeOtherFacilityCursor('2026-11-05T10:00:58.000123Z', row(2).import_id) })).toEqual([]);
    expect(await errors({})).toEqual(['patientId']);
    for (const limit of ['0', '101', '-1', '2.5', 'ten']) expect(await errors({ patientId: ids.patient, limit })).toEqual(['limit']);
    for (const cursor of ['a b', 'a+b/c=', 'x'.repeat(129)]) expect(await errors({ patientId: ids.patient, cursor })).toEqual(['cursor']);
    expect(await errors({ patientId: ids.patient, facilityId: ids.source })).toEqual(['facilityId']);
  });
});
