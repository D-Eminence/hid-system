import type { ArgumentsHost } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { DocumentController } from '../documents/document.controller';
import type { DocumentService } from '../documents/document.service';
import type { CreateDocumentUploadDto } from '../documents/dto/create-document-upload.dto';
import type { ClinicalNotesService } from '../ehr/clinical-notes/clinical-notes.service';
import type { ImportOcrClinicalNoteDto } from '../ehr/ocr-integration/dto/import-ocr-clinical-note.dto';
import { OcrIntegrationController } from '../ehr/ocr-integration/ocr-integration.controller';
import type { IdentityApiService } from '../integrations/identity-api.service';
import { DomainProblem, ProblemDetailsFilter } from './problem';
import { requireRequestContext, type HidRequest } from './request-context';

// The document routes and the internal OCR routes take the purpose from
// X-Purpose-Of-Use, which the security guard does not check (clinical,
// consent and audit routes check it first themselves). A missing or unknown
// purpose is the client's error and answers 400, while a request the guard did
// not establish stays an internal error.

const facilityId = '10000000-0000-4000-8000-000000000002';
const actor = { id: 'staff:records', subject: 'staff:records', accountId: '20000000-0000-4000-8000-000000000001',
  roles: ['records'], permissions: ['ehr.document.read'], facilityIds: [facilityId], authenticationMethod: 'local' as const,
  facilities: [], facility: { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: facilityId, name: 'Facility', roles: ['records'], permissions: ['ehr.document.read'], isPrimary: true } };

function guardedRequest(headers: Record<string, string | undefined>, established = true): HidRequest {
  const lower = Object.fromEntries(Object.entries({ authorization: 'Bearer synthetic', ...headers })
    .map(([name, value]) => [name.toLowerCase(), value]));
  return { method: 'GET', correlationId: 'correlation-ehr-purpose-0001',
    ...(established ? { actor, facilityId } : {}),
    route: { path: '/api/v1/ehr/documents' },
    header: (name: string) => lower[name.toLowerCase()] } as unknown as HidRequest;
}

function thrown(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error('The call did not throw');
}

function purposeRefusal(run: () => unknown): DomainProblem {
  const caught = thrown(run);
  expect(caught).toBeInstanceOf(DomainProblem);
  return caught as DomainProblem;
}

describe('EHR request context purpose of use', () => {
  it.each([
    { name: 'no X-Purpose-Of-Use header', headers: {} },
    { name: 'an empty X-Purpose-Of-Use header', headers: { 'x-purpose-of-use': '' } },
    { name: 'an unknown purpose', headers: { 'x-purpose-of-use': 'treatment' } },
    { name: 'a purpose in another case', headers: { 'x-purpose-of-use': 'Direct-Care' } },
  ])('answers 400 PURPOSE_OF_USE_REQUIRED for $name', ({ headers }) => {
    const request = guardedRequest(headers);
    const problem = purposeRefusal(() => requireRequestContext(request));
    expect([problem.getStatus(), problem.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
    expect(request.purposeOfUse).toBeUndefined();
  });

  it.each(['direct-care', 'emergency', 'healthcare-operations'])('accepts the header purpose %s', (purpose) => {
    const request = guardedRequest({ 'x-purpose-of-use': purpose });
    expect(requireRequestContext(request)).toMatchObject({ purposeOfUse: purpose, facilityId,
      membershipId: actor.facility.membershipId, correlationId: 'correlation-ehr-purpose-0001',
      authorization: 'Bearer synthetic', requestMethod: 'GET' });
    expect(request.purposeOfUse).toBe(purpose);
  });

  it('takes a supplied purpose over the header', () => {
    expect(requireRequestContext(guardedRequest({ 'x-purpose-of-use': 'treatment' }), 'direct-care').purposeOfUse)
      .toBe('direct-care');
  });

  it('keeps a request the guard did not establish an internal error, not a client error', () => {
    const error = thrown(() => requireRequestContext(guardedRequest({ 'x-purpose-of-use': 'direct-care' }, false)));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DomainProblem);
  });

  it('renders the refusal as a 400 problem and logs no server error', () => {
    const request = guardedRequest({});
    const problem = purposeRefusal(() => requireRequestContext(request));
    const json = jest.fn();
    const type = jest.fn(() => ({ json }));
    const status = jest.fn(() => ({ type }));
    const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      new ProblemDetailsFilter().catch(problem, host);
      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 400, code: 'PURPOSE_OF_USE_REQUIRED',
        correlationId: 'correlation-ehr-purpose-0001',
        detail: 'X-Purpose-Of-Use must be direct-care, emergency or healthcare-operations' }));
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

describe('EHR header-purpose routes refuse a missing purpose before any work', () => {
  const id = '70000000-0000-4000-8000-000000000001';
  const publicationId = '80000000-0000-4000-8000-000000000001';
  const documents = { createUploadIntent: jest.fn(), list: jest.fn(), complete: jest.fn(),
    createDownload: jest.fn(), getOcrSource: jest.fn() };
  const clinicalNotes = { createImportedFromOcr: jest.fn() };
  const identity = {};
  const documentRoutes = new DocumentController(documents as unknown as DocumentService,
    identity as unknown as IdentityApiService);
  const ocrRoutes = new OcrIntegrationController(documents as unknown as DocumentService,
    clinicalNotes as unknown as ClinicalNotesService);

  it.each([
    { route: 'POST /ehr/documents/upload-intents', call: (request: HidRequest) =>
      documentRoutes.createUpload({} as CreateDocumentUploadDto, 'synthetic-key-0001', request) },
    { route: 'GET /ehr/documents', call: (request: HidRequest) =>
      documentRoutes.list({ patientId: id, encounterId: id }, request) },
    { route: 'POST /ehr/documents/:id/complete', call: (request: HidRequest) => documentRoutes.complete(id, request) },
    { route: 'GET /ehr/documents/:id/download', call: (request: HidRequest) => documentRoutes.download(id, request) },
    { route: 'GET /ehr/internal/ocr/documents/:documentId/source', call: (request: HidRequest) =>
      ocrRoutes.source(id, request) },
    { route: 'POST /ehr/internal/ocr/patients/:patientId/clinical-notes', call: (request: HidRequest) =>
      ocrRoutes.importClinicalNote(id, { publicationId } as ImportOcrClinicalNoteDto,
        `ocr-publication:${publicationId}`, request) },
  ])('$route answers 400 PURPOSE_OF_USE_REQUIRED without a purpose', ({ call }) => {
    const problem = purposeRefusal(() => call(guardedRequest({})));
    expect([problem.getStatus(), problem.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
    for (const method of [...Object.values(documents), ...Object.values(clinicalNotes)]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  // Break-glass at launch (0093, D9): the chart routes accept only direct-care,
  // but the document list and download keep taking the emergency purpose, so
  // a break-glass grant reads the activating facility's documents as before.
  // Whether it should is open (N3, Health-id hand-off B1(c)); this pins the
  // contract until that decision, which must precede re-enabling uploads.
  it.each([
    { route: 'GET /ehr/documents', method: 'list' as const, call: (request: HidRequest) =>
      documentRoutes.list({ patientId: id, encounterId: id }, request) },
    { route: 'GET /ehr/documents/:id/download', method: 'createDownload' as const, call: (request: HidRequest) =>
      documentRoutes.download(id, request) },
  ])('$route passes the emergency purpose to Identity\'s authorization unchanged', ({ method, call }) => {
    documents[method].mockClear();
    call(guardedRequest({ 'x-purpose-of-use': 'emergency' }));
    expect(documents[method]).toHaveBeenCalledTimes(1);
    expect(documents[method].mock.calls[0]?.at(-1)).toMatchObject({ purposeOfUse: 'emergency', facilityId });
  });
});
