import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { ANY_PERMISSIONS, REQUIRED_PERMISSIONS } from '../common/decorators';
import type { DataAccessContext } from '../common/request-context';
import { OcrIntegrationController } from '../ehr/ocr-integration/ocr-integration.controller';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';

// Owner decision Q112 A (18 November 2026, migration 0136): the front desk
// uploads scans and sees its own uploads, but opens no other stored document
// and reads no text taken from one. It holds ehr.document.read-own and
// ocr.job.read-own, not ehr.document.read or ocr.job.read; everyone who holds
// the full reads keeps them unchanged.

const documentId = '123e4567-e89b-42d3-a456-426614174020';
const patientId = '123e4567-e89b-42d3-a456-426614174021';
const facilityId = '123e4567-e89b-42d3-a456-426614174022';
const deskAccountId = '123e4567-e89b-42d3-a456-426614174023';
const nurseAccountId = '123e4567-e89b-42d3-a456-426614174024';
const encounterId = '123e4567-e89b-42d3-a456-426614174025';

const contextFor = (accountId: string, roles: string[], permissions: string[]) => ({
  correlationId: 'correlation-own-uploads', facilityId, membershipId: `${accountId}-m`,
  purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: { id: accountId,
    subject: `staff:${accountId}`, accountId, authenticationMethod: 'local', roles, permissions,
    facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId: `${accountId}-m`, organizationId: facilityId, name: 'Fictional Clinic',
      roles, permissions, isPrimary: true } } }) as DataAccessContext;

const desk = contextFor(deskAccountId, ['receptionist'],
  ['ehr.document.write', 'ehr.document.read-own', 'ocr.job.write', 'ocr.job.start', 'ocr.job.read-own']);
const nurse = contextFor(nurseAccountId, ['nurse'],
  ['ehr.document.write', 'ehr.document.read', 'ocr.job.write', 'ocr.job.start', 'ocr.job.read']);
const deskAndNurse = contextFor(deskAccountId, ['receptionist', 'nurse'],
  ['ehr.document.write', 'ehr.document.read-own', 'ehr.document.read', 'ocr.job.read-own', 'ocr.job.read']);

/** One clean, scanned document uploaded by `uploadedBy`. */
function harness(uploadedBy: string) {
  const row = {
    id: documentId, patient_id: patientId, facility_id: facilityId, created_by: uploadedBy,
    storage_bucket: 'synthetic-bucket', storage_key: 'clinical/objects/synthetic', object_version_id: 'synthetic-version',
    declared_media_type: 'application/pdf', detected_media_type: 'application/pdf', original_file_name: 'Card.pdf',
    size_bytes: '1024', sha256_hex: 'a'.repeat(64), scan_status: 'clean', status: 'available', row_version: '3',
  };
  const issued: { sql: string; params: unknown[] }[] = [];
  const client = { query: jest.fn(async (sql: string, params: unknown[] = []) => {
    issued.push({ sql, params });
    return /from ehr\.documents_effective/.test(sql) && !/"fileName"/.test(sql)
      ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  }) };
  const database = { withTransaction: jest.fn(async (_c: unknown, operation: (value: typeof client) => unknown) =>
    operation(client)) };
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true }) };
  const audit = { record: jest.fn().mockResolvedValue(undefined), recordWithClient: jest.fn().mockResolvedValue(undefined) };
  const storage = { createDownload: jest.fn().mockResolvedValue({ url: 'https://s3.example/signed', expiresInSeconds: 60 }) };
  const service = new DocumentService(database as never, identity as never, audit as never, storage as never);
  const listParams = () => issued.find((query) => /"fileName"/.test(query.sql))?.params;
  return { service, identity, storage, audit, listParams };
}

describe('Documents for the front desk (Q112 A): its own uploads only', () => {
  it('lists, downloads and reads a document for OCR when the desk uploaded it', async () => {
    const own = harness(deskAccountId);
    await own.service.list(patientId, encounterId, desk);
    expect(own.listParams()).toEqual([patientId, encounterId, facilityId, deskAccountId]);
    await expect(own.service.createDownload(documentId, desk)).resolves.toMatchObject({ url: 'https://s3.example/signed' });
    await expect(own.service.getOcrSource(documentId, desk)).resolves.toMatchObject({ id: documentId, patientId });
  });

  it('answers 404 for a document someone else uploaded, before Identity or storage is asked', async () => {
    const other = harness(nurseAccountId);
    await expect(other.service.createDownload(documentId, desk)).rejects.toBeInstanceOf(NotFoundException);
    await expect(other.service.getOcrSource(documentId, desk)).rejects.toBeInstanceOf(NotFoundException);
    expect(other.identity.authorize).not.toHaveBeenCalled();
    expect(other.storage.createDownload).not.toHaveBeenCalled();
    expect(other.audit.record).not.toHaveBeenCalled();
  });

  it('keeps the full reads unchanged for a nurse, and for a desk member who is also a nurse', async () => {
    for (const reader of [nurse, deskAndNurse]) {
      const other = harness(reader === nurse ? deskAccountId : nurseAccountId);
      await other.service.list(patientId, encounterId, reader);
      expect(other.listParams()).toEqual([patientId, encounterId, facilityId, null]);
      await expect(other.service.createDownload(documentId, reader)).resolves.toMatchObject({ expiresInSeconds: 60 });
      await expect(other.service.getOcrSource(documentId, reader)).resolves.toMatchObject({ id: documentId });
    }
  });

  it('binds the list to the uploader in its SQL, so no other document is read', async () => {
    const own = harness(deskAccountId);
    await own.service.list(patientId, encounterId, desk);
    const service = own.service as unknown as { database: { withTransaction: jest.Mock } };
    const operation = service.database.withTransaction.mock.calls[0]![1] as (client: unknown) => Promise<unknown>;
    const seen: string[] = [];
    await operation({ query: async (sql: string) => { seen.push(sql); return { rows: [], rowCount: 0 }; } });
    expect(seen.find((sql) => /"fileName"/.test(sql))).toMatch(/and \(\$4::uuid is null or document\.created_by=\$4::uuid\)/);
  });
});

describe('Document routes after 0136', () => {
  const anyOf = (handler: object) => Reflect.getMetadata(ANY_PERMISSIONS, handler) as unknown;
  const required = (handler: object) => Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) as unknown;

  it('list and download take ehr.document.read or the desk\'s ehr.document.read-own', () => {
    for (const handler of [DocumentController.prototype.list, DocumentController.prototype.download]) {
      expect(anyOf(handler)).toEqual(['ehr.document.read', 'ehr.document.read-own']);
      expect(required(handler)).toBeUndefined();
    }
    expect(required(DocumentController.prototype.createUpload)).toEqual(['ehr.document.write']);
    expect(required(DocumentController.prototype.complete)).toEqual(['ehr.document.write']);
  });

  it('OCR\'s source read takes ocr.job.read or ocr.job.read-own; importing a reading is unchanged', () => {
    expect(anyOf(OcrIntegrationController.prototype.source)).toEqual(['ocr.job.read', 'ocr.job.read-own']);
    expect(required(OcrIntegrationController.prototype.source)).toBeUndefined();
    expect(required(OcrIntegrationController.prototype.importClinicalNote)).toEqual(['ocr.publication.write']);
  });
});
