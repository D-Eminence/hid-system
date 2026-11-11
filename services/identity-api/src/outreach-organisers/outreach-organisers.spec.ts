jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

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
import { OutreachInvitationsService } from './outreach-invitations.service';
import { decryptOutreachPhone, domainHmac, encryptOutreachPhone, normalizeOutreachPhone, outreachKey,
  reservedOrganiserName } from './outreach-organiser-crypto';
import { assertOutreachSignupOpen } from './outreach-organiser-gate';
import { OUTREACH_SIGNUP_COOKIE, OutreachOrganiserController } from './outreach-organiser.controller';
import { OutreachOrganiserService } from './outreach-organiser.service';
import { ONE_CLICK_REVIEW_REASON, OutreachOrganisersAdminService } from './outreach-organisers-admin';

// Fictional test data only.
const origin = 'https://outreach.healthidentitydirectory.com';
const correlationId = 'outreach-organiser-test';
const signupId = '4b0b8f8e-3c56-4e1a-9d6b-1f2a3b4c5d6e';
const challengeId = '5c1c9f9f-4d67-4f2b-8e7c-2a3b4c5d6e7f';
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

  it('starts a sign-up: quota and network window first, then the command with HMACs only, then the email', async () => {
    // Answer with the ids the service sent.
    const system = jest.fn(async (sql: string, values?: unknown[]) => sql.includes('start_outreach_organiser_signup')
      ? { rows: [{ outcome: 'code_issued', signup_id: values?.[0], challenge_id: values?.[10], resend_after_seconds: 60 }] }
      : { rows: [] });
    const db = database({ system });
    const otp = notification();
    const started = await make(db, otp).start(plainToInstance(StartOutreachOrganiserSignupDto, startInput), '203.0.113.10', correlationId);
    expect(started.cookie).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(started.body).toMatchObject({ accepted: true, expiresInSeconds: 300, resendAfterSeconds: 60 });
    const sqls = system.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((sql) => sql.includes('platform.consume_public_application_quota'))).toBe(true);
    const command = system.mock.calls.find((call) => String(call[0]).includes('start_outreach_organiser_signup')) as unknown[];
    const values = command[1] as unknown[];
    expect(values).toHaveLength(15);
    expect(values[2]).toBe('ada.organiser@example.test');
    expect(String(values[3])).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.isBuffer(values[4])).toBe(true);
    expect(values.map(String).join('|')).not.toContain('2348012345678');
    expect(values[6]).toBe('Synthetic Community Volunteers');
    expect(otp.deliver).toHaveBeenCalledWith(expect.objectContaining({ recipient: 'ada.organiser@example.test',
      purpose: 'SIGNUP_VERIFY', channel: 'email' }));
    // The code the email carries is the one the database holds as an HMAC.
    const code = (otp.deliver.mock.calls[0] as unknown as [{ code: string; challengeId: string }])[0];
    expect(values[11]).toBe(domainHmac(outreachKey() as Buffer, 'outreach-organiser-signup', 'otp',
      String(values[0]), code.challengeId, code.code));
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
      '203.0.113.10', correlationId)).rejects.toMatchObject({ status: 422, code: 'OUTREACH_ORGANISER_NAME_RESERVED' });
    await expect(make(db).start(plainToInstance(StartOutreachOrganiserSignupDto, { ...startInput, phone: '12345' }),
      '203.0.113.10', correlationId)).rejects.toMatchObject({ status: 400, code: 'OUTREACH_PHONE_INVALID' });
    expect(db.withSystemTransaction).not.toHaveBeenCalled();
  });

  it('answers 429 when the network window or the public application quota is spent', async () => {
    const quota = jest.fn(async (sql: string) => {
      if (sql.includes('consume_public_application_quota')) throw Object.assign(new Error('limited'), { code: 'P4290' });
      return { rows: [] };
    });
    await expect(make(database({ system: quota })).start(plainToInstance(StartOutreachOrganiserSignupDto, startInput),
      '203.0.113.10', correlationId)).rejects.toMatchObject({ status: 429, code: 'OUTREACH_ORGANISER_SIGNUP_RATE_LIMITED' });
  });

  it('verifies the code against the cookie and answers each result plainly', async () => {
    const cookie = `${signupId}.${token}`;
    for (const [result, expected] of [['verified', { verified: true }], ['invalid_code', 'OTP_INVALID'], ['expired', 'OTP_EXPIRED'],
      ['attempts_exhausted', 'OTP_ATTEMPTS_EXHAUSTED'], ['not_found', 'OUTREACH_ORGANISER_SIGNUP_SESSION_INVALID']] as const) {
      const system = jest.fn(async () => ({ rows: [{ result }] }));
      const call = make(database({ system })).verify(cookie, challengeId, '123456', correlationId);
      if (typeof expected === 'object') await expect(call).resolves.toEqual(expected);
      else await expect(call).rejects.toMatchObject({ code: expected });
      const values = (system.mock.calls[0] as unknown as [string, unknown[]])[1];
      expect(values[0]).toBe(signupId);
      expect(values[1]).toBe(domainHmac(outreachKey() as Buffer, 'outreach-organiser-signup', 'cookie', token));
    }
    await expect(make(database()).verify('not-a-cookie', challengeId, '123456', correlationId))
      .rejects.toMatchObject({ status: 401 });
  });

  it('activates with an argon2 hash and the approved terms version', async () => {
    const system = jest.fn(async () => ({ rows: [{ organization_id: 'org-1', facility_id: 'fac-1', account_id: 'acc-1',
      membership_id: 'mem-1', email: 'ada.organiser@example.test' }] }));
    await expect(make(database({ system })).activate(`${signupId}.${token}`,
      plainToInstance(ActivateOutreachOrganiserDto, { termsVersion: '2026-11-01', acceptTerms: true,
        password: 'a-long-fictional-password' }), correlationId))
      .resolves.toMatchObject({ organizationId: 'org-1', facilityId: 'fac-1', email: 'ada.organiser@example.test' });
    const values = (system.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(String(values[2])).toMatch(/^\$argon2id\$/);
    expect(values[3]).toBe('2026-11-01');
  });

  it('maps the database refusals of activation to plain problems', async () => {
    const service = make(database());
    expect(service.mapError({ code: 'P0001', message: 'OUTREACH_ORGANISER_EMAIL_REGISTERED' }))
      .toMatchObject({ status: 409, code: 'OUTREACH_ORGANISER_EMAIL_REGISTERED' });
    expect(service.mapError({ code: 'P0001', message: 'OUTREACH_ORGANISER_NAME_RESERVED' }))
      .toMatchObject({ status: 422 });
    expect(service.mapError({ code: '23505', message: 'duplicate key' })).toMatchObject({ status: 409 });
    expect(service.mapError({ code: '55000', message: 'PLATFORM_CONTROL_DISABLED:outreach_organiser_signup_enabled' }))
      .toMatchObject({ status: 423 });
    expect(service.mapError(new Error('boom'))).toMatchObject({ status: 503 });
  });

  it('starts an outreach group for a signed-in staff account as that account (owner decision 5)', async () => {
    const actor = jest.fn(async () => ({ rows: [{ organization_id: 'org-2', facility_id: 'fac-2', membership_id: 'mem-2' }] }));
    const db = database({ actor });
    const context = staffContext(['doctor'], 'doctor@example.test');
    await expect(make(db).startForAccount(context, { groupName: 'Synthetic Street Health', kind: 'individual',
      phone: '08012345678', termsVersion: '2026-11-01', acceptTerms: true }))
      .resolves.toEqual({ started: true, organizationId: 'org-2', facilityId: 'fac-2', membershipId: 'mem-2', reviewState: 'pending' });
    expect(db.withTransaction).toHaveBeenCalledWith(context, expect.any(Function));
    const [sql, values] = actor.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('identity.activate_outreach_organiser_for_account($1,$2,$3,$4,$5,$6)');
    expect(values[0]).toBe('Synthetic Street Health');
    expect(values[5]).toBe('2026-11-01');
    await expect(make(db).startForAccount({ ...context, actor: { ...context.actor, kind: 'patient' } },
      { groupName: 'X group', kind: 'individual', phone: '08012345678', termsVersion: '2026-11-01', acceptTerms: true }))
      .rejects.toMatchObject({ status: 403 });
    expect(make(db).mapError({ code: 'P0001', message: 'OUTREACH_ORGANISER_ALREADY_RUNNING' }))
      .toMatchObject({ status: 409, code: 'OUTREACH_ORGANISER_ALREADY_RUNNING' });
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
      .resolves.toMatchObject({ activated: true, facilityId: 'fac-1', reviewState: 'pending' });
    expect(auth.login).toHaveBeenCalledWith({ email: 'ada.organiser@example.test', password: 'a-long-fictional-password' },
      expect.objectContaining({ origin }), 'staff');
    expect(res.setHeader).toHaveBeenCalledWith('x-csrf-token', 'csrf');
    expect(res.clearCookie).toHaveBeenCalledWith(OUTREACH_SIGNUP_COOKIE, expect.objectContaining({ path: '/api/v1/identity/outreach-organisers' }));
  });
});

describe('OutreachInvitationsService', () => {
  beforeEach(() => setEnvironment());
  const createRow = { invitation_id: 'inv-1', row_version: 1, send_id: 'send-1', expires_at: '2026-11-18T10:00:00.000Z',
    replayed: false, dispatch: true, facility_name: 'Synthetic Community Volunteers', role_code: 'outreach_volunteer',
    invitee_email: 'helper@example.test' };

  it('lets only the organiser invite, and always as outreach_volunteer', async () => {
    const actor = jest.fn(async (sql: string) => sql.includes('create_outreach_invitation') ? { rows: [createRow] } : { rows: [] });
    const db = database({ actor });
    const notification = { deliverStaffInvitation: jest.fn(async () => ({ outcome: 'accepted' })) };
    const service = new OutreachInvitationsService(db as unknown as DatabaseService, notification as unknown as NotificationOtpClient);
    await expect(service.create(staffContext(['outreach_volunteer']), { name: 'Bola Fictional', email: 'helper@example.test' }, 'key-1'))
      .rejects.toMatchObject({ status: 403, code: 'OUTREACH_ORGANISER_REQUIRED' });
    await expect(service.create(staffContext(['outreach_organiser']), { name: 'Bola Fictional', email: 'Helper@Example.test' }, 'key-1'))
      .resolves.toMatchObject({ status: 201, body: { invitationId: 'inv-1', deliveryOutcome: 'accepted', replayed: false } });
    expect(notification.deliverStaffInvitation).toHaveBeenCalledWith(expect.objectContaining({ roleCode: 'outreach_volunteer',
      recipient: 'helper@example.test', facilityName: 'Synthetic Community Volunteers' }));
    expect(actor.mock.calls.some(([sql]) => String(sql).includes('record_outreach_invitation_delivery'))).toBe(true);
    const values = (actor.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(values[3]).toBe('helper@example.test');
  });

  it('maps the pending cap and a paused group to plain problems', async () => {
    for (const [message, code, status] of [['OUTREACH_INVITATION_PENDING_LIMIT', 'OUTREACH_INVITATION_PENDING_LIMIT', 429],
      ['OUTREACH_ORGANISATION_SUSPENDED', 'OUTREACH_ORGANISATION_SUSPENDED', 423]] as const) {
      const actor = jest.fn(async () => { throw Object.assign(new Error(message), { code: 'P0001' }); });
      const service = new OutreachInvitationsService(database({ actor }) as unknown as DatabaseService, {} as never);
      await expect(service.create(staffContext(['outreach_organiser']), { name: 'Bola Fictional', email: 'helper@example.test' }, 'key-2'))
        .rejects.toMatchObject({ status, code });
    }
  });

  it('accepts with a password by link, and answers a refused result plainly', async () => {
    const system = jest.fn(async (sql: string) => sql.includes('accept_outreach_invitation_with_password')
      ? { rows: [{ result: 'ready', email: 'helper@example.test', facility_id: 'fac-1', facility_name: 'Synthetic Community Volunteers',
        role_code: 'outreach_volunteer', membership_id: 'mem-1' }] } : { rows: [] });
    const service = new OutreachInvitationsService(database({ system }) as unknown as DatabaseService, {} as never);
    await expect(service.acceptWithPassword({ invitationId: '6d2d0a0a-5e78-4a3c-9f8d-3b4c5d6e7f80', token,
      password: 'a-long-fictional-password', turnstileAction: 'outreach-invitation' }, '203.0.113.10', correlationId))
      .resolves.toEqual({ email: 'helper@example.test', facilityId: 'fac-1', facilityName: 'Synthetic Community Volunteers',
        roleCode: 'outreach_volunteer' });
    const refused = jest.fn(async (sql: string) => sql.includes('accept_outreach') ? { rows: [{ result: 'account_exists' }] } : { rows: [] });
    await expect(new OutreachInvitationsService(database({ system: refused }) as unknown as DatabaseService, {} as never)
      .acceptWithPassword({ email: 'helper@example.test', code: '123456', password: 'a-long-fictional-password',
        turnstileAction: 'outreach-invitation' }, '203.0.113.10', correlationId))
      .rejects.toMatchObject({ status: 409, code: 'OUTREACH_INVITATION_SIGN_IN_REQUIRED' });
  });

  it('accepts for a signed-in account that also works at a hospital (owner decision 5)', async () => {
    const actor = jest.fn(async () => ({ rows: [{ result: 'ready', membership_id: 'mem-9', facility_id: 'fac-1',
      facility_name: 'Synthetic Community Volunteers', role_code: 'outreach_volunteer' }] }));
    const service = new OutreachInvitationsService(database({ actor }) as unknown as DatabaseService, {} as never);
    await expect(service.acceptForAccount(staffContext(['doctor'], 'doctor@example.test'), { code: '654321' }))
      .resolves.toMatchObject({ accepted: true, membershipId: 'mem-9', roleCode: 'outreach_volunteer' });
    const values = (actor.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(values[2]).toBe(domainHmac(outreachKey() as Buffer, 'outreach-invitation', 'email-code', 'doctor@example.test', '654321'));
  });
});

describe('OutreachOrganisersAdminService', () => {
  beforeEach(() => setEnvironment());
  const admin: PlatformAdminContext = { correlationId, purposeOfUse: 'healthcare-operations', actor: { kind: 'staff', id: 'staff:support',
    subject: 'staff:support', accountId: 'support-1', roles: [], permissions: [], platformPermissions: ['platform.admin.access'],
    facilityIds: [], facilities: [], authenticationMethod: 'local' } };

  it('lists the queue with the phone readable only here and the plain label', async () => {
    const key = outreachKey() as Buffer;
    const platform = jest.fn(async () => ({ rows: [{ organization_id: 'org-1', facility_id: 'fac-1', display_name: 'Synthetic Community Volunteers',
      group_name: 'Synthetic Community Volunteers', kind: 'group', registration_number: null, organiser_name: 'Ada Fictional',
      organiser_email: 'ada.organiser@example.test', phone_ciphertext: encryptOutreachPhone(key, '+2348012345678'),
      review_state: 'pending', reviewed_at: null, suspended_at: null, created_at: '2026-11-11T08:00:00.000Z',
      terms_version: '2026-11-01', campaign_count: '1', member_count: '3', registration_count: '0' }] }));
    const service = new OutreachOrganisersAdminService(database({ platform }) as unknown as DatabaseService);
    await expect(service.list(admin, 'pending')).resolves.toEqual({ organisers: [expect.objectContaining({
      phone: '+2348012345678', label: 'Unverified organiser', campaigns: 1, members: 3, registrations: 0 })] });
    expect(platform).toHaveBeenCalledWith('select * from identity.admin_list_outreach_organisers($1)', ['pending']);
  });

  it('reviews in one click with a default note, and suspends, closes and appoints with a reason', async () => {
    const platform = jest.fn(async (sql: string) => {
      if (sql.includes('admin_review')) return { rows: [{ organization_id: 'org-1', review_state: 'reviewed', display_name: 'X', reviewed_at: new Date() }] };
      if (sql.includes('admin_suspend')) return { rows: [{ organization_id: 'org-1', review_state: 'suspended', suspended_at: new Date() }] };
      if (sql.includes('admin_close_campaign')) return { rows: [{ campaign_id: 'c-1', status: 'closed', row_version: '4' }] };
      if (sql.includes('admin_appoint_campaign_admin')) return { rows: [{ campaign_id: 'c-1', membership_id: 'm-1', role: 'admin' }] };
      return { rows: [] };
    });
    const service = new OutreachOrganisersAdminService(database({ platform }) as unknown as DatabaseService);
    await expect(service.review(admin, 'org-1', {})).resolves.toMatchObject({ reviewState: 'reviewed' });
    expect(platform).toHaveBeenCalledWith('select * from identity.admin_review_outreach_organiser($1,$2,$3)',
      ['org-1', null, ONE_CLICK_REVIEW_REASON]);
    await expect(service.suspend(admin, 'org-1', 'Reported for misuse')).resolves.toMatchObject({ reviewState: 'suspended' });
    await expect(service.closeCampaign(admin, 'c-1', 'Only admin has left')).resolves.toEqual({ campaignId: 'c-1', status: 'closed', version: 4 });
    await expect(service.appointCampaignAdmin(admin, 'c-1', { membershipId: 'm-1', reason: 'Only admin has left' }))
      .resolves.toEqual({ campaignId: 'c-1', membershipId: 'm-1', role: 'admin' });
  });

  it('answers a missing group with 404 and an unknown fault with 503', async () => {
    const missing = jest.fn(async () => { throw Object.assign(new Error('OUTREACH_ORGANISATION_NOT_FOUND'), { code: 'P0002' }); });
    await expect(new OutreachOrganisersAdminService(database({ platform: missing }) as unknown as DatabaseService).review(admin, 'org-x', {}))
      .rejects.toMatchObject({ status: 404 });
    const broken = jest.fn(async () => { throw new Error('down'); });
    await expect(new OutreachOrganisersAdminService(database({ platform: broken }) as unknown as DatabaseService).list(admin, undefined))
      .rejects.toMatchObject({ status: 503 });
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
