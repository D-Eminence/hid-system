import type { PoolClient } from 'pg';
import type { HidRequest } from '../common/request-context';
import * as environment from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { DomainProblem } from '../common/problem';
import type { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import { QoreIdVerificationService } from './qoreid-verification.service';

const patientRequest = {
  correlationId: 'qoreid-service-test-01',
  actor: {
    kind: 'patient', patientId: 'a0000000-0000-4000-8000-000000000001',
    accountId: 'a0000000-0000-4000-8000-000000000002', id: 'actor-id', subject: 'patient:subject',
    sessionId: 'a0000000-0000-4000-8000-000000000003', roles: [], permissions: [], facilityIds: [], facilities: [],
    authenticationMethod: 'oidc',
  },
  header: () => undefined,
} as unknown as HidRequest;

function setup(enabled: boolean) {
  const query = jest.fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ evidenceId: 'a0000000-0000-4000-8000-000000000004', recordedAt: new Date('2026-01-01T00:00:00.000Z') }] });
  const client = { query } as unknown as PoolClient;
  const database = {
    withSystemTransaction: jest.fn(async (_correlation: string, operation: (value: PoolClient) => Promise<unknown>) => operation(client)),
    withTransaction: jest.fn(),
  } as unknown as DatabaseService;
  const provider = {
    verifyNin: jest.fn().mockResolvedValue({ provider: 'qoreid', state: 'verified', providerReference: '99', respondedAt: new Date().toISOString() }),
    verifyCac: jest.fn(),
  } as unknown as QoreIdVerificationAdapter;
  jest.spyOn(environment, 'getEnvironment').mockReturnValue({ QOREID_ENABLED: enabled } as environment.Environment);
  return { service: new QoreIdVerificationService(database, provider), provider, query, database };
}

describe('QoreID verification service', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not call QoreID while disabled, but records only a disabled evidence state', async () => {
    const { service, provider, query } = setup(false);
    await expect(service.verifyPatientNin(patientRequest, '12345678901'))
      .rejects.toMatchObject({ code: 'QOREID_DISABLED', status: 503 });
    expect(provider.verifyNin).not.toHaveBeenCalled();
    expect(query.mock.calls[1]?.[1]).toEqual([
      'patient:subject', patientRequest.actor!.sessionId, 'disabled', null, 'disabled',
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toContain('12345678901');
  });

  it('returns a normalized result only after the session-bound evidence command succeeds', async () => {
    const { service, provider, query } = setup(true);
    await expect(service.verifyPatientNin(patientRequest, '12345678901')).resolves.toEqual({
      entityType: 'patient', verificationType: 'nin', provider: 'qoreid', state: 'verified',
      providerReference: '99', recordedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(provider.verifyNin).toHaveBeenCalledWith('12345678901');
    expect(query.mock.calls[1]?.[0]).toContain('record_my_nin_verification_evidence');
    expect(JSON.stringify(query.mock.calls[1]?.[1])).not.toContain('12345678901');
  });

  it('rejects callers that are not a current patient before provider access', async () => {
    const { service, provider, database } = setup(true);
    const staffRequest = { ...patientRequest, actor: { ...patientRequest.actor!, kind: 'staff', patientId: undefined, sessionId: undefined } } as HidRequest;
    await expect(service.verifyPatientNin(staffRequest, '12345678901')).rejects.toMatchObject({ code: 'PATIENT_SESSION_REQUIRED', status: 403 });
    expect(provider.verifyNin).not.toHaveBeenCalled();
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
  });

  it('records a provider failure category without forwarding provider diagnostics', async () => {
    const { service, provider, query } = setup(true);
    (provider.verifyNin as jest.Mock).mockRejectedValue(new DomainProblem(503, 'QOREID_TIMEOUT', 'provider diagnostic must not escape'));
    await expect(service.verifyPatientNin(patientRequest, '12345678901')).rejects.toMatchObject({ code: 'QOREID_TIMEOUT', status: 503 });
    expect(query.mock.calls[1]?.[1]).toEqual([
      'patient:subject', patientRequest.actor!.sessionId, 'provider_error', null, 'timeout',
    ]);
  });

  it('uses the reusable CAC path and lets the membership-bound command select the existing organization', async () => {
    const { service, provider, database } = setup(true);
    const organizationQuery = jest.fn().mockResolvedValue({
      rows: [{ evidenceId: 'a0000000-0000-4000-8000-000000000005', recordedAt: new Date('2026-01-01T00:00:00.000Z') }],
    });
    (database.withTransaction as jest.Mock).mockImplementation(async (
      _context: unknown,
      operation: (value: PoolClient) => Promise<unknown>,
    ) => operation({ query: organizationQuery } as unknown as PoolClient));
    (provider.verifyCac as jest.Mock).mockResolvedValue({
      provider: 'qoreid', state: 'verified', providerReference: '71', respondedAt: new Date().toISOString(),
    });
    const facilityId = 'a0000000-0000-4000-8000-000000000006';
    const organizationRequest = {
      correlationId: 'qoreid-cac-service-test-01', facilityId,
      actor: {
        kind: 'staff', id: 'staff-id', subject: 'staff:subject', accountId: 'a0000000-0000-4000-8000-000000000007',
        roles: ['admin'], permissions: ['organization.manage'], facilityIds: [facilityId], facilities: [],
        facility: {
          id: facilityId, membershipId: 'a0000000-0000-4000-8000-000000000008',
          organizationId: 'a0000000-0000-4000-8000-000000000009', name: 'Existing organization',
          roles: ['admin'], permissions: ['organization.manage'], isPrimary: true,
        }, authenticationMethod: 'oidc',
      },
      header: () => undefined,
    } as unknown as HidRequest;

    await expect(service.verifyOrganizationCac(organizationRequest, 'hospital', 'RC1234')).resolves.toEqual({
      entityType: 'organization', verificationType: 'cac', provider: 'qoreid', state: 'verified',
      providerReference: '71', recordedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(provider.verifyCac).toHaveBeenCalledWith('RC1234');
    expect(organizationQuery.mock.calls[0]?.[0]).toContain('record_organization_cac_verification_evidence');
    expect(organizationQuery.mock.calls[0]?.[1]).toEqual(['hospital', 'verified', '71', null]);
    expect(JSON.stringify(organizationQuery.mock.calls)).not.toContain('RC1234');
    expect(JSON.stringify(organizationQuery.mock.calls)).not.toContain('a0000000-0000-4000-8000-000000000009');
  });
});
