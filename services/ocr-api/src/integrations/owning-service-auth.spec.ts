import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { EhrApiService } from './ehr-api.service';
import { LabApiService } from './lab-api.service';
import { PharmacyApiService } from './pharmacy-api.service';
import type { ServiceWorkloadIdentityService } from './service-workload-identity.service';

// EHR, Lab and Pharmacy answer a refusal of OCR's own workload credential
// (the internal-caller header, the local secret or the workload JWT, which a
// JWKS fetch failure also fails) with these codes. Such a refusal is a fault
// between services, not a refusal of the user or of the content, so OCR answers
// 503 <SERVICE>_SERVICE_AUTH_UNAVAILABLE: the browser does not refresh its
// session for it and a publication stores it as retryable. A refusal of the
// propagated user credential keeps the owning service's status and code.

const ENVIRONMENT = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid', DATABASE_SSL: 'false',
  CORS_ORIGINS: 'https://app.example', EHR_API_URL: 'https://ehr.example', LAB_API_URL: 'https://lab.example',
  PHARMACY_API_URL: 'https://pharmacy.example', IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
  IDENTITY_OCR_INTERNAL_SERVICE_TOKEN: 'w'.repeat(32), EHR_SERVICE_IDENTITY_MODE: 'local-secret',
  EHR_INTERNAL_SERVICE_TOKEN: 'e'.repeat(32), LAB_SERVICE_IDENTITY_MODE: 'local-secret',
  LAB_INTERNAL_SERVICE_TOKEN: 'l'.repeat(32), PHARMACY_SERVICE_IDENTITY_MODE: 'local-secret',
  PHARMACY_INTERNAL_SERVICE_TOKEN: 'p'.repeat(32) };

const context = {
  correlationId: 'owning-service-auth-correlation', facilityId: '10000000-0000-4000-8000-000000000001',
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care',
  actor: { id: 'actor', subject: 'staff:records', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['records'], permissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' },
  authorization: 'Bearer synthetic',
} satisfies DataAccessContext;

const patientId = '50000000-0000-4000-8000-000000000001';
const documentId = '60000000-0000-4000-8000-000000000001';
const key = 'ocr-publication:a0000000-0000-4000-8000-000000000001';
const workloadIdentity = {} as ServiceWorkloadIdentityService;

const calls = {
  'EHR document source': () => new EhrApiService(workloadIdentity).getOcrDocumentSource(documentId, context),
  'EHR clinical note': () => new EhrApiService(workloadIdentity).createOcrClinicalNote(patientId, {
    encounterId: 'c0000000-0000-4000-8000-000000000001', noteType: 'progress', title: 'Imported note',
    content: 'Synthetic text', publicationId: 'a0000000-0000-4000-8000-000000000001', documentId,
    ocrJobId: '70000000-0000-4000-8000-000000000001', extractionId: '80000000-0000-4000-8000-000000000001',
    validationId: '90000000-0000-4000-8000-000000000001', validationVersion: 1,
    reviewedBy: context.actor.accountId }, context, key),
  'Lab import': () => new LabApiService(workloadIdentity).createOcrImport(context, { patientId }, key),
  'Pharmacy import': () => new PharmacyApiService(workloadIdentity).createOcrImport(context, { patientId }, key),
} as const;
const owner = { 'EHR document source': 'EHR', 'EHR clinical note': 'EHR', 'Lab import': 'LAB',
  'Pharmacy import': 'PHARMACY' } as const;
type Call = keyof typeof calls;
const everyCall = Object.keys(calls) as Call[];

const originalFetch = global.fetch;
let fetchMock: jest.Mock;
beforeEach(() => {
  Object.assign(process.env, ENVIRONMENT);
  resetEnvironmentForTests();
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

function answer(status: number, body: Record<string, unknown>) {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body),
    { status, headers: { 'content-type': 'application/problem+json' } }));
}

async function refusal(call: Call): Promise<DomainProblem> {
  const error = await calls[call]().then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

const workloadRefusals = [
  { status: 401, code: 'INTERNAL_SERVICE_AUTH_REQUIRED' },
  { status: 401, code: 'INVALID_WORKLOAD_IDENTITY' },
  { status: 403, code: 'WORKLOAD_CALLER_DENIED' },
  { status: 401, code: 'WORKLOAD_IDENTITY_UNAVAILABLE' },
];

describe('OCR integrations answer an owning service refusal of the OCR workload as 503', () => {
  it.each(everyCall.flatMap((call) => workloadRefusals.map((refused) => ({ call, ...refused }))))(
    '$call: $status $code becomes 503 <service>_SERVICE_AUTH_UNAVAILABLE', async ({ call, status, code }) => {
      answer(status, { code, detail: 'Synthetic workload refusal' });
      const problem = await refusal(call);
      expect([problem.getStatus(), problem.code]).toEqual([503, `${owner[call]}_SERVICE_AUTH_UNAVAILABLE`]);
      // A 401 or 403 is not retried inside the client, so the owner was asked once.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

  const passedThrough = [
    { status: 401, code: 'AUTHENTICATION_REQUIRED' },
    { status: 403, code: 'FACILITY_ACCESS_DENIED' },
    { status: 403, code: 'PERMISSION_DENIED' },
    { status: 403, code: 'ACCESS_DENIED' },
    // Only a 401 or 403 is a credential refusal; another status keeps its code.
    { status: 400, code: 'INVALID_WORKLOAD_IDENTITY' },
  ];
  it.each(everyCall.flatMap((call) => passedThrough.map((refused) => ({ call, ...refused }))))(
    '$call: $status $code keeps its status and code', async ({ call, status, code }) => {
      answer(status, { code, detail: 'Synthetic refusal' });
      const problem = await refusal(call);
      expect([problem.getStatus(), problem.code]).toEqual([status, code]);
    });

  it.each(everyCall)('%s: a 401 without a code keeps the owner fallback code', async (call) => {
    answer(401, { detail: 'Synthetic refusal without a code' });
    const problem = await refusal(call);
    expect([problem.getStatus(), problem.code]).toEqual([401, `${owner[call]}_SERVICE_ERROR`]);
  });
});
