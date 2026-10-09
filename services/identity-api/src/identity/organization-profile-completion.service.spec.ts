import type { Response } from 'express';
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

  it('activates through one runtime command that also returns the login email', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{
      organization_id: 'org-1', facility_id: 'facility-1', account_id: 'account-1', row_version: '7',
      hid_subject: 'org-onboarding:account-1', account_email: 'admin@example.invalid',
    }] });
    const database = { withSystemTransaction: jest.fn(async (_id, work) => work({ query })) };
    const service = new OrganizationProfileCompletionService(database as unknown as DatabaseService,
      { deliver: jest.fn() } as unknown as NotificationOtpClient);
    await expect(service.activate('A'.repeat(43), 'Synthetic-Provider-Password-2026', correlationId))
      .resolves.toEqual({ organizationId: 'org-1', facilityId: 'facility-1', accountId: 'account-1',
        email: 'admin@example.invalid' });
    // A single transaction: nothing is read after the activation commits.
    expect(database.withSystemTransaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('identity.activate_self_service_provider_enrollment($1,$2)');
    expect(query.mock.calls[0]?.[1]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^\$argon2id\$/)]);
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
    expect(result.accepted).toBe(true);
    expect(query.mock.calls[2]?.[0]).toContain('invalidate_organization_profile_completion_challenge');
    expect(query.mock.calls[2]?.[1]).toEqual([result.challengeId]);
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
