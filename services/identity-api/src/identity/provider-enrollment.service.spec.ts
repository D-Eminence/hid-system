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
const applicationDigest = 'b'.repeat(64);
const input = {
  productCode: 'ehr' as const, organizationType: 'clinic' as const, cacRegistrationNumber: 'RC1234567',
  administratorName: 'Synthetic Provider Admin', administratorEmail: 'provider@example.invalid',
  turnstileAction: 'provider-enrollment' as const, turnstileToken: 'opaque-proof',
};
const openControls = { self_service: true, provider_portal: true, maintenance: false };
const testEnvironment = (overrides: Partial<environment.Environment> = {}) => ({
  NODE_ENV: 'test', QOREID_ENABLED: true, OTP_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
  PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP: 200, ...overrides,
} as environment.Environment);

function setup(options: { quota?: jest.Mock; controls?: jest.Mock } = {}) {
  const query = jest.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (sql.includes('submit_self_service_organization_application')) {
      return { rows: [{ application_id: applicationId }] };
    }
    if (sql.includes('public_get_organization_application')) {
      return { rows: [{ application_id: applicationId, application_status: 'pending_verification',
        verification_result: null, provider_verified_registration_number: null, row_version: '1' }] };
    }
    return { rows: [{ application_status: 'pending_verification', row_version: '2' }] };
  });
  const database = {
    withSystemTransaction: jest.fn(async (_correlation, work) => work({ query })),
    query: options.controls ?? jest.fn().mockResolvedValue({ rows: [openControls] }),
  };
  const integrations = {
    assertAvailable: jest.fn().mockResolvedValue(undefined),
    consumeSelfServiceCacQuota: options.quota ?? jest.fn().mockResolvedValue(undefined),
    consumeQuotaWithClient: jest.fn(),
    consumeQuota: jest.fn(),
  };
  const qoreid = { verifyCac: jest.fn().mockResolvedValue({ state: 'not_verified', providerReference: '990071' }) };
  const completion = {
    start: jest.fn().mockResolvedValue({ accepted: true, challengeId: 'c0000000-0000-4000-8000-000000000071' }),
    publicApplicationDigest: jest.fn().mockReturnValue(applicationDigest),
    publicApplicationNetworkDigest: jest.fn().mockReturnValue(applicationDigest),
  };
  const service = new ProviderEnrollmentService(database as unknown as DatabaseService,
    integrations as unknown as IntegrationRuntimeService, qoreid as unknown as QoreIdVerificationAdapter,
    completion as unknown as OrganizationProfileCompletionService);
  return { service, query, database, integrations, qoreid, completion };
}

const request = (ip: string | undefined) =>
  ({ ip, correlationId: 'provider-enrollment-test', header: () => undefined }) as unknown as HidRequest;
const sqlCalls = (query: jest.Mock) => query.mock.calls.map(([sql]) => String(sql));

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
    jest.spyOn(environment, 'getEnvironment').mockReturnValue(testEnvironment());
  });
  afterEach(() => jest.restoreAllMocks());

  it('charges the self-service quota with a keyed network digest and the daily cap, never the reviewer quota', async () => {
    const { service, integrations, qoreid } = setup();
    const digests: string[] = [];
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2:ffff::9', '2001:db8:1:3::1', '203.0.113.44']) {
      await expect(service.start(input, request(ip))).rejects.toMatchObject({ status: 422, code: 'CAC_NOT_VERIFIED' });
      const call = integrations.consumeSelfServiceCacQuota.mock.calls.at(-1) as [string, string, string, number];
      expect(call[0]).toBe('provider-enrollment-test');
      expect(call[1]).toBe(applicationId);
      expect(call[2]).toMatch(/^[a-f0-9]{64}$/);
      expect(call[3]).toBe(200);
      expect(JSON.stringify(call)).not.toContain(ip);
      digests.push(call[2]);
    }
    expect(digests[0]).toBe(digests[1]);
    expect(new Set(digests).size).toBe(3);
    expect(qoreid.verifyCac).toHaveBeenCalledTimes(4);
    expect(integrations.consumeQuotaWithClient).not.toHaveBeenCalled();
    expect(integrations.consumeQuota).not.toHaveBeenCalled();
  });

  it('passes the configured platform daily cap to the quota command', async () => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue(
      testEnvironment({ PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP: 37 }));
    const { service, integrations } = setup();
    await expect(service.start(input, request('203.0.113.44'))).rejects.toMatchObject({ code: 'CAC_NOT_VERIFIED' });
    expect(integrations.consumeSelfServiceCacQuota).toHaveBeenCalledWith('provider-enrollment-test',
      applicationId, expect.stringMatching(/^[a-f0-9]{64}$/), 37);
  });

  it('makes no QoreID request and records no result when the quota refuses (including the platform day)', async () => {
    const quota = jest.fn().mockRejectedValue(new DomainProblem(429, 'VERIFICATION_QUOTA_EXCEEDED',
      'Verification request limit reached; try again later'));
    const { service, query, qoreid, completion } = setup({ quota });
    await expect(service.start(input, request('203.0.113.44')))
      .rejects.toMatchObject({ status: 429, code: 'VERIFICATION_QUOTA_EXCEEDED' });
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
    expect(completion.start).not.toHaveBeenCalled();
    expect(sqlCalls(query).some((sql) => sql.includes('public_record_organization_cac_result'))).toBe(false);
  });

  it('fails closed before writing anything without a usable client network or production key', async () => {
    const { service, database, qoreid } = setup();
    for (const ip of [undefined, 'not-an-address']) {
      await expect(service.start(input, request(ip)))
        .rejects.toMatchObject({ status: 503, code: 'PROVIDER_ENROLLMENT_RATE_LIMIT_UNAVAILABLE' });
    }
    jest.spyOn(environment, 'getEnvironment').mockReturnValue(
      testEnvironment({ NODE_ENV: 'production', OTP_HMAC_KEY_B64: undefined }));
    await expect(service.start(input, request('203.0.113.44')))
      .rejects.toMatchObject({ status: 503, code: 'PROVIDER_ENROLLMENT_RATE_LIMIT_UNAVAILABLE' });
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
  });
});

describe('the public application quota is charged once per start (CRITIC C8, review fix R4)', () => {
  beforeEach(() => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue(testEnvironment());
  });
  afterEach(() => jest.restoreAllMocks());

  // The statements each system transaction ran, in order.
  const transactions = (context: ReturnType<typeof setup>) => {
    const grouped: string[][] = [];
    context.database.withSystemTransaction.mockImplementation(async (_correlation, work) => {
      const statements: string[] = [];
      grouped.push(statements);
      return work({ query: async (sql: string, values?: readonly unknown[]) => {
        statements.push(sql);
        return context.query(sql, values);
      } });
    });
    return grouped;
  };

  it('charges it first, in its own committed transaction, then submits, and tells the email step it is charged', async () => {
    const context = setup();
    const { service, query, completion, qoreid } = context;
    const grouped = transactions(context);
    qoreid.verifyCac.mockResolvedValue({ state: 'verified', providerReference: '990070',
      verifiedRegistrationNumber: input.cacRegistrationNumber,
      cacBinding: { registrationNumber: input.cacRegistrationNumber, providerRegistrationNumber: '1234567',
        companyName: 'Synthetic Clinic Ltd', entityType: 'Private Company Limited by Shares',
        registrationDate: '2021-01-01', address: '1 Synthetic Registry Road, Lagos', registryStatus: 'ACTIVE' } });
    await expect(service.start(input, request('203.0.113.44'))).resolves.toMatchObject({ accepted: true });
    const calls = sqlCalls(query);
    expect(calls.filter((sql) => sql.includes('consume_public_application_quota'))).toHaveLength(1);
    expect(query.mock.calls[0]?.[1]).toEqual([applicationDigest]);
    // The charge is its own transaction; the submit is the next one.
    expect(grouped[0]).toEqual(['select platform.consume_public_application_quota($1)']);
    expect(grouped[1]).toHaveLength(1);
    expect(grouped[1]?.[0]).toContain('submit_self_service_organization_application($1,$2,$3,$4,$5,$6)');
    expect(completion.publicApplicationNetworkDigest).toHaveBeenCalledWith('203.0.113.44');
    expect(completion.publicApplicationDigest).not.toHaveBeenCalled();
    expect(completion.start).toHaveBeenCalledTimes(1);
    expect(completion.start).toHaveBeenCalledWith(expect.objectContaining({
      productCode: 'ehr', cacRegistrationNumber: 'RC1234567', turnstileAction: 'organization-completion' }),
    '203.0.113.44', 'provider-enrollment-test', { publicApplicationQuotaCharged: true,
      selfService: { administratorName: 'Synthetic Provider Admin', organizationType: 'clinic' } });
  });

  it('keeps the charge when the submit refuses the start (409), so probing which CACs have applications costs quota', async () => {
    const context = setup();
    const committed: string[] = [];
    context.database.withSystemTransaction.mockImplementation(async (_correlation, work) => {
      const statements: string[] = [];
      const result = await work({ query: async (sql: string, values?: readonly unknown[]) => {
        statements.push(sql);
        return context.query(sql, values);
      } });
      committed.push(...statements);
      return result;
    });
    context.query.mockImplementation(async (sql: string) => {
      if (sql.includes('submit_self_service_organization_application')) {
        throw Object.assign(new Error('This organization application requires manual resolution'), { code: '23514' });
      }
      return { rows: [] };
    });
    await expect(context.service.start(input, request('203.0.113.44')))
      .rejects.toMatchObject({ status: 409, code: 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW' });
    expect(committed).toEqual(['select platform.consume_public_application_quota($1)']);
    expect(context.qoreid.verifyCac).not.toHaveBeenCalled();
  });

  it('keys the charge, and the application\'s network, by the client network: an IPv6 /64, an IPv4 address', async () => {
    const { service, query, completion, integrations } = setup();
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2:ffff::9', '203.0.113.44']) {
      await expect(service.start(input, request(ip))).rejects.toMatchObject({ code: 'CAC_NOT_VERIFIED' });
    }
    expect(completion.publicApplicationNetworkDigest.mock.calls.map(([network]) => network))
      .toEqual(['2001:db8:1:2::/64', '2001:db8:1:2::/64', '203.0.113.44']);
    // The submit stores the same keyed network digest the CAC lookup is charged to.
    const submitted = query.mock.calls.filter(([sql]) => String(sql).includes('submit_self_service_organization_application'))
      .map(([, values]) => (values as unknown[])[5]);
    const charged = integrations.consumeSelfServiceCacQuota.mock.calls.map((call) => call[2]);
    expect(submitted).toEqual(charged);
    expect(submitted[0]).toBe(submitted[1]);
    expect(submitted[0]).not.toBe(submitted[2]);
    for (const digest of submitted) expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('charges it once on the resume path too, with no QoreID lookup', async () => {
    const { service, query, integrations, qoreid, completion } = setup();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('submit_self_service_organization_application')) return { rows: [{ application_id: applicationId }] };
      if (sql.includes('public_get_organization_application')) {
        return { rows: [{ application_id: applicationId, application_status: 'ready_for_review',
          verification_result: 'verified', provider_verified_registration_number: 'RC1234567', row_version: '3' }] };
      }
      return { rows: [] };
    });
    await expect(service.start(input, request('203.0.113.44'))).resolves.toMatchObject({ accepted: true });
    expect(sqlCalls(query).filter((sql) => sql.includes('consume_public_application_quota'))).toHaveLength(1);
    expect(integrations.consumeSelfServiceCacQuota).not.toHaveBeenCalled();
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
    expect(completion.start).toHaveBeenCalledWith(expect.anything(), '203.0.113.44', 'provider-enrollment-test',
      { publicApplicationQuotaCharged: true,
        selfService: { administratorName: 'Synthetic Provider Admin', organizationType: 'clinic' } });
  });

  it('answers an exhausted public application quota 429 APPLICATION_RATE_LIMITED with no submit or QoreID', async () => {
    const { service, query, integrations, qoreid, completion } = setup();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('consume_public_application_quota')) {
        throw Object.assign(new Error('APPLICATION_QUOTA_EXCEEDED'), { code: 'P4290' });
      }
      return { rows: [{ application_id: applicationId }] };
    });
    await expect(service.start(input, request('203.0.113.44')))
      .rejects.toMatchObject({ status: 429, code: 'APPLICATION_RATE_LIMITED' });
    expect(sqlCalls(query).some((sql) => sql.includes('submit_self_service_organization_application'))).toBe(false);
    expect(integrations.consumeSelfServiceCacQuota).not.toHaveBeenCalled();
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
    expect(completion.start).not.toHaveBeenCalled();
  });
});

describe('the facility self sign-up gate', () => {
  beforeEach(() => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue(testEnvironment());
  });
  afterEach(() => jest.restoreAllMocks());

  const nothingWritten = (context: ReturnType<typeof setup>) => {
    expect(context.database.withSystemTransaction).not.toHaveBeenCalled();
    expect(context.completion.publicApplicationDigest).not.toHaveBeenCalled();
    expect(context.completion.publicApplicationNetworkDigest).not.toHaveBeenCalled();
    expect(context.integrations.consumeSelfServiceCacQuota).not.toHaveBeenCalled();
    expect(context.integrations.assertAvailable).not.toHaveBeenCalled();
    expect(context.qoreid.verifyCac).not.toHaveBeenCalled();
    expect(context.completion.start).not.toHaveBeenCalled();
  };

  it('reads the three controls in one statement', async () => {
    const context = setup();
    await expect(context.service.assertSelfServiceOpen()).resolves.toBeUndefined();
    expect(context.database.query).toHaveBeenCalledTimes(1);
    const sql = String(context.database.query.mock.calls[0]?.[0]);
    for (const key of ['provider_self_service_enabled', 'provider_portal_enabled', 'maintenance_mode']) {
      expect(sql).toContain(`platform.control_enabled('${key}')`);
    }
  });

  it.each([
    ['the control is off', { ...openControls, self_service: false }],
    ['the provider portal is off', { ...openControls, provider_portal: false }],
    ['maintenance mode is on', { ...openControls, maintenance: true }],
    ['the controls are not answered', undefined],
  ])('answers 423 PROVIDER_ENROLLMENT_UNAVAILABLE when %s, before anything is written or charged', async (_label, row) => {
    const context = setup({ controls: jest.fn().mockResolvedValue({ rows: row ? [row] : [] }) });
    await expect(context.service.start(input, request('203.0.113.44')))
      .rejects.toMatchObject({ status: 423, code: 'PROVIDER_ENROLLMENT_UNAVAILABLE' });
    nothingWritten(context);
  });

  it.each([
    ['an unknown control key (Identity before the migration)', '22023', 'PLATFORM_CONTROL_INVALID'],
    ['a missing control row', '55000', 'PLATFORM_CONTROL_UNAVAILABLE'],
  ])('answers 423 for %s', async (_label, code, message) => {
    const context = setup({ controls: jest.fn().mockRejectedValue(Object.assign(new Error(message), { code })) });
    await expect(context.service.start(input, request('203.0.113.44')))
      .rejects.toMatchObject({ status: 423, code: 'PROVIDER_ENROLLMENT_UNAVAILABLE' });
    nothingWritten(context);
  });

  it('answers any other fault reading the controls 503 PROVIDER_ENROLLMENT_UNAVAILABLE', async () => {
    const context = setup({ controls: jest.fn().mockRejectedValue(new Error('private connection detail')) });
    const failure = await context.service.start(input, request('203.0.113.44')).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 503, code: 'PROVIDER_ENROLLMENT_UNAVAILABLE' });
    expect(JSON.stringify(failure)).not.toContain('private');
    nothingWritten(context);
  });

  it.each([null, 0, 100_001, 2.5, undefined])('stays closed (423) with an invalid daily cap (%p), without reading the controls',
    async (cap) => {
      jest.spyOn(environment, 'getEnvironment').mockReturnValue(
        testEnvironment({ PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP: cap as number }));
      const context = setup();
      await expect(context.service.start(input, request('203.0.113.44')))
        .rejects.toMatchObject({ status: 423, code: 'PROVIDER_ENROLLMENT_UNAVAILABLE' });
      expect(context.database.query).not.toHaveBeenCalled();
      nothingWritten(context);
    });

  it('checks QOREID_ENABLED after the gate', async () => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue(testEnvironment({ QOREID_ENABLED: false }));
    const open = setup();
    await expect(open.service.start(input, request('203.0.113.44')))
      .rejects.toMatchObject({ status: 503, code: 'QOREID_DISABLED' });
    nothingWritten(open);
    const closed = setup({ controls: jest.fn().mockResolvedValue({ rows: [{ ...openControls, self_service: false }] }) });
    await expect(closed.service.start(input, request('203.0.113.44')))
      .rejects.toMatchObject({ status: 423, code: 'PROVIDER_ENROLLMENT_UNAVAILABLE' });
  });

  it.each([
    ['55000', 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled', 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE'],
    ['55000', 'PLATFORM_CONTROL_UNAVAILABLE', 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE'],
    ['22023', 'PLATFORM_CONTROL_INVALID', 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE'],
    // Another control's refusal, or invalid input, keeps main's answer.
    ['55000', 'PLATFORM_CONTROL_DISABLED:break_glass_enabled', 503, 'PROVIDER_ENROLLMENT_UNAVAILABLE'],
    ['22023', 'Invalid provider enrollment', 503, 'PROVIDER_ENROLLMENT_UNAVAILABLE'],
  ])('maps the submit command\'s %s %s to %i %s', async (code, message, status, answer) => {
    const context = setup();
    context.query.mockImplementation(async (sql: string) => {
      if (sql.includes('submit_self_service_organization_application')) throw Object.assign(new Error(message), { code });
      return { rows: [] };
    });
    await expect(context.service.start(input, request('203.0.113.44'))).rejects.toMatchObject({ status, code: answer });
    expect(context.qoreid.verifyCac).not.toHaveBeenCalled();
    expect(context.completion.start).not.toHaveBeenCalled();
  });
});

describe('facility self sign-up availability', () => {
  beforeEach(() => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue(testEnvironment());
  });
  afterEach(() => jest.restoreAllMocks());

  it('is open when the gate, QoreID and its provider_cac runtime gate are open', async () => {
    const { service, integrations, database } = setup();
    await expect(service.availability()).resolves.toEqual({ open: true });
    expect(integrations.assertAvailable).toHaveBeenCalledWith('qoreid', 'provider_cac');
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['the control is off', () => setup({ controls: jest.fn().mockResolvedValue({ rows: [{ ...openControls, self_service: false }] }) })],
    ['maintenance mode is on', () => setup({ controls: jest.fn().mockResolvedValue({ rows: [{ ...openControls, maintenance: true }] }) })],
    ['the control is unknown', () => setup({ controls: jest.fn().mockRejectedValue(
      Object.assign(new Error('PLATFORM_CONTROL_INVALID'), { code: '22023' })) })],
    ['the control row is missing', () => setup({ controls: jest.fn().mockRejectedValue(
      Object.assign(new Error('PLATFORM_CONTROL_UNAVAILABLE'), { code: '55000' })) })],
    ['QoreID provider_cac is paused', () => {
      const context = setup();
      context.integrations.assertAvailable.mockRejectedValue(new DomainProblem(503, 'INTEGRATION_PAUSED', 'paused'));
      return context;
    }],
  ])('is closed (reason closed), never an error, when %s', async (_label, build) => {
    await expect(build().service.availability()).resolves.toEqual({ open: false, reason: 'closed' });
  });

  it.each([
    ['QOREID_ENABLED is false', { QOREID_ENABLED: false }],
    ['production has no OTP key', { NODE_ENV: 'production' as const, OTP_HMAC_KEY_B64: undefined }],
    ['the daily cap is invalid', { PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP: null }],
  ])('is closed (reason closed) when %s', async (_label, overrides) => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue(testEnvironment(overrides as Partial<environment.Environment>));
    await expect(setup().service.availability()).resolves.toEqual({ open: false, reason: 'closed' });
  });

  // R10: a fault is not "sign-up is closed"; the page says "try again shortly".
  it.each([
    ['the controls cannot be read', () => setup({ controls: jest.fn().mockRejectedValue(new Error('database down')) })],
    ['the QoreID runtime gate cannot be read', () => {
      const context = setup();
      context.integrations.assertAvailable.mockRejectedValue(
        new DomainProblem(503, 'INTEGRATION_UNAVAILABLE', 'Delivery provider is temporarily unavailable'));
      return context;
    }],
  ])('is unavailable (reason unavailable), never an error, when %s', async (_label, build) => {
    await expect(build().service.availability()).resolves.toEqual({ open: false, reason: 'unavailable' });
  });

  it('is unavailable when the configuration cannot be read', async () => {
    jest.spyOn(environment, 'getEnvironment').mockImplementation(() => { throw new Error('Invalid Identity service configuration'); });
    await expect(setup().service.availability()).resolves.toEqual({ open: false, reason: 'unavailable' });
  });
});

describe('a verified CAC lookup without a usable legal profile', () => {
  beforeEach(() => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue(testEnvironment());
  });
  afterEach(() => jest.restoreAllMocks());

  // True for a sparse record and for a complete record whose company is not
  // active: the adapter answers both with cacIncompleteProfile.
  const sparseDetail = 'We could not register your organization automatically from its CAC record.'
    + ' The record is missing details we need or does not show the company as active.'
    + ' Contact Health ID support.';
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

  it('answers a complete record whose company is not active the same way, with a detail true for it', async () => {
    const { service, query, integrations, qoreid, completion } = setup();
    // Every legal field is present; only the registry status is not active.
    qoreid.verifyCac.mockResolvedValue({ state: 'verified', providerReference: '990077',
      verifiedRegistrationNumber: input.cacRegistrationNumber,
      cacIncompleteProfile: { submittedRegistrationNumber: input.cacRegistrationNumber,
        providerRegistrationNumber: '1234567', companyName: 'Synthetic Clinic Ltd',
        entityType: 'Private Company Limited by Shares', registrationDate: '2021-01-01',
        address: '1 Synthetic Registry Road, Lagos', registryStatus: 'INACTIVE' } });
    const refused = service.start(input, request('203.0.113.44'));
    await expect(refused).rejects.toMatchObject({ status: 409, code: 'PROVIDER_CAC_PROFILE_INCOMPLETE',
      message: sparseDetail });
    // The detail does not claim the details could not be read.
    await expect(refused).rejects.not.toMatchObject({ message: expect.stringMatching(/could not read/i) });
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

describe('a database refusal when the application is submitted', () => {
  beforeEach(() => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue(testEnvironment());
  });
  afterEach(() => jest.restoreAllMocks());

  const refusing = (code: string, message: string) => {
    const context = setup();
    context.query.mockImplementation(async (sql: string) => {
      if (sql.includes('submit_self_service_organization_application')) {
        throw Object.assign(new Error(message), { code });
      }
      return { rows: [] };
    });
    return context;
  };

  it('answers a unique violation 409 PROVIDER_ENROLLMENT_REQUIRES_REVIEW, never an email answer', async () => {
    // Start makes no account check. Its only unique violation is another
    // application opened for the same CAC and product at the same moment
    // (organization_applications_open_cac_product_uq), for example through the
    // governed organization application.
    const { service, qoreid, integrations, completion } = refusing('23505',
      'duplicate key value violates unique constraint "organization_applications_open_cac_product_uq"');
    const refused = service.start(input, request('203.0.113.44'));
    await expect(refused).rejects.toMatchObject({ status: 409, code: 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW',
      message: 'This provider organization requires manual resolution' });
    await expect(refused).rejects.not.toMatchObject({ message: expect.stringMatching(/email/i) });
    expect(integrations.consumeSelfServiceCacQuota).not.toHaveBeenCalled();
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
    expect(completion.start).not.toHaveBeenCalled();
  });

  it('keeps the other submit refusals as they were', async () => {
    const cases: Array<[string, number, string]> = [
      ['23514', 409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW'],
      ['40001', 409, 'VERSION_CONFLICT'],
      ['42501', 403, 'PROVIDER_ENROLLMENT_DENIED'],
      ['22023', 503, 'PROVIDER_ENROLLMENT_UNAVAILABLE'],
    ];
    for (const [code, status, answer] of cases) {
      const { service, qoreid } = refusing(code, 'synthetic refusal');
      await expect(service.start(input, request('203.0.113.44'))).rejects.toMatchObject({ status, code: answer });
      expect(qoreid.verifyCac).not.toHaveBeenCalled();
    }
  });
});
