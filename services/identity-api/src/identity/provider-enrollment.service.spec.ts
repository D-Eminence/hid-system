import type { ArgumentsHost } from '@nestjs/common';
import * as environment from '../config/environment';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import type { OrganizationProfileCompletionService } from './organization-profile-completion.service';
import type { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import { ProviderEnrollmentService, quotaNetwork } from './provider-enrollment.service';

const applicationId = 'a0000000-0000-4000-8000-000000000071';
const input = {
  productCode: 'ehr' as const, organizationType: 'clinic' as const, cacRegistrationNumber: 'RC1234567',
  administratorName: 'Synthetic Provider Admin', administratorEmail: 'provider@example.invalid',
  turnstileAction: 'provider-enrollment' as const, turnstileToken: 'opaque-proof',
};

function setup(options: { quota?: jest.Mock } = {}) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('submit_self_service_organization_application')) {
      return { rows: [{ application_id: applicationId }] };
    }
    if (sql.includes('public_get_organization_application')) {
      return { rows: [{ application_id: applicationId, application_status: 'pending_verification',
        verification_result: null, provider_verified_registration_number: null, row_version: '1' }] };
    }
    return { rows: [{ application_status: 'pending_verification', row_version: '2' }] };
  });
  const database = { withSystemTransaction: jest.fn(async (_correlation, work) => work({ query })) };
  const integrations = {
    assertAvailable: jest.fn().mockResolvedValue(undefined),
    consumeSelfServiceCacQuota: options.quota ?? jest.fn().mockResolvedValue(undefined),
    consumeQuotaWithClient: jest.fn(),
    consumeQuota: jest.fn(),
  };
  const qoreid = { verifyCac: jest.fn().mockResolvedValue({ state: 'not_verified', providerReference: '990071' }) };
  const completion = { start: jest.fn() };
  const service = new ProviderEnrollmentService(database as unknown as DatabaseService,
    integrations as unknown as IntegrationRuntimeService, qoreid as unknown as QoreIdVerificationAdapter,
    completion as unknown as OrganizationProfileCompletionService);
  return { service, query, database, integrations, qoreid, completion };
}

const request = (ip: string | undefined) =>
  ({ ip, correlationId: 'provider-enrollment-test', header: () => undefined }) as unknown as HidRequest;

describe('accountless provider CAC quota network', () => {
  it('keys IPv4 by address and IPv6 by its /64 allocation', () => {
    expect(quotaNetwork('203.0.113.44')).toBe('203.0.113.44');
    expect(quotaNetwork('::ffff:203.0.113.44')).toBe('203.0.113.44');
    expect(quotaNetwork('0:0:0:0:0:ffff:cb00:712c')).toBe('203.0.113.44');
    expect(quotaNetwork('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(quotaNetwork('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(quotaNetwork('2001:db8:1:2:3:4:192.0.2.1')).toBe('2001:db8:1:2::/64');
    expect(quotaNetwork('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(quotaNetwork('::1')).toBe('0:0:0:0::/64');
    expect(quotaNetwork('2001:db8:1:3::1')).not.toBe(quotaNetwork('2001:db8:1:2::1'));
  });

  it('has no network for a missing or non-IP address', () => {
    for (const value of [undefined, '', 'localhost', '203.0.113.256', '2001:db8::1::2', 'x'.repeat(64)]) {
      expect(quotaNetwork(value)).toBeNull();
    }
  });
});

describe('accountless provider CAC lookup quota', () => {
  beforeEach(() => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({
      NODE_ENV: 'test', QOREID_ENABLED: true, OTP_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
    } as environment.Environment);
  });
  afterEach(() => jest.restoreAllMocks());

  it('charges the self-service quota with a keyed network digest, never the reviewer quota', async () => {
    const { service, integrations, qoreid } = setup();
    const digests: string[] = [];
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2:ffff::9', '2001:db8:1:3::1', '203.0.113.44']) {
      await expect(service.start(input, request(ip))).rejects.toMatchObject({ status: 422, code: 'CAC_NOT_VERIFIED' });
      const call = integrations.consumeSelfServiceCacQuota.mock.calls.at(-1) as string[];
      expect(call[0]).toBe('provider-enrollment-test');
      expect(call[1]).toBe(applicationId);
      expect(call[2]).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(call)).not.toContain(ip);
      digests.push(call[2]!);
    }
    expect(digests[0]).toBe(digests[1]);
    expect(new Set(digests).size).toBe(3);
    expect(qoreid.verifyCac).toHaveBeenCalledTimes(4);
    expect(integrations.consumeQuotaWithClient).not.toHaveBeenCalled();
    expect(integrations.consumeQuota).not.toHaveBeenCalled();
  });

  it('makes no QoreID request and records no result when the quota refuses', async () => {
    const quota = jest.fn().mockRejectedValue(new DomainProblem(429, 'VERIFICATION_QUOTA_EXCEEDED',
      'Verification request limit reached; try again later'));
    const { service, query, qoreid, completion } = setup({ quota });
    await expect(service.start(input, request('203.0.113.44')))
      .rejects.toMatchObject({ status: 429, code: 'VERIFICATION_QUOTA_EXCEEDED' });
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
    expect(completion.start).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('public_record_organization_cac_result'))).toBe(false);
  });

  it('in production, refuses a client address inside TRUST_PROXY_CIDRS before writing anything (IP-1)', async () => {
    // Without the edge's client address, request.ip is the load balancer: one
    // network for every client, so the quota must not be charged to it.
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({
      NODE_ENV: 'production', QOREID_ENABLED: true, OTP_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
      TRUST_PROXY_CIDRS: '10.40.0.0/16',
    } as environment.Environment);
    const { service, database, qoreid } = setup();
    for (const ip of ['10.40.1.10', '::ffff:10.40.9.9']) {
      await expect(service.start(input, request(ip)))
        .rejects.toMatchObject({ status: 503, code: 'PROVIDER_ENROLLMENT_RATE_LIMIT_UNAVAILABLE' });
    }
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
    await expect(service.start(input, request('203.0.113.44'))).rejects.toMatchObject({ status: 422, code: 'CAC_NOT_VERIFIED' });
  });

  it('fails closed before writing anything without a usable client network or production key', async () => {
    const { service, database, qoreid } = setup();
    for (const ip of [undefined, 'not-an-address']) {
      await expect(service.start(input, request(ip)))
        .rejects.toMatchObject({ status: 503, code: 'PROVIDER_ENROLLMENT_RATE_LIMIT_UNAVAILABLE' });
    }
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({
      NODE_ENV: 'production', QOREID_ENABLED: true,
    } as environment.Environment);
    await expect(service.start(input, request('203.0.113.44')))
      .rejects.toMatchObject({ status: 503, code: 'PROVIDER_ENROLLMENT_RATE_LIMIT_UNAVAILABLE' });
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
  });
});

describe('a verified CAC lookup without a usable legal profile', () => {
  beforeEach(() => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({
      NODE_ENV: 'test', QOREID_ENABLED: true, OTP_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
    } as environment.Environment);
  });
  afterEach(() => jest.restoreAllMocks());

  const sparseDetail = "We could not read your organization's full registration details from the CAC record,"
    + ' so it cannot be registered automatically. Contact Health ID support.';
  const recorded = (query: jest.Mock) =>
    query.mock.calls.some(([sql]) => String(sql).includes('public_record_organization_cac_result'));

  it('answers a sparse record 409 PROVIDER_CAC_PROFILE_INCOMPLETE, records nothing and sends no code', async () => {
    const { service, query, integrations, qoreid, completion } = setup();
    // The QoreID sandbox shape: the lookup is verified, but name, type, date and status are empty.
    qoreid.verifyCac.mockResolvedValue({ state: 'verified', providerReference: '990072',
      verifiedRegistrationNumber: input.cacRegistrationNumber,
      cacIncompleteProfile: { submittedRegistrationNumber: input.cacRegistrationNumber,
        address: '1 Synthetic Registry Road, Lagos', metadataCompanyType: 'Private' } });
    const refused = service.start(input, request('203.0.113.44'));
    await expect(refused).rejects.toBeInstanceOf(DomainProblem);
    await expect(refused).rejects.toMatchObject({ status: 409, code: 'PROVIDER_CAC_PROFILE_INCOMPLETE',
      message: sparseDetail });
    // One lookup, charged once, as before; nothing new is recorded.
    expect(qoreid.verifyCac).toHaveBeenCalledTimes(1);
    expect(integrations.consumeSelfServiceCacQuota).toHaveBeenCalledTimes(1);
    expect(recorded(query)).toBe(false);
    expect(completion.start).not.toHaveBeenCalled();
  });

  it('keeps 502 QOREID_PROVIDER_RESPONSE_INVALID for a verified answer that is malformed', async () => {
    const malformed = [
      // Verified, with neither a binding nor a sparse profile.
      { state: 'verified', providerReference: '990073', verifiedRegistrationNumber: input.cacRegistrationNumber },
      // A sparse profile for another registration number.
      { state: 'verified', providerReference: '990074', verifiedRegistrationNumber: 'RC7654321',
        cacIncompleteProfile: { submittedRegistrationNumber: 'RC7654321', address: '1 Synthetic Registry Road, Lagos' } },
      // A sparse profile without a numeric provider reference.
      { state: 'verified', providerReference: 'not-numeric', verifiedRegistrationNumber: input.cacRegistrationNumber,
        cacIncompleteProfile: { submittedRegistrationNumber: input.cacRegistrationNumber } },
      // A full binding that does not pass validation (a registration date in the future).
      { state: 'verified', providerReference: '990075', verifiedRegistrationNumber: input.cacRegistrationNumber,
        cacBinding: { registrationNumber: input.cacRegistrationNumber, companyName: 'Synthetic Clinic Ltd',
          entityType: 'Private Company', registrationDate: '2999-01-01',
          address: '1 Synthetic Registry Road, Lagos', registryStatus: 'active' } },
    ];
    for (const answer of malformed) {
      const { service, query, qoreid, completion } = setup();
      qoreid.verifyCac.mockResolvedValue(answer);
      await expect(service.start(input, request('203.0.113.44')))
        .rejects.toMatchObject({ status: 502, code: 'QOREID_PROVIDER_RESPONSE_INVALID' });
      expect(recorded(query)).toBe(false);
      expect(completion.start).not.toHaveBeenCalled();
    }
  });

  it('passes the sparse-record detail to the client unchanged', async () => {
    const { service, qoreid } = setup();
    qoreid.verifyCac.mockResolvedValue({ state: 'verified', providerReference: '990076',
      verifiedRegistrationNumber: input.cacRegistrationNumber,
      cacIncompleteProfile: { submittedRegistrationNumber: input.cacRegistrationNumber } });
    const problem = await service.start(input, request('203.0.113.44')).catch((error: unknown) => error);
    const json = jest.fn();
    const response = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(), json };
    const host = { switchToHttp: () => ({ getRequest: () => request('203.0.113.44'), getResponse: () => response }) };
    new ProblemDetailsFilter().catch(problem, host as unknown as ArgumentsHost);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 409,
      code: 'PROVIDER_CAC_PROFILE_INCOMPLETE', detail: sparseDetail }));
  });
});
