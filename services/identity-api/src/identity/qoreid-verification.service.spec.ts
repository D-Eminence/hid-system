import type { PoolClient } from 'pg';
import type { HidRequest } from '../common/request-context';
import * as environment from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { DomainProblem } from '../common/problem';
import type { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import type { NinIdentifierProtector } from './nin-identifier-protector';
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
  let profileDateOfBirth: string | null = '1991-03-04';
  let ninEligibility: 'bound_exact' | 'legacy_unbound' | 'denied' = 'bound_exact';
  const query = jest.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (sql.includes('patient_self_profile')) return { rows: [{ profile: {
      patientId: 'a0000000-0000-4000-8000-000000000001', firstName: 'Samplefirst', lastName: 'Samplelast',
      dateOfBirth: profileDateOfBirth,
    } }] };
    if (sql.includes('patient_self_nin_eligibility')) return { rows: [{ state: ninEligibility }] };
    if (sql.includes('bind_my_verified_nin')) return { rows: [{
      evidenceId: 'a0000000-0000-4000-8000-000000000004', recordedAt: new Date('2026-01-01T00:00:00.000Z'),
    }] };
    if (sql.includes('record_my_nin_verification_evidence')) return { rows: [{
      evidenceId: 'a0000000-0000-4000-8000-000000000004', recordedAt: new Date('2026-01-01T00:00:00.000Z'),
    }] };
    return { rows: [] };
  });
  const client = { query } as unknown as PoolClient;
  const database = {
    withSystemTransaction: jest.fn(async (_correlation: string, operation: (value: PoolClient) => Promise<unknown>) => operation(client)),
    withTransaction: jest.fn(),
  } as unknown as DatabaseService;
  const provider = {
    verifyNin: jest.fn().mockResolvedValue({ provider: 'qoreid', state: 'verified', providerReference: '99',
      ninBinding: { nin: '12345678901', firstName: 'Samplefirst', lastName: 'Samplelast', dateOfBirth: '1991-03-04' },
      respondedAt: new Date().toISOString() }),
    verifyCac: jest.fn(),
  } as unknown as QoreIdVerificationAdapter;
  const integrations = { assertAvailable: jest.fn().mockResolvedValue(undefined),
    consumePatientQuota: jest.fn().mockResolvedValue(undefined),
    consumeQuota: jest.fn().mockResolvedValue(undefined) } as unknown as IntegrationRuntimeService;
  const ninProtector = { lookup: jest.fn().mockReturnValue('a'.repeat(64)),
    protectPatientSelf: jest.fn().mockReturnValue({ lookupHmac: 'a'.repeat(64),
      ciphertext: Buffer.alloc(32, 1), keyVersion: 'test-v1', last4: '8901' }),
    protectPatientSelfProfile: jest.fn().mockReturnValue({ ciphertext: Buffer.alloc(64, 2),
      sha256: 'b'.repeat(64), keyVersion: 'test-v1' }) } as unknown as NinIdentifierProtector;
  jest.spyOn(environment, 'getEnvironment').mockReturnValue({ QOREID_ENABLED: enabled } as environment.Environment);
  return { service: new QoreIdVerificationService(database, provider, integrations, ninProtector), provider, query, database,
    integrations, ninProtector,
    setProfileDateOfBirth: (value: string | null) => { profileDateOfBirth = value; },
    setNinEligibility: (value: 'bound_exact' | 'legacy_unbound' | 'denied') => { ninEligibility = value; } };
}

describe('QoreID verification service', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not call QoreID while disabled, but records only a disabled evidence state', async () => {
    const { service, provider, query } = setup(false);
    await expect(service.verifyPatientNin(patientRequest, '12345678901'))
      .rejects.toMatchObject({ code: 'QOREID_DISABLED', status: 503 });
    expect(provider.verifyNin).not.toHaveBeenCalled();
    expect(query.mock.calls[1]?.[1]).toEqual([
      'patient:subject', patientRequest.actor!.sessionId, 'disabled', null, 'disabled', null,
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toContain('12345678901');
  });

  it('stops new verification when QoreID is paused without changing existing patient state', async () => {
    const { service, provider, integrations, query } = setup(true);
    (integrations.assertAvailable as jest.Mock).mockRejectedValue(
      new DomainProblem(503, 'INTEGRATION_PAUSED', 'External verification is temporarily unavailable'));
    await expect(service.verifyPatientNin(patientRequest, '12345678901'))
      .rejects.toMatchObject({ code: 'INTEGRATION_PAUSED', status: 503 });
    expect(provider.verifyNin).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('record_my_nin_verification_evidence'))).toBe(true);
  });

  it('returns a normalized result only after the session-bound evidence command succeeds', async () => {
    const { service, provider, integrations, query } = setup(true);
    await expect(service.verifyPatientNin(patientRequest, '12345678901')).resolves.toEqual({
      entityType: 'patient', verificationType: 'nin', provider: 'qoreid', state: 'verified',
      providerReference: '99', recordedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(provider.verifyNin).toHaveBeenCalledWith('12345678901', {
      firstName: 'Samplefirst', lastName: 'Samplelast', dateOfBirth: '1991-03-04',
    });
    expect(integrations.consumePatientQuota).toHaveBeenCalledWith(patientRequest.correlationId,
      'patient:subject', patientRequest.actor!.sessionId);
    const bindingCall = query.mock.calls.find(([sql]) => sql.includes('bind_my_verified_nin'));
    expect(bindingCall?.[1]).toEqual([
      'patient:subject', patientRequest.actor!.sessionId, expect.any(String), 'a'.repeat(64),
      Buffer.alloc(32, 1), 'test-v1', '8901', '99', Buffer.alloc(64, 2), 'b'.repeat(64),
    ]);
    expect(JSON.stringify(bindingCall?.[1])).not.toContain('12345678901');
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
    const evidenceCall = query.mock.calls.find(([sql]) => sql.includes('record_my_nin_verification_evidence'));
    expect(evidenceCall?.[1]).toEqual([
      'patient:subject', patientRequest.actor!.sessionId, 'provider_error', null, 'timeout', null,
    ]);
  });

  it('does not call QoreID when the canonical patient lacks a complete identity profile', async () => {
    const { service, provider, integrations, setProfileDateOfBirth } = setup(true);
    setProfileDateOfBirth(null);
    await expect(service.verifyPatientNin(patientRequest, '12345678901'))
      .rejects.toMatchObject({ code: 'PATIENT_IDENTITY_PROFILE_INCOMPLETE', status: 422 });
    expect(provider.verifyNin).not.toHaveBeenCalled();
    expect(integrations.consumePatientQuota).not.toHaveBeenCalled();
  });

  it('binds an unbound active legacy patient only after exact QoreID verification', async () => {
    const { service, provider, query, setNinEligibility } = setup(true);
    setNinEligibility('legacy_unbound');
    await expect(service.verifyPatientNin(patientRequest, '12345678901')).resolves.toMatchObject({ state: 'verified' });
    expect(provider.verifyNin).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => sql.includes('bind_my_verified_nin'))).toBe(true);
  });

  it('rejects a verified provider result with a different returned NIN before binding', async () => {
    const { service, provider, query, setNinEligibility } = setup(true);
    setNinEligibility('legacy_unbound');
    (provider.verifyNin as jest.Mock).mockResolvedValueOnce({ provider: 'qoreid', state: 'verified',
      providerReference: '99', ninBinding: { nin: '98765432109', firstName: 'Samplefirst',
        lastName: 'Samplelast', dateOfBirth: '1991-03-04' }, respondedAt: new Date().toISOString() });
    await expect(service.verifyPatientNin(patientRequest, '12345678901'))
      .rejects.toMatchObject({ code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
    expect(query.mock.calls.some(([sql]) => sql.includes('bind_my_verified_nin'))).toBe(false);
  });

  it('does not call QoreID for a NIN conflict or an ineligible patient', async () => {
    const { service, provider, integrations, query, setNinEligibility } = setup(true);
    setNinEligibility('denied');
    await expect(service.verifyPatientNin(patientRequest, '12345678901'))
      .rejects.toMatchObject({ code: 'PATIENT_NIN_BINDING_CONFLICT', status: 409 });
    expect(provider.verifyNin).not.toHaveBeenCalled();
    expect(integrations.consumePatientQuota).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('record_my_nin_verification_evidence'))).toBe(false);
  });

  it('leaves legacy identity unbound when QoreID returns no verified match', async () => {
    const { service, provider, query, setNinEligibility } = setup(true);
    setNinEligibility('legacy_unbound');
    (provider.verifyNin as jest.Mock).mockResolvedValueOnce({ provider: 'qoreid', state: 'not_verified',
      providerReference: '100', respondedAt: new Date().toISOString() });
    await expect(service.verifyPatientNin(patientRequest, '12345678901')).resolves.toMatchObject({ state: 'not_verified' });
    expect(query.mock.calls.some(([sql]) => sql.includes('bind_my_verified_nin'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('record_my_nin_verification_evidence'))).toBe(true);
  });

  it('keeps an existing identity unchanged when the binding key or quota gate is unavailable', async () => {
    const { service, provider, integrations, ninProtector, query } = setup(true);
    (ninProtector.lookup as jest.Mock).mockImplementationOnce(() => {
      throw new DomainProblem(503, 'NIN_PROTECTION_UNAVAILABLE', 'NIN protection is unavailable');
    });
    await expect(service.verifyPatientNin(patientRequest, '12345678901'))
      .rejects.toMatchObject({ code: 'NIN_PROTECTION_UNAVAILABLE', status: 503 });
    (integrations.consumePatientQuota as jest.Mock).mockRejectedValueOnce(
      new DomainProblem(503, 'VERIFICATION_QUOTA_UNAVAILABLE', 'Quota gate unavailable'));
    await expect(service.verifyPatientNin(patientRequest, '12345678901'))
      .rejects.toMatchObject({ code: 'VERIFICATION_QUOTA_UNAVAILABLE', status: 503 });
    expect(provider.verifyNin).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('record_my_nin_verification_evidence'))).toBe(false);
  });

  it('returns 429 without provider call or verification evidence when patient quota is exhausted', async () => {
    const { service, provider, integrations, query } = setup(true);
    (integrations.consumePatientQuota as jest.Mock).mockRejectedValue(
      new DomainProblem(429, 'VERIFICATION_QUOTA_EXCEEDED', 'Verification limit reached'));
    await expect(service.verifyPatientNin(patientRequest, '12345678901'))
      .rejects.toMatchObject({ status: 429, code: 'VERIFICATION_QUOTA_EXCEEDED' });
    expect(provider.verifyNin).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('record_my_nin_verification_evidence'))).toBe(false);
  });

  it('uses the reusable CAC path and lets the membership-bound command select the existing organization', async () => {
    const { service, provider, database, integrations } = setup(true);
    const organizationQuery = jest.fn(async (sql: string, _values?: unknown[]) => sql.includes('current_organization_cac_binding_matches')
      ? { rows: [{ matched: true }] }
      : { rows: [{ evidenceId: 'a0000000-0000-4000-8000-000000000005',
        recordedAt: new Date('2026-01-01T00:00:00.000Z') }] });
    (database.withTransaction as jest.Mock).mockImplementation(async (
      _context: unknown,
      operation: (value: PoolClient) => Promise<unknown>,
    ) => operation({ query: organizationQuery } as unknown as PoolClient));
    (provider.verifyCac as jest.Mock).mockResolvedValue({
      provider: 'qoreid', state: 'verified', providerReference: '71',
      verifiedRegistrationNumber: 'RC1234', respondedAt: new Date().toISOString(),
      cacBinding: { registrationNumber: 'RC1234', providerRegistrationNumber: '1234', companyName: 'Existing organization',
        entityType: 'Private Limited', registrationDate: '2001-01-01',
        address: '123 Registry Street, Lagos', registryStatus: 'Active' },
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
      providerReference: '71', providerVerification: 'verified', recordedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(provider.verifyCac).toHaveBeenCalledWith('RC1234');
    expect(integrations.consumeQuota).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({ accountId: 'a0000000-0000-4000-8000-000000000007' }),
    }), 'existing_cac', 'a0000000-0000-4000-8000-000000000009');
    expect(organizationQuery.mock.calls[0]?.[0]).toContain('current_organization_cac_binding_matches');
    expect(organizationQuery.mock.calls[0]?.[1]).toEqual([
      'hospital', 'RC1234', 'Existing organization', 'Private Limited',
      '2001-01-01', '123 Registry Street, Lagos', 'active',
    ]);
    expect(organizationQuery.mock.calls[1]?.[0]).toContain('record_organization_cac_verification_evidence');
    expect(organizationQuery.mock.calls[1]?.[1]).toEqual(['hospital', 'verified', '71', null]);
    expect(JSON.stringify(organizationQuery.mock.calls)).not.toContain('a0000000-0000-4000-8000-000000000009');

  });

  it('records an incomplete existing-organization CAC check without changing its legal binding', async () => {
    const { service, provider, database } = setup(true);
    const organizationQuery = jest.fn().mockResolvedValue({ rows: [{
      evidenceId: 'a0000000-0000-4000-8000-000000000005',
      recordedAt: new Date('2026-01-01T00:00:00.000Z'),
    }] });
    (database.withTransaction as jest.Mock).mockImplementation(async (
      _context: unknown, operation: (value: PoolClient) => Promise<unknown>,
    ) => operation({ query: organizationQuery } as unknown as PoolClient));
    (provider.verifyCac as jest.Mock).mockResolvedValue({ provider: 'qoreid', state: 'verified',
      providerReference: '8643', verifiedRegistrationNumber: 'RC1234',
      respondedAt: new Date().toISOString(),
      cacIncompleteProfile: { submittedRegistrationNumber: 'RC1234',
        metadataCompanyType: 'limited_company', address: 'Synthetic Registry Office' } });
    const request = {
      correlationId: 'qoreid-cac-incomplete-test',
      facilityId: 'a0000000-0000-4000-8000-000000000006',
      actor: { kind: 'staff', accountId: 'a0000000-0000-4000-8000-000000000007',
        subject: 'staff:subject', roles: ['admin'], permissions: ['organization.manage'],
        facility: { id: 'a0000000-0000-4000-8000-000000000006',
          organizationId: 'a0000000-0000-4000-8000-000000000009' } },
      header: () => undefined,
    } as unknown as HidRequest;
    await expect(service.verifyOrganizationCac(request, 'hospital', 'RC1234')).resolves.toEqual({
      entityType: 'organization', verificationType: 'cac', provider: 'qoreid',
      state: 'incomplete', providerVerification: 'verified', providerReference: '8643',
      recordedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(organizationQuery).toHaveBeenCalledTimes(1);
    expect(organizationQuery.mock.calls[0]?.[0]).toContain('record_organization_cac_verification_evidence');
    expect(organizationQuery.mock.calls[0]?.[1]).toEqual(['hospital', 'incomplete', '8643', 'incomplete']);
    expect(JSON.stringify(organizationQuery.mock.calls)).not.toContain('Synthetic Registry Office');
  });
});
