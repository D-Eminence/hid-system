jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import type { AuthService } from '../auth/auth.service';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { TurnstileService } from '../auth/turnstile.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest, PlatformAdminContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { PlatformControlCommandDto } from '../admin/dto/admin-command.dto';
import { IdentityController } from '../identity/identity.controller';
import type { OrganizationProfileCompletionService } from '../identity/organization-profile-completion.service';
import { ActivateOutreachOrganiserDto, StartOutreachOrganiserSignupDto } from './dto/outreach-organiser.dto';
import { OUTREACH_INVITATION_REFUSALS, OutreachInvitationsService } from './outreach-invitations.service';
import { decryptOutreachPhone, domainHmac, encryptOutreachPhone, normalizeOutreachPhone, outreachKey,
  reservedOrganiserName } from './outreach-organiser-crypto';
import { assertOutreachSignupOpen } from './outreach-organiser-gate';
import { OUTREACH_SIGNUP_COOKIE, OutreachOrganiserController } from './outreach-organiser.controller';
import { OUTREACH_SIGNUP_REFUSALS, OutreachOrganiserService } from './outreach-organiser.service';
import { FindOutreachRegistrationsDto, ListOutreachOrganisersDto, OUTREACH_ADMIN_REFUSALS, OutreachOrganisersAdminController,
  OutreachOrganisersAdminService, OutreachRegistrationsAdminController, RedactOutreachRegistrationDto,
  outreachAdminVersion } from './outreach-organisers-admin';
import { REQUIRED_PERMISSIONS } from '../common/decorators';
import { OUTREACH_RETENTION_SWEEP_BATCH, OutreachRetentionSweeper } from './outreach-retention.sweeper';

// Fictional test data only.
const origin = 'https://outreach.healthidentitydirectory.com';
const correlationId = 'outreach-organiser-test';
const signupId = '4b0b8f8e-3c56-4e1a-9d6b-1f2a3b4c5d6e';
const challengeId = '5c1c9f9f-4d67-4f2b-8e7c-2a3b4c5d6e7f'; // a delivery reference only
const token = 'A'.repeat(43);
const startInput = {
  organiserName: 'Ada Fictional', email: 'ada.organiser@example.test', phone: '0801 234 5678',
  groupName: 'Synthetic Community Volunteers', kind: 'group' as const,
  turnstileAction: 'outreach-organiser-signup' as const, turnstileToken: 'opaque-proof',
};
const openControls = { rows: [{ signup: true, outreach_portal: true, maintenance: false }] };

function setEnvironment(extra: Record<string, string> = {}) {
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: `${origin},https://ehr.healthidentitydirectory.com`, AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    AUTH_COOKIE_SECURE: 'true', OTP_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
    CONTACT_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 9).toString('base64'), ...extra,
  });
  resetEnvironmentForTests();
}

function database(handlers: { system?: jest.Mock; actor?: jest.Mock; platform?: jest.Mock; query?: jest.Mock } = {}) {
  const system = handlers.system ?? jest.fn(async () => ({ rows: [] }));
  const actor = handlers.actor ?? jest.fn(async () => ({ rows: [] }));
  const platform = handlers.platform ?? jest.fn(async () => ({ rows: [] }));
  return {
    query: handlers.query ?? jest.fn(async () => openControls),
    withSystemTransaction: jest.fn(async (_id: string, work: (client: PoolClient) => Promise<unknown>) =>
      work({ query: system } as unknown as PoolClient)),
    withTransaction: jest.fn(async (_context: unknown, work: (client: PoolClient) => Promise<unknown>) =>
      work({ query: actor } as unknown as PoolClient)),
    withPlatformTransaction: jest.fn(async (_context: unknown, work: (client: PoolClient) => Promise<unknown>) =>
      work({ query: platform } as unknown as PoolClient)),
    system, actor, platform,
  };
}

function request(options: { cookie?: string; origin?: string | null; authorization?: string } = {}): HidRequest {
  return { correlationId, ip: '203.0.113.10', header: jest.fn((name: string) => {
    if (name === 'origin') return options.origin === null ? undefined : options.origin ?? origin;
    if (name === 'cookie') return options.cookie;
    if (name === 'authorization') return options.authorization;
    if (name === 'user-agent') return 'synthetic-agent';
    return undefined;
  }) } as unknown as HidRequest;
}

function staffContext(roles: string[], email = 'helper@example.test'): DataAccessContext {
  return { correlationId, facilityId: '11111111-1111-4111-8111-111111111111', membershipId: '22222222-2222-4222-8222-222222222222',
    purposeOfUse: 'healthcare-operations', actor: { kind: 'staff', id: 'staff:1', subject: 'staff:1', accountId: 'account-1',
      email, roles, permissions: ['outreach.campaign.write'], facilityIds: [], facilities: [],
      facility: { id: '11111111-1111-4111-8111-111111111111', membershipId: '22222222-2222-4222-8222-222222222222',
        organizationId: 'org-1', name: 'Synthetic Community Volunteers', roles, permissions: ['outreach.campaign.write'],
        isPrimary: true }, authenticationMethod: 'local' } };
}

const original = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  resetEnvironmentForTests();
  jest.restoreAllMocks();
});

describe('helpers', () => {
  beforeEach(() => setEnvironment());

  it('normalises phones to E.164', () => {
    expect(normalizeOutreachPhone('0801 234 5678')).toBe('+2348012345678');
    expect(normalizeOutreachPhone('+234 0801 234 5678')).toBe('+2348012345678');
    expect(normalizeOutreachPhone('call me')).toBeUndefined();
  });

  it('refuses names kept for hospitals and government bodies, but not ordinary words', () => {
    for (const name of ['Lagos Hospital Volunteers', 'Federal Health Friends', 'WHO Helpers', 'NCDC outreach'])
      expect(reservedOrganiserName(name)).toBe(true);
    for (const name of ['Those who care', 'Synthetic Community Volunteers', 'Hospitality Club'])
      expect(reservedOrganiserName(name)).toBe(false);
  });

  it('refuses the names that once slipped past the list (as 0115 does), and keeps accented names', () => {
    for (const name of ['World Health Organization', 'Nigeria Centre for Disease Control', 'Ncdc Outreach', 'N.C.D.C Outreach',
      'Lagos University Teaching Hosp', 'General H\u043Espital Ikeja', 'Lagos State Primary Health Care Board', 'FMC Abeokuta',
      'UNICEF Nigeria', 'Red Cross Nigeria', 'W.H.O. Friends', '\uFF28ospital Friends', 'Hope\u200BGroup',
      'Ikeja Medical Center Friends', 'Lagos Health Service', 'Lagos State Health Board'])
      expect([name, reservedOrganiserName(name)]).toEqual([name, true]);
    for (const name of ['People who care Yaba', '\u1ECCm\u1ECD \u1ECCl\u1ECDrun Friends (Ikeja) - 2',
      'St. Mary\u2019s Youth', 'Lagos Island Health Volunteers'])
      expect([name, reservedOrganiserName(name)]).toEqual([name, false]);
  });

  it('encrypts the phone so only Identity can read it back', () => {
    const key = outreachKey() as Buffer;
    const sealed = encryptOutreachPhone(key, '+2348012345678');
    expect(sealed.toString('utf8')).not.toContain('2348012345678');
    expect(decryptOutreachPhone(key, sealed)).toBe('+2348012345678');
    expect(decryptOutreachPhone(Buffer.alloc(32, 1), sealed)).toBeNull();
    expect(decryptOutreachPhone(key, null)).toBeNull();
  });

  it('accepts the new control key in the admin switch', async () => {
    const dto = plainToInstance(PlatformControlCommandDto, { controlKey: 'outreach_organiser_signup_enabled',
      enabled: true, reason: 'Pilot with two fictional NGOs' });
    expect(await validate(dto)).toEqual([]);
  });

  it('validates the sign-up and activation bodies, terms version 2026-11-01 only', async () => {
    expect(await validate(plainToInstance(StartOutreachOrganiserSignupDto, startInput))).toEqual([]);
    expect((await validate(plainToInstance(StartOutreachOrganiserSignupDto, { ...startInput, kind: 'company' })))
      .map((error) => error.property)).toEqual(['kind']);
    expect(await validate(plainToInstance(ActivateOutreachOrganiserDto,
      { termsVersion: '2026-11-01', acceptTerms: true, password: 'a-long-fictional-password' }))).toEqual([]);
    expect((await validate(plainToInstance(ActivateOutreachOrganiserDto,
      { termsVersion: '2026-10-01', acceptTerms: false, password: 'a-long-fictional-password' })))
      .map((error) => error.property).sort()).toEqual(['acceptTerms', 'termsVersion']);
  });
});

describe('the gate', () => {
  beforeEach(() => setEnvironment());

  it('is closed (423) unless the control and the Outreach portal are on and maintenance is off', async () => {
    await expect(assertOutreachSignupOpen({ query: jest.fn(async () => openControls) } as never)).resolves.toBeUndefined();
    for (const row of [{ signup: false, outreach_portal: true, maintenance: false },
      { signup: true, outreach_portal: false, maintenance: false }, { signup: true, outreach_portal: true, maintenance: true }]) {
      await expect(assertOutreachSignupOpen({ query: jest.fn(async () => ({ rows: [row] })) } as never))
        .rejects.toMatchObject({ status: 423, code: 'OUTREACH_ORGANISER_SIGNUP_UNAVAILABLE' });
    }
    await expect(assertOutreachSignupOpen({ query: jest.fn(async () => {
      throw Object.assign(new Error('PLATFORM_CONTROL_INVALID'), { code: '22023' });
    }) } as never)).rejects.toMatchObject({ status: 423 });
    await expect(assertOutreachSignupOpen({ query: jest.fn(async () => { throw new Error('down'); }) } as never))
      .rejects.toMatchObject({ status: 503 });
  });
});

describe('OutreachOrganiserService', () => {
  beforeEach(() => setEnvironment());
  const notification = () => ({ deliver: jest.fn(async () => ({ outcome: 'accepted' })) });
  const completion = { publicApplicationNetworkDigest: jest.fn(() => 'network-digest') };
  const make = (db: ReturnType<typeof database>, otp = notification()) => new OutreachOrganiserService(
    db as unknown as DatabaseService, otp as unknown as NotificationOtpClient,
    completion as unknown as OrganizationProfileCompletionService);

  it('starts a sign-up: the network window first, then 0115\'s 12-argument command with HMACs only, then the email', async () => {
    const system = jest.fn(async (sql: string) => sql.includes('start_outreach_organiser_signup')
      ? { rows: [{ outcome: 'started' }] } : { rows: [] });
    const db = database({ system });
    const otp = notification();
    const started = await make(db, otp).start(plainToInstance(StartOutreachOrganiserSignupDto, startInput), '203.0.113.10', correlationId);
    expect(started.cookie).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(started.body).toMatchObject({ accepted: true, expiresInSeconds: 900, resendAfterSeconds: 60 });
    const sqls = system.mock.calls.map((call) => String(call[0]));
    // The command charges the public application quota itself (0115); Identity does not charge it twice.
    expect(sqls.some((sql) => sql.includes('platform.consume_public_application_quota'))).toBe(false);
    const command = system.mock.calls.find((call) => String(call[0]).includes('start_outreach_organiser_signup')) as unknown[];
    expect(String(command[0])).toBe('select identity.start_outreach_organiser_signup($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as outcome');
    const values = command[1] as unknown[];
    expect(values).toHaveLength(12);
    // (signup, token_hmac, email, organiser_name, group_name, kind, reg_no, phone_lookup, phone_ct, key_version, network, code_hmac)
    expect(values[1]).toBe(domainHmac(outreachKey() as Buffer, 'outreach-organiser-signup', 'cookie', started.cookie.split('.')[1] as string));
    expect(values[2]).toBe('ada.organiser@example.test');
    expect(values[3]).toBe('Ada Fictional');
    expect(values[4]).toBe('Synthetic Community Volunteers');
    expect(values[5]).toBe('group');
    expect(values[6]).toBeNull();
    expect(String(values[7])).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.isBuffer(values[8])).toBe(true);
    expect(values[9]).toBe('local-v1');
    expect(values[10]).toBe('network-digest');
    expect(values.map(String).join('|')).not.toContain('2348012345678');
    expect(otp.deliver).toHaveBeenCalledWith(expect.objectContaining({ recipient: 'ada.organiser@example.test',
      purpose: 'SIGNUP_VERIFY', channel: 'email' }));
    // The code the email carries is the one the database holds as an HMAC bound to the sign-up.
    const code = (otp.deliver.mock.calls[0] as unknown as [{ code: string }])[0];
    expect(values[11]).toBe(domainHmac(outreachKey() as Buffer, 'outreach-organiser-signup', 'otp', String(values[0]), code.code));
  });

  it.each([['name_not_allowed', 422, 'OUTREACH_ORGANISER_NAME_NOT_ALLOWED'], ['rate_limited', 429, 'OUTREACH_ORGANISER_SIGNUP_RATE_LIMITED'],
    ['email_rate_limited', 429, 'OUTREACH_ORGANISER_EMAIL_RATE_LIMITED'], ['suspended', 423, 'OUTREACH_ORGANISER_SUSPENDED'],
    ['patient_login', 409, 'OUTREACH_ORGANISER_PATIENT_LOGIN'],
    ['something_else', 503, 'OUTREACH_ORGANISER_SIGNUP_UNAVAILABLE']] as const)(
    'answers the start outcome %s plainly and sends no email', async (outcome, status, code) => {
    const system = jest.fn(async (sql: string) => sql.includes('start_outreach_organiser_signup') ? { rows: [{ outcome }] } : { rows: [] });
    const otp = notification();
    await expect(make(database({ system }), otp).start(plainToInstance(StartOutreachOrganiserSignupDto, startInput),
      '203.0.113.10', correlationId)).rejects.toMatchObject({ status, code });
    expect(otp.deliver).not.toHaveBeenCalled();
  });

  it('refuses an email that already has an account, telling the person to sign in and start a group', async () => {
    const system = jest.fn(async (sql: string) => sql.includes('start_outreach_organiser_signup')
      ? { rows: [{ outcome: 'email_registered' }] } : { rows: [] });
    const otp = notification();
    await expect(make(database({ system }), otp).start(plainToInstance(StartOutreachOrganiserSignupDto, startInput),
      '203.0.113.10', correlationId)).rejects.toMatchObject({ status: 409, code: 'OUTREACH_ORGANISER_EMAIL_REGISTERED',
      message: expect.stringContaining('Start an outreach group') });
    expect(otp.deliver).not.toHaveBeenCalled();
  });

  it('is closed with 423 before anything is charged while the switch is off', async () => {
    const db = database({ query: jest.fn(async () => ({ rows: [{ signup: false, outreach_portal: true, maintenance: false }] })) });
    await expect(make(db).start(plainToInstance(StartOutreachOrganiserSignupDto, startInput), '203.0.113.10', correlationId))
      .rejects.toMatchObject({ status: 423 });
    expect(db.withSystemTransaction).not.toHaveBeenCalled();
  });

  it('refuses a reserved group name and a bad phone before anything is charged', async () => {
    const db = database();
    await expect(make(db).start(plainToInstance(StartOutreachOrganiserSignupDto, { ...startInput, groupName: 'Ministry Helpers' }),
      '203.0.113.10', correlationId)).rejects.toMatchObject({ status: 422, code: 'OUTREACH_ORGANISER_NAME_NOT_ALLOWED' });
    await expect(make(db).start(plainToInstance(StartOutreachOrganiserSignupDto, { ...startInput, phone: '12345' }),
      '203.0.113.10', correlationId)).rejects.toMatchObject({ status: 400, code: 'OUTREACH_PHONE_INVALID' });
    expect(db.withSystemTransaction).not.toHaveBeenCalled();
  });

  it('answers 429 when the network window or the public application quota is spent', async () => {
    const quota = jest.fn(async (sql: string) => {
      if (sql.includes('start_outreach_organiser_signup')) throw Object.assign(new Error('APPLICATION_QUOTA_EXCEEDED'), { code: 'P4290' });
      return { rows: [] };
    });
    await expect(make(database({ system: quota })).start(plainToInstance(StartOutreachOrganiserSignupDto, startInput),
      '203.0.113.10', correlationId)).rejects.toMatchObject({ status: 429, code: 'OUTREACH_ORGANISER_SIGNUP_RATE_LIMITED' });
  });

  it('verifies the code with 0115\'s 3 arguments and answers each result plainly', async () => {
    const cookie = `${signupId}.${token}`;
    for (const [result, expected] of [['verified', { verified: true }], ['wrong_code', 'OTP_INVALID'], ['code_expired', 'OTP_EXPIRED'],
      ['locked', 'OTP_ATTEMPTS_EXHAUSTED'], ['expired', 'OUTREACH_ORGANISER_SIGNUP_EXPIRED'],
      ['denied', 'OUTREACH_ORGANISER_SIGNUP_SESSION_INVALID']] as const) {
      const system = jest.fn(async () => ({ rows: [{ result }] }));
      const call = make(database({ system })).verify(cookie, '123456', correlationId);
      if (typeof expected === 'object') await expect(call).resolves.toEqual(expected);
      else await expect(call).rejects.toMatchObject({ code: expected });
      const [sql, values] = system.mock.calls[0] as unknown as [string, unknown[]];
      expect(sql).toBe('select identity.verify_outreach_organiser_email($1,$2,$3) as result');
      expect(values).toEqual([signupId, domainHmac(outreachKey() as Buffer, 'outreach-organiser-signup', 'cookie', token),
        domainHmac(outreachKey() as Buffer, 'outreach-organiser-signup', 'otp', signupId, '123456')]);
    }
    await expect(make(database()).verify('not-a-cookie', '123456', correlationId)).rejects.toMatchObject({ status: 401 });
  });

  it('sends a new code through 0115\'s resend command, to the email the command answers (one query, no table read)', async () => {
    const cookie = `${signupId}.${token}`;
    const system = jest.fn(async () => ({ rows: [{ result: 'sent', email: 'ada.organiser@example.test' }] }));
    const otp = notification();
    await expect(make(database({ system }), otp).resend(cookie, correlationId))
      .resolves.toMatchObject({ sent: true, expiresInSeconds: 900, resendAfterSeconds: 60 });
    expect(system).toHaveBeenCalledTimes(1);
    const [sql, values] = system.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toBe('select * from identity.resend_outreach_organiser_signup_code($1,$2,$3)');
    const sent = (otp.deliver.mock.calls[0] as unknown as [{ code: string; recipient: string }])[0];
    expect(sent.recipient).toBe('ada.organiser@example.test');
    expect(values[2]).toBe(domainHmac(outreachKey() as Buffer, 'outreach-organiser-signup', 'otp', signupId, sent.code));
    for (const [outcome, code] of [['too_soon', 'OTP_RESEND_COOLDOWN'], ['too_many', 'OTP_RESEND_LIMIT'],
      ['expired', 'OUTREACH_ORGANISER_SIGNUP_EXPIRED'], ['denied', 'OUTREACH_ORGANISER_SIGNUP_SESSION_INVALID']] as const) {
      const refused = notification();
      await expect(make(database({ system: jest.fn(async () => ({ rows: [{ result: outcome, email: null }] })) }), refused)
        .resend(cookie, correlationId)).rejects.toMatchObject({ code });
      expect(refused.deliver).not.toHaveBeenCalled();
    }
  });

  it('activates with an argon2 hash and the approved terms version, then reads the login\'s email', async () => {
    const system = jest.fn(async (sql: string) => sql.includes('activate_outreach_organiser(')
      ? { rows: [{ organization_id: 'org-1', facility_id: 'fac-1', account_id: 'acc-1', membership_id: 'mem-1',
        hid_subject: 'outreach-organiser:acc-1', replayed: false }] }
      : { rows: [{ email: 'ada.organiser@example.test' }] });
    await expect(make(database({ system })).activate(`${signupId}.${token}`,
      plainToInstance(ActivateOutreachOrganiserDto, { termsVersion: '2026-11-01', acceptTerms: true,
        password: 'a-long-fictional-password' }), correlationId))
      .resolves.toMatchObject({ organizationId: 'org-1', facilityId: 'fac-1', email: 'ada.organiser@example.test', replayed: false });
    const values = (system.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(String(values[2])).toMatch(/^\$argon2id\$/);
    expect(values[3]).toBe('2026-11-01');
    expect((system.mock.calls[1] as unknown as [string, unknown[]])[1]).toEqual(['acc-1']);
  });

  it('maps the database refusals of activation to plain problems', async () => {
    const service = make(database());
    expect(service.mapError({ code: 'P0001', message: 'OUTREACH_ORGANISER_EMAIL_REGISTERED' }))
      .toMatchObject({ status: 409, code: 'OUTREACH_ORGANISER_EMAIL_REGISTERED' });
    expect(service.mapError({ code: '22023', message: 'OUTREACH_ORGANISER_NAME_NOT_ALLOWED' }))
      .toMatchObject({ status: 422, code: 'OUTREACH_ORGANISER_NAME_NOT_ALLOWED' });
    expect(service.mapError({ code: '22023', message: 'OUTREACH_ORGANISER_TERMS_REQUIRED' }))
      .toMatchObject({ status: 409, code: 'OUTREACH_ORGANISER_TERMS_REQUIRED' });
    expect(service.mapError({ code: '22023', message: 'OUTREACH_ORGANISER_SIGNUP_INVALID' }))
      .toMatchObject({ status: 400, code: 'OUTREACH_ORGANISER_SIGNUP_INVALID' });
    expect(service.mapError({ code: '22023', message: 'OUTREACH_ORGANISER_PASSWORD_INVALID' }))
      .toMatchObject({ status: 400, code: 'OUTREACH_ORGANISER_PASSWORD_INVALID' });
    expect(service.mapError({ code: '23514', message: 'OUTREACH_ORGANISER_SIGNUP_NOT_READY' }))
      .toMatchObject({ status: 409, code: 'OUTREACH_ORGANISER_SIGNUP_NOT_READY' });
    expect(service.mapError({ code: 'P0001', message: 'OUTREACH_ROLE_ONLY_AT_OUTREACH_GROUP' }))
      .toMatchObject({ status: 409, code: 'OUTREACH_ROLE_ONLY_AT_OUTREACH_GROUP' });
    expect(service.mapError({ code: '23505', message: 'duplicate key' })).toMatchObject({ status: 409 });
    expect(service.mapError({ code: '55000', message: 'PLATFORM_CONTROL_DISABLED:outreach_organiser_signup_enabled' }))
      .toMatchObject({ status: 423 });
    expect(service.mapError(new Error('boom'))).toMatchObject({ status: 503 });
  });

  it('starts an outreach group for a signed-in staff account as that account (owner decision 5)', async () => {
    const actor = jest.fn(async () => ({ rows: [{ result: 'started', organization_id: 'org-2', facility_id: 'fac-2', membership_id: 'mem-2' }] }));
    const db = database({ actor });
    const context = staffContext(['doctor'], 'doctor@example.test');
    const body = { groupName: 'Synthetic Street Health', kind: 'individual' as const, phone: '08012345678',
      termsVersion: '2026-11-01', acceptTerms: true };
    await expect(make(db).startForAccount(context, body))
      .resolves.toEqual({ started: true, organizationId: 'org-2', facilityId: 'fac-2', membershipId: 'mem-2',
        organiserStatus: 'active', label: 'Unverified organiser' });
    expect(db.withTransaction).toHaveBeenCalledWith(context, expect.any(Function));
    const [sql, values] = actor.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('identity.activate_outreach_organiser_for_account($1,$2,$3,$4,$5,$6,$7)');
    // (group_name, kind, reg_no, terms_version, phone_lookup, phone_ct, key_version)
    expect(values[0]).toBe('Synthetic Street Health');
    expect(values[1]).toBe('individual');
    expect(values[2]).toBeNull();
    expect(values[3]).toBe('2026-11-01');
    expect(String(values[4])).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.isBuffer(values[5])).toBe(true);
    expect(values[6]).toBe('local-v1');
    await expect(make(db).startForAccount({ ...context, actor: { ...context.actor, kind: 'patient' } }, body))
      .rejects.toMatchObject({ status: 403 });
    for (const [result, status, code] of [['already_organiser', 409, 'OUTREACH_ORGANISER_ALREADY_RUNNING'],
      ['name_not_allowed', 422, 'OUTREACH_ORGANISER_NAME_NOT_ALLOWED'], ['not_eligible', 403, 'OUTREACH_ORGANISER_NOT_ELIGIBLE'],
      ['suspended', 403, 'OUTREACH_ORGANISER_SUSPENDED'], ['patient_login', 403, 'OUTREACH_ORGANISER_PATIENT_LOGIN']] as const) {
      // The result rows carry ids (already_organiser) or nulls: never read as a success.
      const refused = database({ actor: jest.fn(async () => ({ rows: [{ result, organization_id: 'org-0', facility_id: 'fac-0',
        membership_id: 'mem-0' }] })) });
      await expect(make(refused).startForAccount(context, body)).rejects.toMatchObject({ status, code });
    }
  });
});

describe('The refusal codes match migrations 0115 and 0116', () => {
  // The raise messages that reach the sign-up, invitation and support
  // commands: 0115_outreach_organisers.sql, and 0116_outreach_retention.sql
  // for support's search and deletion of a registration. When the migrations
  // are in this tree they are read too.
  const RAISED = new Set(['ADMIN_PERMISSION_DENIED', 'OUTREACH_CAMPAIGN_ADMIN_NOT_ELIGIBLE',
    'OUTREACH_CAMPAIGN_NOT_FOUND', 'OUTREACH_CAMPAIGN_REQUIRED', 'OUTREACH_CAMPAIGN_RESCUE_INVALID',
    'OUTREACH_CAMPAIGN_VERSION_CONFLICT', 'OUTREACH_CONSENT_CASE_INVALID', 'OUTREACH_CONSENT_GUARDIAN_REQUIRED',
    'OUTREACH_CONSENT_REQUIRED', 'OUTREACH_GROUP_ROLE_INVALID', 'OUTREACH_INVITATION_INVALID',
    'OUTREACH_INVITATION_PASSWORD_INVALID', 'OUTREACH_NOTES_TOO_LONG', 'OUTREACH_ORGANISER_ACCOUNT_REQUIRED',
    'OUTREACH_ORGANISER_ALREADY_SUSPENDED', 'OUTREACH_ORGANISER_EMAIL_REGISTERED',
    'OUTREACH_ORGANISER_NAME_NOT_ALLOWED', 'OUTREACH_ORGANISER_NOT_FOUND',
    'OUTREACH_ORGANISER_PASSWORD_INVALID', 'OUTREACH_ORGANISER_PERMISSION_DENIED',
    'OUTREACH_ORGANISER_SIGNUP_DENIED', 'OUTREACH_ORGANISER_SIGNUP_INVALID', 'OUTREACH_ORGANISER_SIGNUP_NOT_READY',
    'OUTREACH_ORGANISER_STATE_INVALID', 'OUTREACH_ORGANISER_SUSPENDED', 'OUTREACH_ORGANISER_SUSPEND_INVALID',
    'OUTREACH_ORGANISER_TERMS_REQUIRED', 'OUTREACH_ORGANISER_VERSION_CONFLICT', 'OUTREACH_ROLE_ONLY_AT_OUTREACH_GROUP',
    'OUTREACH_TENANT_NO_HEALTH_ID_LINK', 'OUTREACH_REGISTRATION_LOOKUP_INVALID', 'OUTREACH_REDACTION_INVALID']);
  const matched = [...OUTREACH_SIGNUP_REFUSALS.map(([code]) => code), ...OUTREACH_INVITATION_REFUSALS.map(([code]) => code),
    ...Object.keys(OUTREACH_ADMIN_REFUSALS)];

  it('matches only codes 0115 and 0116 raise', () => {
    expect(matched.filter((code) => !RAISED.has(code))).toEqual([]);
  });

  it('answers every sign-up, invitation and support refusal of 0115 and 0116', () => {
    const answered = new Set(matched);
    for (const code of ['OUTREACH_ORGANISER_EMAIL_REGISTERED', 'OUTREACH_ORGANISER_NAME_NOT_ALLOWED', 'OUTREACH_ORGANISER_SIGNUP_NOT_READY',
      'OUTREACH_ORGANISER_TERMS_REQUIRED', 'OUTREACH_ORGANISER_PASSWORD_INVALID', 'OUTREACH_ORGANISER_SIGNUP_INVALID',
      'OUTREACH_ORGANISER_SIGNUP_DENIED', 'OUTREACH_ORGANISER_ACCOUNT_REQUIRED', 'OUTREACH_ROLE_ONLY_AT_OUTREACH_GROUP',
      'OUTREACH_GROUP_ROLE_INVALID', 'OUTREACH_ORGANISER_SUSPENDED', 'OUTREACH_ORGANISER_PERMISSION_DENIED',
      'OUTREACH_INVITATION_INVALID', 'OUTREACH_INVITATION_PASSWORD_INVALID', 'OUTREACH_ORGANISER_NOT_FOUND',
      'OUTREACH_ORGANISER_VERSION_CONFLICT', 'OUTREACH_ORGANISER_ALREADY_SUSPENDED',
      'OUTREACH_ORGANISER_SUSPEND_INVALID', 'OUTREACH_ORGANISER_STATE_INVALID',
      'OUTREACH_CAMPAIGN_NOT_FOUND', 'OUTREACH_CAMPAIGN_VERSION_CONFLICT', 'OUTREACH_CAMPAIGN_RESCUE_INVALID',
      'OUTREACH_CAMPAIGN_ADMIN_NOT_ELIGIBLE', 'ADMIN_PERMISSION_DENIED', 'OUTREACH_REGISTRATION_LOOKUP_INVALID',
      'OUTREACH_REDACTION_INVALID']) {
      expect(answered.has(code)).toBe(true);
    }
  });

  const migrations = ['0115_outreach_organisers.sql', '0116_outreach_retention.sql']
    .map((name) => join(__dirname, '../../../ehr-api/database/migrations', name));
  (migrations.every((file) => existsSync(file)) ? it : it.skip)('every code matched is raised by the migrations in this tree', () => {
    const raised = new Set(migrations.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/message\s*=\s*'([A-Z_]+)'/g)].map((m) => m[1])));
    expect(matched.filter((code) => !raised.has(code))).toEqual([]);
  });

  it('answers no check before a campaign goes live (owner decision Q38)', () => {
    for (const code of ['OUTREACH_ORGANISER_AWAITING_REVIEW', 'OUTREACH_ORGANISER_NOT_PENDING', 'OUTREACH_ORGANISER_REVIEW_INVALID']) {
      expect(matched).not.toContain(code);
    }
  });
});

describe('OutreachOrganiserController', () => {
  beforeEach(() => setEnvironment());
  const loginResult = { actor: { subject: 'staff:acc-1', accountId: 'acc-1', kind: 'staff' }, accessToken: 'access',
    refreshToken: 'refresh', csrfToken: 'csrf', expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    refreshExpiresAt: new Date('2030-01-01T00:15:00.000Z') };
  const response = () => ({ cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn() });
  function make() {
    const organisers = { start: jest.fn(async () => ({ cookie: `${signupId}.${token}`, body: { accepted: true, challengeId } })),
      verify: jest.fn(async () => ({ verified: true })), availability: jest.fn(async () => ({ open: true, termsVersion: '2026-11-01' })),
      activate: jest.fn(async () => ({ organizationId: 'org-1', facilityId: 'fac-1', accountId: 'acc-1', email: 'ada.organiser@example.test' })) };
    const turnstile = { verify: jest.fn(async () => undefined) };
    const auth = { login: jest.fn(async () => loginResult) };
    const controller = new OutreachOrganiserController(organisers as unknown as OutreachOrganiserService,
      turnstile as unknown as TurnstileService, auth as unknown as AuthService);
    return { controller, organisers, turnstile, auth };
  }

  it('checks Origin, a signed-out browser and Turnstile (outreach-organiser-signup) before starting, then sets the cookie', async () => {
    const { controller, organisers, turnstile } = make();
    const res = response();
    await expect(controller.start(startInput as never, request(), res as unknown as Response))
      .resolves.toEqual({ accepted: true, challengeId });
    expect(turnstile.verify).toHaveBeenCalledWith({ token: 'opaque-proof', action: 'outreach-organiser-signup', origin,
      remoteIp: '203.0.113.10' });
    expect(res.cookie).toHaveBeenCalledWith(OUTREACH_SIGNUP_COOKIE, `${signupId}.${token}`, expect.objectContaining({
      httpOnly: true, sameSite: 'strict', secure: true, path: '/api/v1/identity/outreach-organisers' }));
    await expect(controller.start(startInput as never, request({ origin: 'https://evil.example.test' }), response() as never))
      .rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    await expect(controller.start(startInput as never, request({ cookie: 'hid_access_csrf=x' }), response() as never))
      .rejects.toMatchObject({ status: 409, code: 'OUTREACH_ORGANISER_REQUIRES_SIGN_OUT' });
    expect(organisers.start).toHaveBeenCalledTimes(1);
  });

  it('activates and signs the organiser in from outreach. (short idle lock), clearing the sign-up cookie', async () => {
    const { controller, auth } = make();
    const res = response();
    await expect(controller.activate({ termsVersion: '2026-11-01', acceptTerms: true, password: 'a-long-fictional-password' } as never,
      request({ cookie: `${OUTREACH_SIGNUP_COOKIE}=${signupId}.${token}` }), res as unknown as Response))
      .resolves.toMatchObject({ activated: true, facilityId: 'fac-1', organiserStatus: 'active',
        label: 'Unverified organiser' });
    expect(auth.login).toHaveBeenCalledWith({ email: 'ada.organiser@example.test', password: 'a-long-fictional-password' },
      expect.objectContaining({ origin }), 'staff');
    expect(res.setHeader).toHaveBeenCalledWith('x-csrf-token', 'csrf');
    expect(res.clearCookie).toHaveBeenCalledWith(OUTREACH_SIGNUP_COOKIE, expect.objectContaining({ path: '/api/v1/identity/outreach-organisers' }));
  });
});

describe('OutreachInvitationsService', () => {
  beforeEach(() => setEnvironment());
  const invitationId = '6d2d0a0a-5e78-4a3c-9f8d-3b4c5d6e7f80';
  const linkHmac = () => domainHmac(outreachKey() as Buffer, 'outreach-invitation', 'link', invitationId, token);

  it('lets only the organiser invite, with 0115\'s 4 arguments, and emails the link', async () => {
    const actor = jest.fn(async (sql: string) => sql.includes('create_outreach_invitation')
      ? { rows: [{ result: 'created', invitation_id: 'inv-1', expires_at: '2026-11-18T10:00:00.000Z', dispatch: true }] } : { rows: [] });
    const db = database({ actor });
    const notification = { deliverStaffInvitation: jest.fn(async () => ({ outcome: 'accepted' })) };
    const service = new OutreachInvitationsService(db as unknown as DatabaseService, notification as unknown as NotificationOtpClient);
    await expect(service.create(staffContext(['outreach_volunteer']), { name: 'Bola Fictional', email: 'helper@example.test' }))
      .rejects.toMatchObject({ status: 403, code: 'OUTREACH_ORGANISER_REQUIRED' });
    await expect(service.create(staffContext(['outreach_organiser']), { name: 'Bola Fictional', email: 'Helper@Example.test' }))
      .resolves.toEqual({ invitationId: 'inv-1', expiresAt: '2026-11-18T10:00:00.000Z', deliveryOutcome: 'accepted', replayed: false });
    const [sql, values] = actor.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toBe('select * from identity.create_outreach_invitation($1,$2,$3,$4)');
    expect(values).toHaveLength(4);
    expect(values[1]).toBe('Bola Fictional');
    expect(values[2]).toBe('helper@example.test');
    expect(String(values[3])).toMatch(/^[0-9a-f]{64}$/);
    // The email service's answer is recorded (10 undeliverable emails a day pause the group's invitations).
    expect(actor).toHaveBeenCalledTimes(2);
    expect(actor.mock.calls[1]).toEqual(['select identity.record_outreach_invitation_delivery($1,$2)', ['inv-1', 'accepted']]);
    const sent = (notification.deliverStaffInvitation.mock.calls[0] as unknown as [{ token: string; invitationId: string }])[0];
    expect(notification.deliverStaffInvitation).toHaveBeenCalledWith(expect.objectContaining({ roleCode: 'outreach_volunteer',
      recipient: 'helper@example.test', facilityName: 'Synthetic Community Volunteers', invitationId: 'inv-1' }));
    expect(values[3]).toBe(domainHmac(outreachKey() as Buffer, 'outreach-invitation', 'link', String(values[0]), sent.token));
  });

  it('makes the invitation but sends no email when the address already had 3 today (dispatch false)', async () => {
    const actor = jest.fn(async () => ({ rows: [{ result: 'created', invitation_id: 'inv-2',
      expires_at: '2026-11-18T10:00:00.000Z', dispatch: false }] }));
    const notification = { deliverStaffInvitation: jest.fn() };
    const service = new OutreachInvitationsService(database({ actor }) as unknown as DatabaseService,
      notification as unknown as NotificationOtpClient);
    await expect(service.create(staffContext(['outreach_organiser']), { name: 'Bola Fictional', email: 'helper@example.test' }))
      .resolves.toMatchObject({ invitationId: 'inv-2', deliveryOutcome: 'unknown' });
    expect(notification.deliverStaffInvitation).not.toHaveBeenCalled();
    expect(actor).toHaveBeenCalledTimes(1);
  });

  it('still answers when the delivery cannot be recorded', async () => {
    const actor = jest.fn(async (sql: string) => {
      if (sql.includes('record_outreach_invitation_delivery')) throw Object.assign(new Error('boom'), { code: '57014' });
      return { rows: [{ result: 'created', invitation_id: 'inv-3', expires_at: '2026-11-18T10:00:00.000Z', dispatch: true }] };
    });
    const notification = { deliverStaffInvitation: jest.fn(async () => ({ outcome: 'definitive_failure' })) };
    const service = new OutreachInvitationsService(database({ actor }) as unknown as DatabaseService,
      notification as unknown as NotificationOtpClient);
    await expect(service.create(staffContext(['outreach_organiser']), { name: 'Bola Fictional', email: 'helper@example.test' }))
      .resolves.toMatchObject({ invitationId: 'inv-3', deliveryOutcome: 'definitive_failure' });
  });

  it.each([['too_many_pending', 429, 'OUTREACH_INVITATION_PENDING_LIMIT'], ['already_member', 409, 'OUTREACH_INVITEE_ALREADY_MEMBER'],
    ['too_many_today', 429, 'OUTREACH_INVITATION_DAILY_LIMIT'], ['sending_paused', 429, 'OUTREACH_INVITATION_DELIVERY_PAUSED'],
    ['already_invited', 409, 'OUTREACH_INVITATION_ALREADY_SENT']] as const)(
    'answers the result %s plainly and sends no email', async (result, status, code) => {
    const notification = { deliverStaffInvitation: jest.fn() };
    const service = new OutreachInvitationsService(database({ actor: jest.fn(async () => ({ rows: [{ result,
      invitation_id: null, expires_at: null }] })) }) as unknown as DatabaseService, notification as unknown as NotificationOtpClient);
    await expect(service.create(staffContext(['outreach_organiser']), { name: 'Bola Fictional', email: 'helper@example.test' }))
      .rejects.toMatchObject({ status, code });
    expect(notification.deliverStaffInvitation).not.toHaveBeenCalled();
  });

  it('maps a paused group and a missing organiser role to plain problems', async () => {
    for (const [message, code, status] of [['OUTREACH_ORGANISER_SUSPENDED', 'OUTREACH_ORGANISER_SUSPENDED', 423],
      ['OUTREACH_ORGANISER_PERMISSION_DENIED', 'OUTREACH_ORGANISER_REQUIRED', 403]] as const) {
      const actor = jest.fn(async () => { throw Object.assign(new Error(message), { code: 'P0001' }); });
      const service = new OutreachInvitationsService(database({ actor }) as unknown as DatabaseService, {} as never);
      await expect(service.create(staffContext(['outreach_organiser']), { name: 'Bola Fictional', email: 'helper@example.test' }))
        .rejects.toMatchObject({ status, code });
    }
  });

  it('lists the team from list_outreach_team()', async () => {
    const actor = jest.fn(async () => ({ rows: [
      { entry_kind: 'member', entry_id: 'mem-1', full_name: 'Ada Fictional', email: 'ada@example.test', role_code: 'outreach_organiser',
        status: 'active', created_at: '2026-11-11T08:00:00.000Z', expires_at: null },
      { entry_kind: 'invitation', entry_id: 'inv-1', full_name: 'Bola Fictional', email: 'helper@example.test', role_code: 'outreach_volunteer',
        status: 'pending', created_at: '2026-11-11T09:00:00.000Z', expires_at: '2026-11-18T09:00:00.000Z' }] }));
    const db = database({ actor });
    await expect(new OutreachInvitationsService(db as unknown as DatabaseService, {} as never).list(staffContext(['outreach_organiser'])))
      .resolves.toEqual({
        members: [{ membershipId: 'mem-1', name: 'Ada Fictional', email: 'ada@example.test', roleCode: 'outreach_organiser',
          status: 'active', joinedAt: '2026-11-11T08:00:00.000Z' }],
        invitations: [{ invitationId: 'inv-1', name: 'Bola Fictional', email: 'helper@example.test', status: 'pending',
          expiresAt: '2026-11-18T09:00:00.000Z', createdAt: '2026-11-11T09:00:00.000Z', acceptedAt: null }] });
    expect(actor).toHaveBeenCalledWith('select * from identity.list_outreach_team()');
  });

  it('previews and accepts with a password by link (3 arguments), then reads the new login\'s email', async () => {
    const system = jest.fn(async (sql: string) => {
      if (sql.includes('preview_outreach_invitation')) return { rows: [{ result: 'ready', group_name: 'Synthetic Community Volunteers',
        inviter_name: 'Ada Fictional', invitee_name: 'Bola Fictional', invitee_email: 'helper@example.test', account_case: 'new',
        expires_at: '2026-11-18T09:00:00.000Z' }] };
      if (sql.includes('accept_outreach_invitation_with_password')) return { rows: [{ result: 'ready', account_id: 'acc-9',
        membership_id: 'mem-9', facility_id: 'fac-1', hid_subject: 'outreach-volunteer:acc-9' }] };
      if (sql.includes('auth.accounts')) return { rows: [{ email: 'helper@example.test' }] };
      return { rows: [] };
    });
    const service = new OutreachInvitationsService(database({ system }) as unknown as DatabaseService, {} as never);
    await expect(service.preview({ invitationId, token }, '203.0.113.10', correlationId)).resolves.toMatchObject({
      groupName: 'Synthetic Community Volunteers', inviterName: 'Ada Fictional', accountCase: 'new' });
    expect(system).toHaveBeenCalledWith('select * from identity.preview_outreach_invitation($1,$2)', [invitationId, linkHmac()]);
    await expect(service.acceptWithPassword({ invitationId, token, password: 'a-long-fictional-password',
      turnstileAction: 'outreach-invitation' }, '203.0.113.10', correlationId))
      .resolves.toEqual({ email: 'helper@example.test', facilityId: 'fac-1', membershipId: 'mem-9', roleCode: 'outreach_volunteer' });
    const accept = system.mock.calls.find(([sql]) => String(sql).includes('accept_outreach_invitation_with_password')) as unknown as [string, unknown[]];
    expect(accept[0]).toBe('select * from identity.accept_outreach_invitation_with_password($1,$2,$3)');
    expect(accept[1].slice(0, 2)).toEqual([invitationId, linkHmac()]);
    expect(String(accept[1][2])).toMatch(/^\$argon2id\$/);
    for (const [result, code] of [['sign_in_required', 'OUTREACH_INVITATION_SIGN_IN_REQUIRED'], ['invalid', 'OUTREACH_INVITATION_INVALID'],
      ['used', 'OUTREACH_INVITATION_ALREADY_ACCEPTED'], ['expired', 'OUTREACH_INVITATION_EXPIRED'],
      ['group_unavailable', 'OUTREACH_ORGANISER_SUSPENDED'], ['patient_login', 'OUTREACH_INVITATION_PATIENT_LOGIN']] as const) {
      const refused = jest.fn(async (sql: string) => sql.includes('accept_outreach') ? { rows: [{ result }] } : { rows: [] });
      await expect(new OutreachInvitationsService(database({ system: refused }) as unknown as DatabaseService, {} as never)
        .acceptWithPassword({ invitationId, token, password: 'a-long-fictional-password', turnstileAction: 'outreach-invitation' },
          '203.0.113.10', correlationId)).rejects.toMatchObject({ code });
    }
  });

  it('accepts by link for a signed-in account that also works at a hospital (owner decision 5)', async () => {
    const actor = jest.fn(async () => ({ rows: [{ result: 'ready', membership_id: 'mem-9', facility_id: 'fac-1' }] }));
    const service = new OutreachInvitationsService(database({ actor }) as unknown as DatabaseService, {} as never);
    await expect(service.acceptForAccount(staffContext(['doctor'], 'doctor@example.test'), { invitationId, token }))
      .resolves.toEqual({ accepted: true, membershipId: 'mem-9', facilityId: 'fac-1', roleCode: 'outreach_volunteer' });
    expect(actor).toHaveBeenCalledWith('select * from identity.accept_outreach_invitation_for_account($1,$2)', [invitationId, linkHmac()]);
    for (const [result, code] of [['email_mismatch', 'OUTREACH_INVITATION_WRONG_ACCOUNT'], ['already_member', 'OUTREACH_INVITEE_ALREADY_MEMBER'],
      ['not_eligible', 'OUTREACH_INVITATION_NOT_ELIGIBLE']] as const) {
      await expect(new OutreachInvitationsService(database({ actor: jest.fn(async () => ({ rows: [{ result }] })) }) as unknown as DatabaseService,
        {} as never).acceptForAccount(staffContext(['doctor']), { invitationId, token })).rejects.toMatchObject({ code });
    }
  });
});

describe('OutreachOrganisersAdminService', () => {
  beforeEach(() => setEnvironment());
  const admin: PlatformAdminContext = { correlationId, purposeOfUse: 'healthcare-operations', actor: { kind: 'staff', id: 'staff:support',
    subject: 'staff:support', accountId: 'support-1', roles: [], permissions: [], platformPermissions: ['platform.admin.access'],
    facilityIds: [], facilities: [], authenticationMethod: 'local' } };

  it('lists the groups with their version, the phone readable only here and the plain label (not read-only: 0115 audits it)', async () => {
    const key = outreachKey() as Buffer;
    const platform = jest.fn(async () => ({ rows: [{ organization_id: 'org-1', facility_id: 'fac-1', row_version: '3',
      display_name: 'Synthetic Community Volunteers', kind: 'group', registration_number: null, status: 'active',
      origin: 'signup', organiser_account_id: 'acc-1', organiser_name: 'Ada Fictional', organiser_email: 'ada.organiser@example.test',
      contact_phone_ciphertext: encryptOutreachPhone(key, '+2348012345678'), contact_key_version: 'local-v1',
      terms_version: '2026-11-01', created_at: '2026-11-11T08:00:00.000Z',
      suspended_at: null, suspension_reason: null, member_count: 3, pending_invitation_count: 1, campaign_count: 1,
      active_campaign_count: 1 }, { organization_id: 'org-2', facility_id: 'fac-2', row_version: '6',
      display_name: 'Synthetic Paused Group', kind: 'group', registration_number: null, status: 'suspended', origin: 'signup',
      organiser_account_id: 'acc-2', organiser_name: 'Bayo Fictional', organiser_email: 'bayo.organiser@example.test',
      contact_phone_ciphertext: null, contact_key_version: null, terms_version: '2026-11-01',
      created_at: '2026-11-10T08:00:00.000Z', suspended_at: '2026-11-11T09:00:00.000Z', suspension_reason: 'Reported for misuse',
      member_count: 1, pending_invitation_count: 0, campaign_count: 0, active_campaign_count: 0 }] }));
    const db = database({ platform });
    const service = new OutreachOrganisersAdminService(db as unknown as DatabaseService);
    await expect(service.list(admin, 'active')).resolves.toMatchObject({ organisers: [expect.objectContaining({ version: 3,
      phone: '+2348012345678', status: 'active', label: 'Unverified organiser', campaigns: 1, activeCampaigns: 1, members: 3,
      pendingInvitations: 1 }), expect.anything()] });
    expect(platform).toHaveBeenCalledWith('select * from identity.admin_list_outreach_organisers($1)', ['active']);
    expect(db.withPlatformTransaction.mock.calls[0]).toHaveLength(2);
    const all = await service.list(admin, undefined);
    expect(all.organisers.map((row) => [row.organizationId, row.status, row.label]))
      .toEqual([['org-1', 'active', 'Unverified organiser'], ['org-2', 'suspended', 'Paused']]);
    expect(Object.keys(all.organisers[0] ?? {}).filter((key) => /review/i.test(key))).toEqual([]);
    expect(platform).toHaveBeenLastCalledWith('select * from identity.admin_list_outreach_organisers($1)', ['all']);
    await service.list(admin, 'suspended');
    expect(platform).toHaveBeenLastCalledWith('select * from identity.admin_list_outreach_organisers($1)', ['suspended']);
  });

  it('has no review command and no review route (owner decision Q38)', () => {
    expect('review' in OutreachOrganisersAdminService.prototype).toBe(false);
    expect('review' in OutreachOrganisersAdminController.prototype).toBe(false);
  });

  it('accepts only active, suspended or all as the list filter', async () => {
    for (const [status, ok] of [['active', true], ['suspended', true], ['all', true], ['pending', false], ['reviewed', false]] as const) {
      expect((await validate(plainToInstance(ListOutreachOrganisersDto, { status }))).length === 0).toBe(ok);
    }
  });

  it('suspends, closes and appoints with 0115\'s arguments', async () => {
    const platform = jest.fn(async (sql: string) => {
      if (sql.includes('admin_suspend')) return { rows: [{ row_version: '5', revoked_roles: 2 }] };
      if (sql.includes('admin_close_outreach_campaign')) return { rows: [{ result: 'closed' }] };
      if (sql.includes('admin_appoint_outreach_campaign_admin')) return { rows: [{ result: 'appointed' }] };
      return { rows: [] };
    });
    const service = new OutreachOrganisersAdminService(database({ platform }) as unknown as DatabaseService);
    await expect(service.suspend(admin, 'org-1', 4, 'Reported for misuse')).resolves.toEqual({ organizationId: 'org-1',
      status: 'suspended', label: 'Paused', version: 5, revokedRoles: 2 });
    expect(platform).toHaveBeenCalledWith('select * from identity.admin_suspend_outreach_organiser($1,$2,$3)',
      ['org-1', 4, 'Reported for misuse']);
    await expect(service.closeCampaign(admin, 'c-1', 7, 'Only admin has left')).resolves.toEqual({ campaignId: 'c-1',
      status: 'closed', alreadyClosed: false });
    expect(platform).toHaveBeenCalledWith('select identity.admin_close_outreach_campaign($1,$2,$3) as result',
      ['c-1', 7, 'Only admin has left']);
    await expect(service.appointCampaignAdmin(admin, 'c-1', { membershipId: 'm-1', reason: 'Only admin has left' }))
      .resolves.toEqual({ campaignId: 'c-1', membershipId: 'm-1', role: 'admin', alreadyAdmin: false });
    expect(platform).toHaveBeenCalledWith('select identity.admin_appoint_outreach_campaign_admin($1,$2,$3) as result',
      ['c-1', 'm-1', 'Only admin has left']);
  });

  it('takes the version from If-Match or the body, and asks for a reload without one', () => {
    expect(outreachAdminVersion('W/"3"', undefined)).toBe(3);
    expect(outreachAdminVersion('3', 9)).toBe(3);
    expect(outreachAdminVersion(undefined, 2)).toBe(2);
    expect(() => outreachAdminVersion(undefined, undefined)).toThrow(expect.objectContaining({ status: 428 }));
  });

  it('answers 0115\'s refusals plainly: missing 404, version conflict 409, unknown 503', async () => {
    for (const [message, errcode, status] of [['OUTREACH_ORGANISER_NOT_FOUND', 'P0002', 404],
      ['OUTREACH_ORGANISER_VERSION_CONFLICT', '40001', 409], ['OUTREACH_ORGANISER_ALREADY_SUSPENDED', '23514', 409]] as const) {
      const failing = jest.fn(async () => { throw Object.assign(new Error(message), { code: errcode }); });
      await expect(new OutreachOrganisersAdminService(database({ platform: failing }) as unknown as DatabaseService)
        .suspend(admin, 'org-x', 1, 'Reported for misuse'))
        .rejects.toMatchObject({ status, code: message });
    }
    const broken = jest.fn(async () => { throw new Error('down'); });
    await expect(new OutreachOrganisersAdminService(database({ platform: broken }) as unknown as DatabaseService).list(admin, undefined))
      .rejects.toMatchObject({ status: 503 });
  });
});

describe('Support deletes a registered person\'s details at their request (0116)', () => {
  beforeEach(() => setEnvironment());
  const admin: PlatformAdminContext = { correlationId, purposeOfUse: 'healthcare-operations', actor: { kind: 'staff', id: 'staff:support',
    subject: 'staff:support', accountId: 'support-1', roles: [], permissions: [], platformPermissions: ['platform.admin.access'],
    facilityIds: [], facilities: [], authenticationMethod: 'local' } };
  // Fictional ids only.
  const organizationId = '0a5e0000-0000-4000-8000-000000000001';
  const caseId = 'ca5e0000-0000-4000-8000-000000000001';
  const temporaryPatientId = 'tmp_ca5e0000-0000-4000-8000-0000000000aa';

  it('searches by the temporary ID or the phone number with 0116\'s three arguments, and answers where and when only', async () => {
    const platform = jest.fn(async () => ({ rows: [{ case_id: caseId, group_name: 'Synthetic Community Volunteers',
      campaign_name: 'Synthetic market week', temporary_patient_id: temporaryPatientId, created_at: '2026-11-11T08:00:00.000Z',
      redacted: false }] }));
    const service = new OutreachOrganisersAdminService(database({ platform }) as unknown as DatabaseService);
    const byId = await service.findRegistrations(admin, { organizationId, temporaryPatientId });
    expect(byId).toEqual({ registrations: [{ caseId, groupName: 'Synthetic Community Volunteers',
      campaignName: 'Synthetic market week', temporaryPatientId, createdAt: '2026-11-11T08:00:00.000Z', redacted: false }] });
    expect(platform).toHaveBeenLastCalledWith('select * from identity.admin_find_outreach_registrations($1,$2,$3)',
      [organizationId, temporaryPatientId, null]);
    await service.findRegistrations(admin, { organizationId, phone: '0803 123 4567' });
    expect(platform).toHaveBeenLastCalledWith('select * from identity.admin_find_outreach_registrations($1,$2,$3)',
      [organizationId, null, '0803 123 4567']);
    // Nothing about the person is answered.
    expect(Object.keys(byId.registrations[0] ?? {}).filter((key) => /name$|phone|notes|guardian/i.test(key) && key !== 'groupName'
      && key !== 'campaignName')).toEqual([]);
  });

  it('asks for exactly one of the temporary ID and the phone number, before asking the database', async () => {
    const platform = jest.fn(async () => ({ rows: [] }));
    const service = new OutreachOrganisersAdminService(database({ platform }) as unknown as DatabaseService);
    for (const input of [{ organizationId }, { organizationId, temporaryPatientId, phone: '08031234567' }]) {
      await expect(service.findRegistrations(admin, input)).rejects.toMatchObject({ status: 400,
        code: 'OUTREACH_REGISTRATION_LOOKUP_INVALID' });
    }
    expect(platform).not.toHaveBeenCalled();
    const refusing = jest.fn(async () => { throw Object.assign(new Error('OUTREACH_REGISTRATION_LOOKUP_INVALID'), { code: '22023' }); });
    await expect(new OutreachOrganisersAdminService(database({ platform: refusing }) as unknown as DatabaseService)
      .findRegistrations(admin, { organizationId, phone: '12' })).rejects.toMatchObject({ status: 400,
      code: 'OUTREACH_REGISTRATION_LOOKUP_INVALID' });
  });

  it('takes the group as a UUID and the values trimmed, an empty one as none', async () => {
    const dto = (body: unknown) => plainToInstance(FindOutreachRegistrationsDto, body);
    expect(await validate(dto({ organizationId, temporaryPatientId: ` ${temporaryPatientId} ` }))).toHaveLength(0);
    expect(dto({ organizationId, temporaryPatientId: ` ${temporaryPatientId} ` }).temporaryPatientId).toBe(temporaryPatientId);
    expect(dto({ organizationId, phone: '   ', temporaryPatientId }).phone).toBeUndefined();
    expect((await validate(dto({ organizationId: 'org-1', temporaryPatientId }))).length).toBeGreaterThan(0);
    expect((await validate(dto({ organizationId, phone: '0'.repeat(33) }))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(RedactOutreachRegistrationDto, { reason: 'short' }))).length).toBeGreaterThan(0);
    expect(await validate(plainToInstance(RedactOutreachRegistrationDto, { reason: 'The person asked by phone.' }))).toHaveLength(0);
  });

  it('deletes with 0116\'s two arguments, and says plainly when there is nothing to delete', async () => {
    const platform = jest.fn(async () => ({ rows: [{ result: 'redacted' }] }));
    const service = new OutreachOrganisersAdminService(database({ platform }) as unknown as DatabaseService);
    await expect(service.redactRegistration(admin, caseId, 'The person asked by phone.')).resolves
      .toEqual({ caseId, outcome: 'redacted' });
    expect(platform).toHaveBeenCalledWith('select identity.admin_redact_outreach_registration($1,$2) as result',
      [caseId, 'The person asked by phone.']);
    const nothing = jest.fn(async () => ({ rows: [{ result: 'not_redactable' }] }));
    await expect(new OutreachOrganisersAdminService(database({ platform: nothing }) as unknown as DatabaseService)
      .redactRegistration(admin, caseId, 'The person asked by phone.'))
      .rejects.toMatchObject({ status: 409, code: 'OUTREACH_REGISTRATION_NOT_REDACTABLE' });
    for (const [message, errcode, status] of [['OUTREACH_REDACTION_INVALID', '22023', 422],
      ['ADMIN_PERMISSION_DENIED', '42501', 403]] as const) {
      const failing = jest.fn(async () => { throw Object.assign(new Error(message), { code: errcode }); });
      await expect(new OutreachOrganisersAdminService(database({ platform: failing }) as unknown as DatabaseService)
        .redactRegistration(admin, caseId, 'The person asked by phone.')).rejects.toMatchObject({ status, code: message });
    }
  });

  it('needs platform.facility.manage and platform.facility.unlock on both routes', () => {
    for (const handler of [OutreachRegistrationsAdminController.prototype.search, OutreachRegistrationsAdminController.prototype.redact]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['platform.facility.manage', 'platform.facility.unlock']);
    }
  });
});

describe('OutreachRetentionSweeper (owner decision 3: 1 year, then redacted)', () => {
  beforeEach(() => setEnvironment());

  it('calls 0116\'s identity.sweep_expired_outreach_registrations with a bounded batch as system:auth', async () => {
    const system = jest.fn(async () => ({ rows: [{ redacted: '3' }] }));
    const db = database({ system });
    await expect(new OutreachRetentionSweeper(db as unknown as DatabaseService).runOnce()).resolves.toBe(3);
    expect(system).toHaveBeenCalledWith('select identity.sweep_expired_outreach_registrations($1) as redacted',
      [OUTREACH_RETENTION_SWEEP_BATCH]);
    expect(OUTREACH_RETENTION_SWEEP_BATCH).toBeGreaterThanOrEqual(1);
    expect(OUTREACH_RETENTION_SWEEP_BATCH).toBeLessThanOrEqual(5000);
    expect(String(db.withSystemTransaction.mock.calls[0]?.[0])).toMatch(/^outreach-retention-/);
  });

  it('never throws: a failure answers null', async () => {
    const db = database({ system: jest.fn(async () => { throw Object.assign(new Error('x'), { code: '42501' }); }) });
    await expect(new OutreachRetentionSweeper(db as unknown as DatabaseService).runOnce()).resolves.toBeNull();
  });

  it('starts no timer under test', () => {
    const sweeper = new OutreachRetentionSweeper({} as never);
    sweeper.onApplicationBootstrap();
    expect((sweeper as unknown as { timer?: unknown }).timer).toBeUndefined();
  });
});

describe('IdentityController.authorizeOutreachPatient at an outreach group', () => {
  beforeEach(() => setEnvironment());

  it('refuses 403 OUTREACH_TENANT_NO_HEALTH_ID_LINK and never asks for an authorization', async () => {
    const authorize = jest.fn();
    const workload = { authenticateOutreach: jest.fn(async () => undefined) };
    const controller = new IdentityController({ authorize } as never, workload as never);
    const context = staffContext(['outreach_volunteer']);
    const req = { ...request(), correlationId, actor: context.actor, facilityId: context.facilityId } as unknown as HidRequest;
    await expect(controller.authorizeOutreachPatient({ patientId: 'p-1', scope: 'write_records', purpose: 'direct-care' } as never, req))
      .rejects.toMatchObject({ status: 403, code: 'OUTREACH_TENANT_NO_HEALTH_ID_LINK' });
    expect(authorize).not.toHaveBeenCalled();
    const hospital = staffContext(['nurse']);
    authorize.mockResolvedValue({ allowed: true });
    await expect(controller.authorizeOutreachPatient({ patientId: 'p-1', scope: 'write_records', purpose: 'direct-care' } as never,
      { ...request(), correlationId, actor: hospital.actor, facilityId: hospital.facilityId } as unknown as HidRequest))
      .resolves.toEqual({ allowed: true });
  });
});

it('DomainProblem keeps the code', () => {
  expect(new DomainProblem(409, 'X', 'y').code).toBe('X');
});
