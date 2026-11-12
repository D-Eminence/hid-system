import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { INTERNAL_CALLER, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { IMPORT_PAGE_MAX, ListImportedMedicationsQueryDto } from './dto/ocr-medication-import.dto';
import { PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards } from './order-route-cards';
import { PharmacyController } from './pharmacy.controller';
import { PATIENT_IMPORTS_QUERY, PharmacyService } from './pharmacy.service';

// Fictional test data only.
const ids = {
  patient: '123e4567-e89b-42d3-a456-426614174001', facility: '123e4567-e89b-42d3-a456-426614174002',
  account: '123e4567-e89b-42d3-a456-426614174003', membership: '123e4567-e89b-42d3-a456-426614174004',
  document: '123e4567-e89b-42d3-a456-426614174005', job: '123e4567-e89b-42d3-a456-426614174006',
  extraction: '123e4567-e89b-42d3-a456-426614174007', validation: '123e4567-e89b-42d3-a456-426614174008',
  publication: '123e4567-e89b-42d3-a456-426614174009', reviewer: '123e4567-e89b-42d3-a456-42661417400a',
  otherPatient: '123e4567-e89b-42d3-a456-42661417400b', otherFacility: '123e4567-e89b-42d3-a456-42661417400c',
};
const context: DataAccessContext = {
  correlationId: 'correlation-123456', facilityId: ids.facility, membershipId: ids.membership,
  purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: {
    id: ids.account, subject: 'staff:test', accountId: ids.account, authenticationMethod: 'local',
    roles: ['pharmacist'], permissions: ['pharmacy.import.read'], facilityIds: [ids.facility], facilities: [],
  },
};

function row(index: number, overrides: Record<string, unknown> = {}) {
  return { id: `323e4567-e89b-42d3-a456-4266141740${String(index).padStart(2, '0')}`, patient_id: ids.patient,
    facility_id: ids.facility, source_type: 'IMPORTED_MEDICATION_EVIDENCE', activity_status: 'unknown',
    source_document_id: ids.document, ocr_job_id: ids.job, extraction_id: ids.extraction,
    validation_id: ids.validation, validation_version: 1, publication_id: ids.publication,
    medication_text: `Fictional medicine ${index}`, strength_text: '5mg', dose_text: null, frequency_text: 'once daily',
    historical_context: 'From a paper record, page 1', reviewed_by: ids.reviewer, row_version: '1',
    created_at: new Date(Date.UTC(2026, 10, 5, 10, 0, 60 - index)), request_sha256: 'c'.repeat(64), ...overrides };
}

function harness(rows: unknown[], decision: Record<string, unknown> = { allowed: true, breakGlass: false }) {
  const query = jest.fn(async (sql: string) => (sql === PATIENT_IMPORTS_QUERY ? { rows } : { rows: [] }));
  const identity = { authorize: jest.fn().mockResolvedValue(decision) };
  const audit = { recordWithClient: jest.fn() };
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown) =>
    operation({ query })) };
  const service = new PharmacyService(database as never, identity as never, audit as never,
    new PharmacyOrderRouteAccess(identity as never), new PharmacyOrderRouteCards(database as never));
  return { service, identity, audit, database, query };
}

async function errors(input: Record<string, unknown>) {
  return (await validate(plainToInstance(ListImportedMedicationsQueryDto, input),
    { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true })).map((error) => error.property);
}

describe('GET pharmacy/imports (one patient\'s imported medications)', () => {
  it('is a browser route needing pharmacy.import.read, like GET imports/:importId, never internal or public', () => {
    const prototype = PharmacyController.prototype as unknown as Record<string, object>;
    const handler = prototype.listImports!;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('imports');
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler))
      .toEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, prototype.getImport!));
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['pharmacy.import.read']);
    expect(Reflect.getMetadata(INTERNAL_CALLER, handler)).toBeUndefined();
    expect(Reflect.getMetadata(PUBLIC_ROUTE, handler)).toBeUndefined();
  });

  it('answers the patient\'s records newest first with their OCR provenance, and audits ids and counts only', async () => {
    const rows = [row(1), row(2), row(3)];
    const { service, identity, audit, query } = harness(rows);
    const page = await service.listImports(context, { patientId: ids.patient });
    expect(identity.authorize).toHaveBeenCalledWith(ids.patient, 'read_records', context);
    expect(query).toHaveBeenCalledWith(PATIENT_IMPORTS_QUERY, [ids.patient, ids.facility, null, 51]);
    expect(PATIENT_IMPORTS_QUERY).toMatch(/order by e\.created_at desc,e\.id desc limit \$4/);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((item) => item.id)).toEqual(rows.map((item) => item.id));
    expect(page.items[0]).toEqual({ id: rows[0]!.id, patientId: ids.patient, facilityId: ids.facility,
      sourceType: 'IMPORTED_MEDICATION_EVIDENCE', activityStatus: 'unknown', medicationText: 'Fictional medicine 1',
      strengthText: '5mg', doseText: null, frequencyText: 'once daily', historicalContext: 'From a paper record, page 1',
      sourceDocumentId: ids.document, ocrJobId: ids.job, extractionId: ids.extraction, validationId: ids.validation,
      validationVersion: 1, publicationId: ids.publication, version: 1, createdAt: rows[0]!.created_at });
    expect(page.items[0]).not.toHaveProperty('requestSha256');
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context, 'pharmacy.import.list', {
      patientId: ids.patient, resourceType: 'pharmacy-imported-medication-evidence-collection', resourceId: ids.patient,
    }, { returnedCount: 3, importIds: rows.map((item) => item.id), paged: false });
    expect(JSON.stringify(audit.recordWithClient.mock.calls)).not.toMatch(/Fictional medicine|paper record|5mg|once daily/);
  });

  it('reads and audits nothing when Identity refuses the read', async () => {
    const { service, audit, database, query } = harness([row(1)], { allowed: false, breakGlass: false });
    await expect(service.listImports(context, { patientId: ids.patient }))
      .rejects.toMatchObject({ status: 403, code: 'PHARMACY_ACCESS_DENIED' });
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('passes on an Identity problem unchanged and reads nothing', async () => {
    const { service, identity, database, audit } = harness([row(1)]);
    identity.authorize.mockRejectedValue(new DomainProblem(403, 'PURPOSE_NOT_PERMITTED', 'Not permitted'));
    await expect(service.listImports(context, { patientId: ids.patient }))
      .rejects.toMatchObject({ status: 403, code: 'PURPOSE_NOT_PERMITTED' });
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('allows a break-glass read, as GET imports/:importId does (only writes refuse break-glass)', async () => {
    const { service } = harness([row(1)], { allowed: true, breakGlass: true });
    await expect(service.listImports({ ...context, purposeOfUse: 'emergency' }, { patientId: ids.patient }))
      .resolves.toMatchObject({ items: [{ id: row(1).id }] });
  });

  it('never answers another patient\'s or another facility\'s record', async () => {
    const { service, audit } = harness([row(1), row(2, { patient_id: ids.otherPatient }),
      row(3, { facility_id: ids.otherFacility })]);
    const page = await service.listImports(context, { patientId: ids.patient });
    expect(page.items.map((item) => item.id)).toEqual([row(1).id]);
    expect(audit.recordWithClient.mock.calls[0]?.[4]).toMatchObject({ returnedCount: 1, importIds: [row(1).id] });
    expect(PATIENT_IMPORTS_QUERY).toMatch(/where e\.patient_id=\$1 and e\.facility_id=\$2/);
    expect(PATIENT_IMPORTS_QUERY).toMatch(/c\.id=\$3 and c\.patient_id=\$1 and c\.facility_id=\$2/);
  });

  it('pages: reads one row more than asked, answers at most the limit and the next cursor', async () => {
    const rows = [row(1), row(2), row(3)];
    const { service, query, audit } = harness(rows);
    const page = await service.listImports(context, { patientId: ids.patient, limit: 2, cursor: row(0).id });
    expect(query).toHaveBeenCalledWith(PATIENT_IMPORTS_QUERY, [ids.patient, ids.facility, row(0).id, 3]);
    expect(page.items.map((item) => item.id)).toEqual([row(1).id, row(2).id]);
    expect(page.nextCursor).toBe(row(2).id);
    expect(audit.recordWithClient.mock.calls[0]?.[4]).toMatchObject({ returnedCount: 2, paged: true });
  });

  it('bounds the page: patientId required, limit 1-100 digits only, cursor a UUID, nothing else', async () => {
    expect(await errors({ patientId: ids.patient })).toEqual([]);
    expect(await errors({ patientId: ids.patient, limit: String(IMPORT_PAGE_MAX), cursor: ids.document })).toEqual([]);
    expect(plainToInstance(ListImportedMedicationsQueryDto, { patientId: ids.patient, limit: '7' }).limit).toBe(7);
    expect(await errors({})).toEqual(['patientId']);
    expect(await errors({ patientId: 'not-a-uuid' })).toEqual(['patientId']);
    for (const limit of ['0', '101', '1000', '-1', '2.5', 'ten', '']) {
      expect(await errors({ patientId: ids.patient, limit })).toEqual(['limit']);
    }
    expect(await errors({ patientId: ids.patient, cursor: '2026-11-05' })).toEqual(['cursor']);
    expect(await errors({ patientId: ids.patient, healthId: 'HID-0000-0000' })).toEqual(['healthId']);
  });
});
