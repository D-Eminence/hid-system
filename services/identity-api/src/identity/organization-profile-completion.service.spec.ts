import type { Response } from 'express';
import * as passwordHash from '../auth/password-hash';
import * as environment from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { TurnstileService } from '../auth/turnstile.service';
import type { HidRequest } from '../common/request-context';
import { PublicOrganizationProfileCompletionController } from './organization-applications.controller';
import { OrganizationProfileCompletionService } from './organization-profile-completion.service';

const input = {
  productCode: 'ehr' as const, cacRegistrationNumber: ' RC1234567 ',
  administratorEmail: ' ADMIN@EXAMPLE.INVALID ',
  turnstileAction: 'organization-completion' as const, turnstileToken: 'opaque-proof',
};
const correlationId = 'completion-test';
const profileRow = {
  application_status: 'pending_verification', profile_state: 'incomplete', row_version: '3',
  product_code: 'ehr', cac_registration_number: 'RC1234567',
  profile_organization_name: null, profile_organization_name_source: null,
  profile_entity_type: null, profile_entity_type_source: null,
  profile_registration_date: null, profile_registration_date_source: null,
  profile_address: 'Synthetic Registry Office', profile_address_source: 'qoreid',
  profile_registry_status: null, profile_registry_status_source: null,
};

// Deliveries run after the response. Optional here so that these specs also
// run, and fail at their own assertions, against a service without them.
interface AfterResponseLifecycle {
  settleDeliveries?(): Promise<void>;
  beforeApplicationShutdown?(): Promise<void>;
}
const lifecycle = (service: OrganizationProfileCompletionService): AfterResponseLifecycle =>
  service as unknown as AfterResponseLifecycle;

describe('organization applicant profile completion', () => {
  beforeEach(() => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({
      NODE_ENV: 'test', OTP_HMAC_KEY_B64: Buffer.alloc(32, 9).toString('base64'),
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_COOKIE_SECURE: true,
    } as environment.Environment);
  });
  afterEach(() => jest.restoreAllMocks());

  it('gives the same response for eligible and unknown applications and sends only to the stored address', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ recipient_email: 'stored@example.invalid' }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ recipient_email: null }] });
    const database = { withSystemTransaction: jest.fn(async (_id, work) => work({ query })) };
    const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted' }) };
    const service = new OrganizationProfileCompletionService(database as unknown as DatabaseService,
      notification as unknown as NotificationOtpClient);
    const known = await service.start(input, '203.0.113.44', correlationId);
    const unknown = await service.start(input, '203.0.113.44', correlationId);
    expect(known).toEqual(expect.objectContaining({ accepted: true, challengeId: expect.any(String) }));
    expect(unknown).toEqual(expect.objectContaining({ accepted: true, challengeId: expect.any(String) }));
    expect(Object.keys(known)).toEqual(Object.keys(unknown));
    expect(query.mock.calls[0]?.[1]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(query.mock.calls[1]?.[1]).toEqual(['RC1234567', 'admin@example.invalid', 'ehr',
      known.challengeId, expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(notification.deliver).toHaveBeenCalledTimes(1);
    expect(notification.deliver).toHaveBeenCalledWith(expect.objectContaining({
      recipient: 'stored@example.invalid', purpose: 'EMAIL_VERIFY', channel: 'email',
      challengeId: known.challengeId, correlationId,
    }));
    expect(JSON.stringify(query.mock.calls[0])).not.toContain('203.0.113.44');
  });

  it('invalidates a challenge after a definite delivery failure', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ recipient_email: 'stored@example.invalid' }] })
      .mockResolvedValueOnce({ rows: [] });
    const database = { withSystemTransaction: jest.fn(async (_id, work) => work({ query })) };
    const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'definitive_failure' }) };
    const service = new OrganizationProfileCompletionService(database as unknown as DatabaseService,
      notification as unknown as NotificationOtpClient);
    const result = await service.start(input, '203.0.113.44', correlationId);
    await lifecycle(service).settleDeliveries?.();
    expect(result.accepted).toBe(true);
    expect(query.mock.calls[2]?.[0]).toContain('invalidate_organization_profile_completion_challenge');
    expect(query.mock.calls[2]?.[1]).toEqual([result.challengeId]);
  });

  it('answers an eligible application before its code is delivered, as it answers an unknown one', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ recipient_email: 'stored@example.invalid' }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ recipient_email: null }] })
      .mockResolvedValueOnce({ rows: [] });
    const database = { withSystemTransaction: jest.fn(async (_id, work) => work({ query })) };
    let release: (outcome: { outcome: string }) => void = () => undefined;
    const notification = { deliver: jest.fn(() => new Promise((resolve) => { release = resolve; })) };
    const service = new OrganizationProfileCompletionService(database as unknown as DatabaseService,
      notification as unknown as NotificationOtpClient);
    const answered: string[] = [];
    const known = service.start(input, '203.0.113.44', correlationId).then((result) => {
      answered.push('eligible'); return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const unknown = service.start(input, '203.0.113.45', correlationId).then((result) => {
      answered.push('unknown'); return result;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect({ answered: answered.sort() }).toEqual({ answered: ['eligible', 'unknown'] });
      expect(notification.deliver).toHaveBeenCalledTimes(1);
      let closed = false;
      const shutdown = lifecycle(service).beforeApplicationShutdown!().then(() => { closed = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      release({ outcome: 'definitive_failure' });
      await shutdown;
      expect(closed).toBe(true);
      expect(query.mock.calls[4]?.[0]).toContain('invalidate_organization_profile_completion_challenge');
      expect(query.mock.calls[4]?.[1]).toEqual([(await known).challengeId]);
    } finally {
      release({ outcome: 'definitive_failure' });
      await Promise.all([known, unknown]);
    }
  });

  it('requires an OTP before a sourced profile can be read or updated', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ verified: true }] })
      .mockResolvedValueOnce({ rows: [profileRow] })
      .mockResolvedValueOnce({ rows: [{ ...profileRow, application_status: 'ready_for_review',
        profile_state: 'complete', row_version: '4',
        profile_organization_name: 'Synthetic Clinic Ltd', profile_organization_name_source: 'user_provided',
        profile_entity_type: 'Private', profile_entity_type_source: 'user_provided',
        profile_registration_date: '2021-01-01', profile_registration_date_source: 'user_provided',
        profile_registry_status: 'active', profile_registry_status_source: 'user_provided' }] });
    const database = { withSystemTransaction: jest.fn(async (_id, work) => work({ query })) };
    const service = new OrganizationProfileCompletionService(database as unknown as DatabaseService,
      {} as NotificationOtpClient);
    await expect(service.verify('challenge', 'bad', correlationId)).rejects.toMatchObject({
      code: 'ORGANIZATION_COMPLETION_CODE_INVALID',
    });
    expect(query).not.toHaveBeenCalled();
    const verified = await service.verify('8ce75fc3-0bda-4300-b198-f5688df65d6c', '123456', correlationId);
    expect(verified).toMatchObject({ verified: true, cookie: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(query.mock.calls[0]?.[1]).toEqual(['8ce75fc3-0bda-4300-b198-f5688df65d6c',
      expect.stringMatching(/^[a-f0-9]{64}$/), expect.stringMatching(/^[a-f0-9]{64}$/)]);
    await expect(service.current(undefined, correlationId)).rejects.toMatchObject({
      code: 'ORGANIZATION_COMPLETION_SESSION_INVALID',
    });
    const current = await service.current(verified.cookie, correlationId);
    expect(current.fields.address).toEqual({ value: 'Synthetic Registry Office', source: 'qoreid' });
    const completed = await service.complete(verified.cookie, 3, {
      companyName: 'Synthetic Clinic Ltd', entityType: 'Private',
      registrationDate: '2021-01-01', registryStatus: 'active',
    }, correlationId);
    expect(query.mock.calls[2]?.[1]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/), 3,
      'Synthetic Clinic Ltd', 'Private', '2021-01-01', null, 'active']);
    expect(completed).toMatchObject({ status: 'ready_for_review', profileState: 'complete', version: 4,
      fields: { companyName: { source: 'user_provided' }, address: { source: 'qoreid' } } });
  });

  it('enforces origin and Turnstile at start, and sets a restricted session cookie after OTP', async () => {
    const completion = { start: jest.fn().mockResolvedValue({ accepted: true }),
      verify: jest.fn().mockResolvedValue({ verified: true, cookie: 'session-token' }),
      current: jest.fn(), complete: jest.fn() };
    const turnstile = { verify: jest.fn().mockResolvedValue(undefined) };
    const controller = new PublicOrganizationProfileCompletionController(
      completion as unknown as OrganizationProfileCompletionService,
      turnstile as unknown as TurnstileService);
    const request = { correlationId, ip: '203.0.113.44',
      header: (name: string) => name === 'origin' ? 'https://www.healthidentitydirectory.com' : undefined,
    } as unknown as HidRequest;
    await expect(controller.start(input, request)).resolves.toEqual({ accepted: true });
    expect(turnstile.verify).toHaveBeenCalledWith(expect.objectContaining({
      action: 'organization-completion', remoteIp: request.ip,
    }));
    const response = { cookie: jest.fn() } as unknown as Response;
    await expect(controller.verify({ challengeId: 'challenge', code: '123456' }, request, response))
      .resolves.toEqual({ verified: true });
    expect(response.cookie).toHaveBeenCalledWith('hid_org_completion', 'session-token',
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'strict',
        path: '/api/v1/identity/organization-applications/completion' }));
    await expect(controller.start(input, { ...request, header: () => 'https://untrusted.invalid' } as unknown as HidRequest))
      .rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    expect(completion.start).toHaveBeenCalledTimes(1);
    expect(() => controller.save({}, undefined, request)).toThrow(expect.objectContaining({ code: 'IF_MATCH_REQUIRED' }));
  });
});

describe('facility self sign-up activation and its quota (P4)', () => {
  const token = 'A'.repeat(43);
  const password = 'Synthetic-Provider-Password-2026';
  // identity.prepare_self_service_provider_activation's answer for a live session within its budget.
  const liveSession = { rows: [{ verdict: 'ready' }] };
  const activatedRow = {
    organization_id: 'org-1', facility_id: 'facility-1', account_id: 'account-1', row_version: '7',
    hid_subject: 'org-onboarding:account-1', account_email: 'admin@example.invalid',
  };
  const service = (query: jest.Mock) => {
    const database = { withSystemTransaction: jest.fn(async (_id, work) => work({ query })) };
    return { database, service: new OrganizationProfileCompletionService(database as unknown as DatabaseService,
      { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted' }) } as unknown as NotificationOtpClient) };
  };

  beforeEach(() => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({
      NODE_ENV: 'test', OTP_HMAC_KEY_B64: Buffer.alloc(32, 9).toString('base64'),
      CORS_ORIGINS: 'https://app.healthidentitydirectory.com', AUTH_COOKIE_SECURE: true,
    } as environment.Environment);
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs the pre-check, then activates through one runtime command that also returns the login email', async () => {
    const query = jest.fn().mockResolvedValueOnce(liveSession).mockResolvedValueOnce({ rows: [activatedRow] });
    const { service: completion, database } = service(query);
    await expect(completion.activate(token, password, correlationId))
      .resolves.toEqual({ organizationId: 'org-1', facilityId: 'facility-1', accountId: 'account-1',
        email: 'admin@example.invalid' });
    // The pre-check is its own committed transaction (it charges the
    // session's attempt); the activation is one command, and nothing is read
    // after it commits.
    expect(database.withSystemTransaction).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain('identity.prepare_self_service_provider_activation($1)');
    expect(query.mock.calls[1]?.[0]).toContain('identity.activate_self_service_provider_enrollment($1,$2)');
    expect(query.mock.calls[0]?.[1]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(query.mock.calls[1]?.[1]).toEqual([query.mock.calls[0]?.[1]?.[0], expect.stringMatching(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/)]);
  });

  it('refuses a session that is not live, or whose 5 attempts are spent, 401 before hashing the password (A9, R1)', async () => {
    const hash = jest.spyOn(passwordHash, 'hashAccountPassword');
    for (const failure of [
      () => jest.fn().mockResolvedValueOnce({ rows: [{ verdict: 'session_invalid' }] }),
      () => jest.fn().mockResolvedValueOnce({ rows: [{ verdict: 'attempts_exceeded' }] }),
      () => jest.fn().mockRejectedValueOnce(Object.assign(new Error('Self-service activation context is required'), { code: '42501' })),
    ]) {
      const query = failure();
      const { service: completion } = service(query);
      await expect(completion.activate(token, password, correlationId))
        .rejects.toMatchObject({ status: 401, code: 'ORGANIZATION_COMPLETION_SESSION_INVALID' });
      expect(query).toHaveBeenCalledTimes(1);
    }
    // A malformed or missing token is refused before any database read.
    const query = jest.fn();
    const { service: completion, database } = service(query);
    for (const value of [undefined, 'short', `${'A'.repeat(42)}!`]) {
      await expect(completion.activate(value, password, correlationId))
        .rejects.toMatchObject({ status: 401, code: 'ORGANIZATION_COMPLETION_SESSION_INVALID' });
    }
    await expect(completion.activate(token, 'too-short', correlationId))
      .rejects.toMatchObject({ status: 400, code: 'PASSWORD_INVALID' });
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it.each([
    ['email_registered', 409, 'PROVIDER_EMAIL_ALREADY_REGISTERED'],
    ['cac_bound', 409, 'ORGANIZATION_REVIEW_REQUIRED'],
    ['name_exists', 409, 'ORGANIZATION_REVIEW_REQUIRED'],
    ['not_ready', 409, 'ORGANIZATION_REVIEW_REQUIRED'],
    ['an unknown answer', 503, 'ORGANIZATION_COMPLETION_UNAVAILABLE'],
  ])('answers the pre-check\'s %s at once, without hashing the password or activating (R1)', async (verdict, status, code) => {
    const hash = jest.spyOn(passwordHash, 'hashAccountPassword');
    const query = jest.fn().mockResolvedValueOnce({ rows: verdict === 'an unknown answer' ? [] : [{ verdict }] });
    await expect(service(query).service.activate(token, password, correlationId)).rejects.toMatchObject({ status, code });
    expect(query).toHaveBeenCalledTimes(1);
    expect(hash).not.toHaveBeenCalled();
  });

  it.each([
    ['55000', 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled'],
    ['55000', 'PLATFORM_CONTROL_UNAVAILABLE'],
    ['22023', 'PLATFORM_CONTROL_INVALID'],
  ])('answers the pre-check\'s %s %s 423 PROVIDER_ENROLLMENT_UNAVAILABLE before hashing', async (code, message) => {
    const hash = jest.spyOn(passwordHash, 'hashAccountPassword');
    const query = jest.fn().mockRejectedValueOnce(Object.assign(new Error(message), { code }));
    await expect(service(query).service.activate(token, password, correlationId))
      .rejects.toMatchObject({ status: 423, code: 'PROVIDER_ENROLLMENT_UNAVAILABLE' });
    expect(hash).not.toHaveBeenCalled();
  });

  it('answers an administrator email that already has an account 409 PROVIDER_EMAIL_ALREADY_REGISTERED', async () => {
    // 0061 raises this after the caller proved control of the mailbox with the emailed code.
    const conflict = Object.assign(new Error('Administrator email already belongs to an account'), { code: '23505' });
    const query = jest.fn().mockResolvedValueOnce(liveSession).mockRejectedValueOnce(conflict);
    await expect(service(query).service.activate(token, password, correlationId))
      .rejects.toMatchObject({ status: 409, code: 'PROVIDER_EMAIL_ALREADY_REGISTERED',
        message: 'The administrator email is already associated with an HID account' });
  });

  it('keeps every other unique violation, and the governed completion steps, at 503', async () => {
    const otherUnique = Object.assign(new Error('duplicate key value violates unique constraint "accounts_email_key"'),
      { code: '23505' });
    const sameMessage = Object.assign(new Error('Administrator email already belongs to an account'), { code: '23505' });
    const query = jest.fn().mockResolvedValueOnce(liveSession).mockRejectedValueOnce(otherUnique);
    const { service: completion } = service(query);
    const unavailable = { status: 503, code: 'ORGANIZATION_COMPLETION_UNAVAILABLE' };
    await expect(completion.activate(token, password, correlationId)).rejects.toMatchObject(unavailable);
    // The governed completion steps never answer with a provider enrollment code.
    for (const error of [otherUnique, sameMessage]) {
      query.mockReset().mockRejectedValue(error);
      await expect(completion.start(input, '203.0.113.44', correlationId)).rejects.toMatchObject(unavailable);
      await expect(completion.verify('8ce75fc3-0bda-4300-b198-f5688df65d6c', '123456', correlationId))
        .rejects.toMatchObject(unavailable);
      await expect(completion.current(token, correlationId)).rejects.toMatchObject(unavailable);
      await expect(completion.complete(token, 3, { address: 'Synthetic Registry Office' }, correlationId))
        .rejects.toMatchObject(unavailable);
    }
  });

  it.each([
    ['55000', 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled'],
    ['55000', 'PLATFORM_CONTROL_UNAVAILABLE'],
    ['22023', 'PLATFORM_CONTROL_INVALID'],
  ])('answers the activation command\'s %s %s 423 PROVIDER_ENROLLMENT_UNAVAILABLE, never 400 or 503 (C19)',
    async (code, message) => {
      const query = jest.fn().mockResolvedValueOnce(liveSession)
        .mockRejectedValueOnce(Object.assign(new Error(message), { code }));
      await expect(service(query).service.activate(token, password, correlationId))
        .rejects.toMatchObject({ status: 423, code: 'PROVIDER_ENROLLMENT_UNAVAILABLE' });
    });

  it('keeps the governed completion\'s own answers for its other refusals', async () => {
    for (const [code, status, answer] of [['23514', 409, 'ORGANIZATION_REVIEW_REQUIRED'],
      ['40001', 409, 'VERSION_CONFLICT'], ['42501', 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID'],
      ['P0002', 503, 'ORGANIZATION_COMPLETION_UNAVAILABLE']] as const) {
      const query = jest.fn().mockResolvedValueOnce(liveSession)
        .mockRejectedValueOnce(Object.assign(new Error('synthetic refusal'), { code }));
      await expect(service(query).service.activate(token, password, correlationId))
        .rejects.toMatchObject({ status, code: answer });
    }
    const query = jest.fn().mockResolvedValueOnce(liveSession).mockResolvedValueOnce({ rows: [] });
    await expect(service(query).service.activate(token, password, correlationId))
      .rejects.toMatchObject({ status: 503, code: 'PROVIDER_ENROLLMENT_ACTIVATION_UNAVAILABLE' });
  });

  it('charges the public application quota at start unless the caller already charged it (C8)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const { service: completion } = service(query);
    await completion.start(input, '203.0.113.44', correlationId);
    const charged = query.mock.calls.filter(([sql]) => String(sql).includes('consume_public_application_quota'));
    expect(charged).toHaveLength(1);
    // The digest a caller charges itself is the one start charges.
    expect(charged[0]?.[1]).toEqual([completion.publicApplicationDigest('203.0.113.44')]);
    query.mockClear();
    await expect(completion.start(input, '203.0.113.44', correlationId, { publicApplicationQuotaCharged: true }))
      .resolves.toMatchObject({ accepted: true });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('consume_public_application_quota'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('begin_organization_profile_completion'))).toBe(true);
  });

  it('has no public application digest without a client address', () => {
    const { service: completion } = service(jest.fn());
    for (const ip of [undefined, 'not-an-address']) {
      expect(() => completion.publicApplicationDigest(ip))
        .toThrow(expect.objectContaining({ code: 'APPLICATION_RATE_LIMIT_UNAVAILABLE' }));
    }
  });

  it('keys a client network\'s public application digest: an IPv4 address as start does, an IPv6 /64 (R5)', () => {
    const { service: completion } = service(jest.fn());
    expect(completion.publicApplicationNetworkDigest('203.0.113.44'))
      .toBe(completion.publicApplicationDigest('203.0.113.44'));
    const prefix = completion.publicApplicationNetworkDigest('2001:db8:1:2::/64');
    expect(prefix).toMatch(/^[a-f0-9]{64}$/);
    expect(prefix).not.toBe(completion.publicApplicationDigest('2001:db8:1:2::1'));
    for (const network of ['', '2001:db8:1:2::1', '2001:db8::/48', 'not-a-network']) {
      expect(() => completion.publicApplicationNetworkDigest(network))
        .toThrow(expect.objectContaining({ code: 'APPLICATION_RATE_LIMIT_UNAVAILABLE' }));
    }
  });

  it('sends facility self sign-up\'s code through the self-service command with the requested details (R5, R6)', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ recipient_email: 'admin@example.invalid' }] })
      .mockResolvedValueOnce({ rows: [{ application_open: true, challenge_id: 'in-force', expires_in_seconds: 600,
        resend_after_seconds: 60 }] });
    const { service: completion, database } = service(query);
    const started = await completion.start(input, '203.0.113.44', correlationId, { publicApplicationQuotaCharged: true,
      selfService: { administratorName: 'Dr Ada Obi', organizationType: 'hospital' } });
    // The code and its state are read in one transaction (R14).
    expect(database.withSystemTransaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0])
      .toContain('identity.begin_self_service_provider_enrollment($1,$2,$3,$4,$5,$6,$7)');
    expect(query.mock.calls[0]?.[1]).toEqual(['RC1234567', 'admin@example.invalid', 'ehr', started.challengeId,
      expect.stringMatching(/^[a-f0-9]{64}$/), 'Dr Ada Obi', 'hospital']);
    expect(query.mock.calls[1]?.[0]).toContain('identity.self_service_provider_code_state($1,$2,$3)');
    expect(query.mock.calls[1]?.[1]).toEqual(['RC1234567', 'admin@example.invalid', 'ehr']);
    expect(started).toEqual({ accepted: true, codeSent: true, challengeId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expiresInSeconds: 600, resendAfterSeconds: 60 });
    // The governed completion keeps 0056's command and its uniform answer.
    query.mockClear();
    query.mockResolvedValue({ rows: [{ recipient_email: null }] });
    const governed = await completion.start(input, '203.0.113.44', correlationId);
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('begin_self_service_provider_enrollment');
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('self_service_provider_code_state');
    expect(governed).toEqual({ accepted: true, challengeId: expect.any(String), expiresInSeconds: 600,
      resendAfterSeconds: 60 });
  });

  describe('facility self sign-up\'s answer when no code is sent (R14)', () => {
    const selfService = { administratorName: 'Dr Ada Obi', organizationType: 'hospital' as const };
    const startWith = async (state: Record<string, unknown> | undefined, recipient: string | null = null) => {
      const query = jest.fn().mockResolvedValueOnce({ rows: [{ recipient_email: recipient }] })
        .mockResolvedValueOnce({ rows: state ? [state] : [] });
      const deliver = jest.fn().mockResolvedValue({ outcome: 'accepted' });
      const database = { withSystemTransaction: jest.fn(async (_id, work) => work({ query })) };
      const completion = new OrganizationProfileCompletionService(database as unknown as DatabaseService,
        { deliver } as unknown as NotificationOtpClient);
      const answer = completion.start(input, '203.0.113.44', correlationId,
        { publicApplicationQuotaCharged: true, selfService });
      await answer.catch(() => undefined);
      await completion.settleDeliveries();
      return { answer, deliver };
    };

    it('says no code was sent, names the code still in force and the wait, and delivers nothing', async () => {
      const { answer, deliver } = await startWith({ application_open: true,
        challenge_id: 'c8ca0000-0000-4000-8000-000000000015', expires_in_seconds: 417, resend_after_seconds: 3295 });
      await expect(answer).resolves.toEqual({ accepted: true, codeSent: false,
        challengeId: 'c8ca0000-0000-4000-8000-000000000015', expiresInSeconds: 417, resendAfterSeconds: 3295 });
      expect(deliver).not.toHaveBeenCalled();
    });

    it('leaves the challenge out when no code is in force', async () => {
      const { answer, deliver } = await startWith({ application_open: true, challenge_id: null,
        expires_in_seconds: null, resend_after_seconds: 75_000 });
      await expect(answer).resolves.toEqual({ accepted: true, codeSent: false, resendAfterSeconds: 75_000 });
      expect(deliver).not.toHaveBeenCalled();
    });

    it('never answers a wait shorter than a second', async () => {
      const { answer } = await startWith({ application_open: true, challenge_id: null, expires_in_seconds: null,
        resend_after_seconds: 0 });
      await expect(answer).resolves.toEqual({ accepted: true, codeSent: false, resendAfterSeconds: 1 });
    });

    it('answers 409 PROVIDER_ENROLLMENT_REQUIRES_REVIEW when the application closed since start read it', async () => {
      for (const state of [{ application_open: false, challenge_id: null, expires_in_seconds: null,
        resend_after_seconds: null }, undefined]) {
        const { answer, deliver } = await startWith(state);
        await expect(answer).rejects.toMatchObject({ status: 409, code: 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW' });
        expect(deliver).not.toHaveBeenCalled();
      }
    });

    it('gives the wait the state reads after a sent code, such as the hour\'s limit after the 5th', async () => {
      const { answer, deliver } = await startWith({ application_open: true, challenge_id: 'new',
        expires_in_seconds: 600, resend_after_seconds: 3540 }, 'admin@example.invalid');
      await expect(answer).resolves.toEqual({ accepted: true, codeSent: true, challengeId: expect.any(String),
        expiresInSeconds: 600, resendAfterSeconds: 3540 });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0]?.[0]).toMatchObject({ recipient: 'admin@example.invalid', purpose: 'EMAIL_VERIFY' });
    });
  });

  describe('facility self sign-up\'s confirmation read (R13)', () => {
    const row = { organization_name: 'Confirm Hospital Ltd', cac_registration_number: 'RC1234567',
      product_code: 'ehr', organization_type: 'hospital', administrator_name: 'Dr Ada Obi',
      administrator_email: 'admin@example.invalid' };

    it('reads the session\'s registration through one read-only command and answers it camelCased', async () => {
      const query = jest.fn().mockResolvedValueOnce({ rows: [row] });
      const { service: completion, database } = service(query);
      await expect(completion.selfServiceProfile(token, correlationId)).resolves.toEqual({
        organizationName: 'Confirm Hospital Ltd', registrationNumber: 'RC1234567', productCode: 'ehr',
        organizationType: 'hospital', administratorName: 'Dr Ada Obi', administratorEmail: 'admin@example.invalid' });
      expect(database.withSystemTransaction).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0]?.[0]).toBe('select * from identity.current_self_service_provider_enrollment($1)');
      expect(query.mock.calls[0]?.[1]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
      // The same session hash the activation uses.
      const activationQuery = jest.fn().mockResolvedValueOnce({ rows: [{ verdict: 'session_invalid' }] });
      await service(activationQuery).service.activate(token, password, correlationId).catch(() => undefined);
      expect(activationQuery.mock.calls[0]?.[1]).toEqual(query.mock.calls[0]?.[1]);
    });

    it('answers no live session 401 ORGANIZATION_COMPLETION_SESSION_INVALID', async () => {
      const query = jest.fn().mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(Object.assign(new Error('Self-service enrollment context is required'), { code: '42501' }));
      const { service: completion } = service(query);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(completion.selfServiceProfile(token, correlationId))
          .rejects.toMatchObject({ status: 401, code: 'ORGANIZATION_COMPLETION_SESSION_INVALID' });
      }
      // A missing or malformed cookie is refused before any database read.
      const unread = jest.fn();
      const { service: untouched, database } = service(unread);
      for (const value of [undefined, 'short', `${'A'.repeat(42)}!`]) {
        await expect(untouched.selfServiceProfile(value, correlationId))
          .rejects.toMatchObject({ status: 401, code: 'ORGANIZATION_COMPLETION_SESSION_INVALID' });
      }
      expect(database.withSystemTransaction).not.toHaveBeenCalled();
    });

    it.each([
      ['55000', 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled', 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE'],
      ['55000', 'PLATFORM_CONTROL_UNAVAILABLE', 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE'],
      ['22023', 'PLATFORM_CONTROL_INVALID', 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE'],
      ['42883', 'function identity.current_self_service_provider_enrollment(unknown) does not exist', 503,
        'ORGANIZATION_COMPLETION_UNAVAILABLE'],
    ])('answers the command\'s %s %s %s %s', async (code, message, status, answer) => {
      const query = jest.fn().mockRejectedValueOnce(Object.assign(new Error(message), { code }));
      await expect(service(query).service.selfServiceProfile(token, correlationId))
        .rejects.toMatchObject({ status, code: answer });
    });
  });

  // P4b (P4 leftover 1): "This isn't my organization".
  describe('facility self sign-up\'s withdrawal', () => {
    it('closes the session\'s application through one command keyed by the same session hash', async () => {
      const query = jest.fn().mockResolvedValueOnce({ rows: [{ result: 'withdrawn' }] });
      const { service: completion, database } = service(query);
      await expect(completion.withdrawSelfService(token, correlationId)).resolves.toBeUndefined();
      expect(database.withSystemTransaction).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0]?.[0]).toBe('select identity.withdraw_self_service_provider_enrollment($1) as result');
      const readQuery = jest.fn().mockResolvedValueOnce({ rows: [] });
      await service(readQuery).service.selfServiceProfile(token, correlationId).catch(() => undefined);
      expect(query.mock.calls[0]?.[1]).toEqual(readQuery.mock.calls[0]?.[1]);
    });

    it('answers nothing withdrawn 401, and a missing or malformed cookie 401 before any database call', async () => {
      for (const rows of [[{ result: 'session_invalid' }], [{ result: null }], [{ result: true }], []]) {
        await expect(service(jest.fn().mockResolvedValueOnce({ rows })).service.withdrawSelfService(token, correlationId))
          .rejects.toMatchObject({ status: 401, code: 'ORGANIZATION_COMPLETION_SESSION_INVALID' });
      }
      const unread = jest.fn();
      const { service: untouched, database } = service(unread);
      for (const value of [undefined, 'short', `${'A'.repeat(42)}!`]) {
        await expect(untouched.withdrawSelfService(value, correlationId))
          .rejects.toMatchObject({ status: 401, code: 'ORGANIZATION_COMPLETION_SESSION_INVALID' });
      }
      expect(database.withSystemTransaction).not.toHaveBeenCalled();
    });

    it.each([
      ['55000', 'PLATFORM_CONTROL_DISABLED:provider_self_service_enabled', 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE'],
      ['22023', 'PLATFORM_CONTROL_INVALID', 423, 'PROVIDER_ENROLLMENT_UNAVAILABLE'],
      ['42501', 'Self-service enrollment context is required', 401, 'ORGANIZATION_COMPLETION_SESSION_INVALID'],
      ['42883', 'function identity.withdraw_self_service_provider_enrollment(unknown) does not exist', 503,
        'ORGANIZATION_COMPLETION_UNAVAILABLE'],
    ])('answers the command\'s %s %s %s %s', async (code, message, status, answer) => {
      const query = jest.fn().mockRejectedValueOnce(Object.assign(new Error(message), { code }));
      await expect(service(query).service.withdrawSelfService(token, correlationId))
        .rejects.toMatchObject({ status, code: answer });
    });
  });
});
