import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { DocumentController } from '../../documents/document.controller';
import type { DocumentService } from '../../documents/document.service';
import type { CreateDocumentUploadDto } from '../../documents/dto/create-document-upload.dto';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import type { ClinicalNotesService } from '../clinical-notes/clinical-notes.service';
import { HealthProfileController } from '../health-profile/health-profile.controller';
import type { HealthProfileService } from '../health-profile/health-profile.service';
import type { ImportOcrClinicalNoteDto } from '../ocr-integration/dto/import-ocr-clinical-note.dto';
import { OcrIntegrationController } from '../ocr-integration/ocr-integration.controller';
import type { ImportedAttachmentService } from '../patient-records/imported-attachment.service';
import type { PatientChatHistoryService } from '../patient-records/patient-chat-history.service';
import type { PatientChatService } from '../patient-records/patient-chat.service';
import type { PatientChatSourceService } from '../patient-records/patient-chat-source.service';
import { PatientRecordsController } from '../patient-records/patient-records.controller';
import type { PatientRecordsService } from '../patient-records/patient-records.service';
import { patientRecordContext } from './clinical-context';

// Records processing (healthcare-operations, 0104) is the purpose of a grant
// that lets OCR turn a patient's paper documents into the digital record. The
// document routes and the OCR source route keep taking it; the patient record
// outside the encounter routes (which are direct care only) refuses it before
// any work, while direct care and emergency reach the service as before.

const facilityId = '10000000-0000-4000-8000-000000000002';
const actor = { id: 'staff:records', subject: 'staff:records', accountId: '20000000-0000-4000-8000-000000000001',
  roles: ['doctor'], permissions: ['ehr.note.read'], facilityIds: [facilityId], authenticationMethod: 'local' as const,
  facilities: [], facility: { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: facilityId, name: 'Facility', roles: ['doctor'], permissions: ['ehr.note.read'], isPrimary: true } };

function guardedRequest(purpose: string | undefined): HidRequest {
  const lower: Record<string, string | undefined> = { authorization: 'Bearer synthetic', 'x-purpose-of-use': purpose };
  return { method: 'GET', correlationId: 'correlation-ehr-records-0001', actor, facilityId,
    route: { path: '/api/v1/ehr/patients/:patientId/imported-records' },
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function refusal(run: () => unknown): DomainProblem {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(DomainProblem);
    return error as DomainProblem;
  }
  throw new Error('The call did not throw');
}

describe('patientRecordContext', () => {
  it('answers 400 PURPOSE_OF_USE_REQUIRED for healthcare-operations', () => {
    const request = guardedRequest('healthcare-operations');
    const problem = refusal(() => patientRecordContext(request));
    expect([problem.getStatus(), problem.code, problem.message]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED',
      'X-Purpose-Of-Use must be direct-care or emergency for the patient record']);
    expect(request.purposeOfUse).toBeUndefined();
  });

  it.each(['direct-care', 'emergency'])('accepts %s', (purpose) => {
    const request = guardedRequest(purpose);
    expect(patientRecordContext(request)).toMatchObject({ purposeOfUse: purpose, facilityId,
      membershipId: actor.facility.membershipId, correlationId: 'correlation-ehr-records-0001' });
    expect(request.purposeOfUse).toBe(purpose);
  });

  it.each([undefined, 'treatment'])('keeps the refusal of a missing or unknown purpose (%s)', (purpose) => {
    const problem = refusal(() => patientRecordContext(guardedRequest(purpose)));
    expect([problem.getStatus(), problem.code, problem.message]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED',
      'X-Purpose-Of-Use must be direct-care, emergency or healthcare-operations']);
  });
});

describe('records processing reaches the documents but not the chart', () => {
  const patientId = '60000000-0000-4000-8000-000000000001';
  const id = '70000000-0000-4000-8000-000000000001';
  const publicationId = '80000000-0000-4000-8000-000000000001';
  const records = { imported: jest.fn() };
  const attachments = { staff: jest.fn() };
  const profiles = { reported: jest.fn() };
  const clinicalNotes = { createImportedFromOcr: jest.fn() };
  const documents = { createUploadIntent: jest.fn(), list: jest.fn(), complete: jest.fn(),
    createDownload: jest.fn(), getOcrSource: jest.fn() };
  const recordRoutes = new PatientRecordsController(records as unknown as PatientRecordsService,
    attachments as unknown as ImportedAttachmentService, {} as PatientChatService, {} as PatientChatHistoryService,
    {} as PatientChatSourceService);
  const profileRoutes = new HealthProfileController(profiles as unknown as HealthProfileService);
  const ocrRoutes = new OcrIntegrationController(documents as unknown as DocumentService,
    clinicalNotes as unknown as ClinicalNotesService);
  const documentRoutes = new DocumentController(documents as unknown as DocumentService, {} as IdentityApiService);
  const services = [records.imported, attachments.staff, profiles.reported, clinicalNotes.createImportedFromOcr,
    ...Object.values(documents)];

  beforeEach(() => { for (const method of services) method.mockReset(); });

  const chart = [
    { route: 'GET /ehr/patients/:patientId/imported-records', service: records.imported,
      call: (request: HidRequest) => recordRoutes.imported(patientId, request) },
    { route: 'GET /ehr/patients/:patientId/imported-attachments/:fileId/download', service: attachments.staff,
      call: (request: HidRequest) => recordRoutes.downloadStaff(patientId, id, request) },
    { route: 'GET /ehr/patients/:patientId/reported-health-profile', service: profiles.reported,
      call: (request: HidRequest) => profileRoutes.reported(patientId, request) },
  ];
  const ocrImport = { route: 'POST /ehr/internal/ocr/patients/:patientId/clinical-notes',
    service: clinicalNotes.createImportedFromOcr,
    call: (request: HidRequest) => ocrRoutes.importClinicalNote(patientId,
      { publicationId } as ImportOcrClinicalNoteDto, `ocr-publication:${publicationId}`, request) };

  it.each(chart)('$route refuses healthcare-operations before any work', ({ call }) => {
    const problem = refusal(() => call(guardedRequest('healthcare-operations')));
    expect([problem.getStatus(), problem.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
    for (const method of services) expect(method).not.toHaveBeenCalled();
  });

  it.each([...chart, ocrImport].flatMap((route) => ['direct-care', 'emergency'].map((purpose) => ({ ...route, purpose }))))(
    '$route still serves $purpose', ({ call, service, purpose }) => {
      call(guardedRequest(purpose));
      expect(service).toHaveBeenCalledTimes(1);
      expect(service.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ purposeOfUse: purpose })]));
    },
  );

  // 0113 (owner decision of 2026-11-11): the OCR note import takes
  // healthcare-operations to the service, which publishes only a draft into
  // the imported paper records and only under the dedicated records-processing
  // grant (clinical-notes.ocr-import.spec.ts).
  it('the OCR note import passes healthcare-operations to the service (the draft path)', () => {
    ocrImport.call(guardedRequest('healthcare-operations'));
    expect(clinicalNotes.createImportedFromOcr).toHaveBeenCalledTimes(1);
    expect(clinicalNotes.createImportedFromOcr.mock.calls[0][0]).toMatchObject({ purposeOfUse: 'healthcare-operations' });
  });

  it.each([
    { route: 'POST /ehr/documents/upload-intents', service: documents.createUploadIntent,
      call: (request: HidRequest) => documentRoutes.createUpload({} as CreateDocumentUploadDto, 'synthetic-key-0001', request) },
    { route: 'GET /ehr/documents', service: documents.list,
      call: (request: HidRequest) => documentRoutes.list({ patientId, encounterId: id }, request) },
    { route: 'POST /ehr/documents/:id/complete', service: documents.complete,
      call: (request: HidRequest) => documentRoutes.complete(id, request) },
    { route: 'GET /ehr/documents/:id/download', service: documents.createDownload,
      call: (request: HidRequest) => documentRoutes.download(id, request) },
    { route: 'GET /ehr/internal/ocr/documents/:documentId/source', service: documents.getOcrSource,
      call: (request: HidRequest) => ocrRoutes.source(id, request) },
  ])('$route keeps taking healthcare-operations', ({ call, service }) => {
    call(guardedRequest('healthcare-operations'));
    expect(service).toHaveBeenCalledTimes(1);
    expect(service.mock.calls[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ purposeOfUse: 'healthcare-operations' })]));
  });
});
