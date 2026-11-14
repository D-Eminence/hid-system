jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));
// The real argon2id hash, watched so the test can see the secret it was given.
jest.mock('../auth/password-hash', () => {
  const actual = jest.requireActual<typeof import('../auth/password-hash')>('../auth/password-hash');
  return { ...actual, hashAccountPassword: jest.fn(actual.hashAccountPassword) };
});

import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import { hashAccountPassword } from '../auth/password-hash';
import type { TokenService } from '../auth/token.service';
import type { TurnstileService } from '../auth/turnstile.service';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY, PUBLIC_ROUTE } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { AcceptOutreachInvitationByLinkDto } from './dto/outreach-organiser.dto';
import { OutreachInvitationsLinkController } from './outreach-invitations.controller';
import { OutreachInvitationsService } from './outreach-invitations.service';
import { domainHmac, outreachKey } from './outreach-organiser-crypto';
import { OutreachOrganisersModule } from './outreach-organisers.module';

// Fictional test data only.
const origin = 'https://outreach.healthidentitydirectory.com';
const correlationId = 'outreach-link-test';
const invitationId = '6d2d0a0a-5e78-4a3c-9f8d-3b4c5d6e7f80';
const token = 'A'.repeat(43);
const accountId = '42000000-0000-4000-8000-000000000001';
const subject = `outreach-volunteer:${accountId}`;
const input = { invitationId, token, turnstileAction: 'outreach-invitation' as const, turnstileToken: 'opaque-proof',
  device: 'own' as const };
const ARGON2ID = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/;

const original = { ...process.env };
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
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  resetEnvironmentForTests();
  jest.restoreAllMocks();
});

function request(options: { cookie?: string; origin?: string | null; authorization?: string } = {}): HidRequest {
  return { correlationId, ip: '203.0.113.10', header: jest.fn((name: string) => {
    if (name === 'origin') return options.origin === null ? undefined : options.origin ?? origin;
    if (name === 'cookie') return options.cookie;
    if (name === 'authorization') return options.authorization;
    if (name === 'user-agent') return 'synthetic-agent';
    return undefined;
  }) } as unknown as HidRequest;
}

function database(system: jest.Mock) {
  return {
    query: jest.fn(),
    withSystemTransaction: jest.fn(async (_id: string, work: (client: PoolClient) => Promise<unknown>) =>
      work({ query: system } as unknown as PoolClient)),
    withTransaction: jest.fn(),
  };
}

/** The database as the accept command answers `result` (and the network window `limited`). */
function acceptingSystem(result = 'ready', limited = false) {
  return jest.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes('from auth.otp_rate_limits')) {
      return { rows: limited ? [{ request_count: 21, window_started_at: new Date(),
        blocked_until: new Date(Date.now() + 3_600_000) }] : [], rowCount: limited ? 1 : 0 };
    }
    if (sql.includes('otp_rate_limits') || sql.includes('advisory')) return { rows: [], rowCount: 1 };
    if (sql.includes('accept_outreach_invitation_with_password')) {
      return { rows: [result === 'ready'
        ? { result, account_id: accountId, membership_id: 'mem-9', facility_id: 'fac-1', hid_subject: subject }
        : { result, account_id: null, membership_id: null, facility_id: null, hid_subject: null }] };
    }
    if (sql.includes('from auth.accounts')) return { rows: [{ subject }] };
    return { rows: [] };
  });
}

const loginResult = (longVolunteerSession: boolean) => ({
  actor: { kind: 'staff', subject, accountId, sessionId: 'session-1', roles: ['outreach_volunteer'], permissions: [],
    facilityIds: ['fac-1'], facilities: [], authenticationMethod: 'local',
    facility: { id: 'fac-1', membershipId: 'mem-9', organizationId: 'org-1', name: 'Synthetic Community Volunteers',
      roles: ['outreach_volunteer'], permissions: [], isPrimary: true } },
  accessToken: 'access', refreshToken: 'refresh', csrfToken: 'csrf',
  expiresAt: new Date('2026-11-14T09:15:00.000Z'),
  refreshExpiresAt: new Date(longVolunteerSession ? '2026-11-21T09:00:00.000Z' : '2026-11-15T09:00:00.000Z'),
  longVolunteerSession,
});

function make(options: { system?: jest.Mock; issue?: jest.Mock; audit?: jest.Mock; order?: string[] } = {}) {
  const order = options.order ?? [];
  const system = options.system ?? acceptingSystem();
  const db = database(jest.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('from auth.otp_rate_limits')) order.push('network');
    return system(sql, values);
  }));
  const service = new OutreachInvitationsService(db as unknown as DatabaseService, {} as NotificationOtpClient);
  const turnstile = { verify: jest.fn(async () => { order.push('turnstile'); }) };
  const issue = options.issue ?? jest.fn(async () => loginResult(true));
  const revoke = jest.fn(async () => undefined);
  const tokens = { issue, revoke };
  const record = options.audit ?? jest.fn(async () => undefined);
  const controller = new OutreachInvitationsLinkController(service, turnstile as unknown as TurnstileService,
    tokens as unknown as TokenService, { record } as unknown as AuditService);
  return { controller, service, turnstile, tokens, issue, revoke, record, system, order, db };
}

const response = () => ({ cookie: jest.fn(), setHeader: jest.fn() });

describe('POST /identity/outreach-invitations/accept-link: the switch', () => {
  it('answers 404 while OUTREACH_INVITE_LINK_SIGN_IN_ENABLED is off (the default), before Origin and Turnstile', async () => {
    setEnvironment();
    const { controller, turnstile, system, issue } = make();
    for (const req of [request(), request({ origin: 'https://evil.example.test' }), request({ cookie: 'hid_access=x' })]) {
      await expect(controller.accept(input, req, response() as unknown as Response)).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(turnstile.verify).not.toHaveBeenCalled();
    expect(system).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it('is a public route that audits failures only, under its own action, registered in the module', () => {
    expect(Reflect.getMetadata(PUBLIC_ROUTE, OutreachInvitationsLinkController)).toBe(true);
    expect(Reflect.getMetadata(AUDIT_FAILURES_ONLY, OutreachInvitationsLinkController)).toBe(true);
    expect(Reflect.getMetadata(AUDIT_ACTION, OutreachInvitationsLinkController.prototype.accept))
      .toBe('identity.outreach-invitation.accept-link');
    expect(Reflect.getMetadata('path', OutreachInvitationsLinkController)).toBe('identity/outreach-invitations/accept-link');
    const controllers = Reflect.getMetadata('controllers', OutreachOrganisersModule) as unknown[];
    expect(controllers).toContain(OutreachInvitationsLinkController);
  });
});

describe('POST /identity/outreach-invitations/accept-link with the switch on', () => {
  beforeEach(() => setEnvironment({ OUTREACH_INVITE_LINK_SIGN_IN_ENABLED: 'true' }));

  it('checks Origin, then a signed-out browser (409), then Turnstile, then the network window (429)', async () => {
    const denied = make();
    await expect(denied.controller.accept(input, request({ origin: 'https://evil.example.test' }), response() as never))
      .rejects.toMatchObject({ status: 403, code: 'ORIGIN_DENIED' });
    await expect(denied.controller.accept(input, request({ origin: null, cookie: 'hid_access=x' }), response() as never))
      .rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    for (const signedIn of [{ cookie: 'hid_access=x' }, { cookie: 'hid_access_csrf=x' }, { authorization: 'Bearer x' }]) {
      await expect(denied.controller.accept(input, request(signedIn), response() as never))
        .rejects.toMatchObject({ status: 409, code: 'OUTREACH_INVITATION_REQUIRES_SIGN_OUT' });
    }
    expect(denied.turnstile.verify).not.toHaveBeenCalled();
    expect(denied.system).not.toHaveBeenCalled();

    const refusedProof = make();
    refusedProof.turnstile.verify.mockRejectedValueOnce(new DomainProblem(403, 'TURNSTILE_FAILED', 'Refused'));
    await expect(refusedProof.controller.accept(input, request(), response() as never)).rejects.toMatchObject({ code: 'TURNSTILE_FAILED' });
    expect(refusedProof.system).not.toHaveBeenCalled();

    const order: string[] = [];
    const limited = make({ system: acceptingSystem('ready', true), order });
    await expect(limited.controller.accept(input, request(), response() as never))
      .rejects.toMatchObject({ status: 429, code: 'OUTREACH_INVITATION_RATE_LIMITED' });
    expect(order).toEqual(['turnstile', 'network']);
    expect(limited.system.mock.calls.some(([sql]) => String(sql).includes('accept_outreach'))).toBe(false);
    expect(limited.turnstile.verify).toHaveBeenCalledWith({ token: 'opaque-proof', action: 'outreach-invitation', origin,
      remoteIp: '203.0.113.10' });
  });

  it('gives the command an argon2id hash of a secret that appears nowhere, and signs the phone in', async () => {
    jest.mocked(hashAccountPassword).mockClear();
    const { controller, system, issue, record } = make();
    const res = response();
    const answer = await controller.accept(input, request(), res as unknown as Response);
    const accept = system.mock.calls.find(([sql]) => String(sql).includes('accept_outreach')) as unknown as [string, unknown[]];
    expect(accept[0]).toBe('select * from identity.accept_outreach_invitation_with_password($1,$2,$3)');
    expect(accept[1].slice(0, 2)).toEqual([invitationId,
      domainHmac(outreachKey() as Buffer, 'outreach-invitation', 'link', invitationId, token)]);
    expect(String(accept[1][2])).toMatch(ARGON2ID);
    // The secret is random (32 bytes) and goes only into the hash: the database, the session, the audit, the
    // cookies and the answer never carry it.
    expect(hashAccountPassword).toHaveBeenCalledTimes(1);
    const secret = jest.mocked(hashAccountPassword).mock.calls[0]?.[0] as string;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const everything = JSON.stringify([system.mock.calls, issue.mock.calls, record.mock.calls, res.cookie.mock.calls,
      res.setHeader.mock.calls, answer]);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain('"password"');

    expect(issue).toHaveBeenCalledWith({ subject, accountId, actorKind: 'staff', displayName: '', facilities: [],
      authenticationMethod: 'local', signInVia: 'invitation_link', deviceTrust: 'own_device' },
    { correlationId, sourceIp: '203.0.113.10', userAgent: 'synthetic-agent', origin });
    expect(res.cookie).toHaveBeenCalledWith('hid_access', 'access', expect.objectContaining({ httpOnly: true, secure: true }));
    expect(res.cookie).toHaveBeenCalledWith('hid_access_refresh', 'refresh', expect.objectContaining({ path: '/api/v1/auth' }));
    expect(res.cookie).toHaveBeenCalledWith('hid_access_csrf', 'csrf', expect.objectContaining({ httpOnly: false }));
    expect(res.setHeader).toHaveBeenCalledWith('x-csrf-token', 'csrf');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.login', outcome: 'success',
      resourceType: 'session', resourceId: 'session-1', actorSubject: subject,
      details: { sign_in_via: 'invitation_link', device_trust: 'own_device', device_requested: 'own_device' } }));
    expect(answer).toEqual({ accepted: true, signedIn: true, facilityId: 'fac-1', membershipId: 'mem-9',
      roleCode: 'outreach_volunteer', actor: loginResult(true).actor, expiresAt: '2026-11-14T09:15:00.000Z',
      signedInUntil: '2026-11-21T09:00:00.000Z', deviceTrust: 'own_device' });
  });

  it('asks for the standard session on a shared phone, and answers the session the phone really got', async () => {
    const shared = make({ issue: jest.fn(async () => loginResult(false)) });
    await expect(shared.controller.accept({ ...input, device: 'shared' }, request(), response() as never))
      // Today's outreach lifetime: signed in until 24 hours after sign-in.
      .resolves.toMatchObject({ signedIn: true, deviceTrust: 'standard', signedInUntil: '2026-11-15T09:00:00.000Z' });
    expect(shared.issue).toHaveBeenCalledWith(expect.objectContaining({ deviceTrust: 'standard', signInVia: 'invitation_link' }),
      expect.anything());
    // "Own phone" asked, but the long session was not given (its switch off, or not volunteer-only).
    const notGranted = make({ issue: jest.fn(async () => loginResult(false)) });
    await expect(notGranted.controller.accept(input, request(), response() as never))
      .resolves.toMatchObject({ signedIn: true, deviceTrust: 'standard' });
    expect(notGranted.record).toHaveBeenCalledWith(expect.objectContaining({ details: { sign_in_via: 'invitation_link',
      device_trust: 'standard', device_requested: 'own_device' } }));
  });

  it.each([
    ['invalid', 400, 'OUTREACH_INVITATION_INVALID'], ['expired', 410, 'OUTREACH_INVITATION_EXPIRED'],
    ['used', 409, 'OUTREACH_INVITATION_ALREADY_ACCEPTED'], ['group_unavailable', 423, 'OUTREACH_ORGANISER_SUSPENDED'],
    ['sign_in_required', 409, 'OUTREACH_INVITATION_SIGN_IN_REQUIRED'], ['patient_login', 409, 'OUTREACH_INVITATION_PATIENT_LOGIN'],
    ['something_new', 503, 'OUTREACH_INVITATION_UNAVAILABLE'],
  ] as const)('answers the command result %s as today (%i %s), with no session', async (result, status, code) => {
    const { controller, issue } = make({ system: acceptingSystem(result) });
    const res = response();
    await expect(controller.accept(input, request(), res as unknown as Response)).rejects.toMatchObject({ status, code });
    expect(issue).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('maps a database refusal of the command as today', async () => {
    const system = jest.fn(async (sql: string) => {
      if (sql.includes('otp_rate_limits') || sql.includes('advisory')) return { rows: [] };
      throw Object.assign(new Error('OUTREACH_ORGANISER_SUSPENDED'), { code: 'P0001' });
    });
    await expect(make({ system }).controller.accept(input, request(), response() as never))
      .rejects.toMatchObject({ status: 423, code: 'OUTREACH_ORGANISER_SUSPENDED' });
  });

  it('answers 200 signedIn false (not 503) when the sign-in fails after the invitation was accepted', async () => {
    const failedIssue = make({ issue: jest.fn(async () => { throw new Error('session store unavailable'); }) });
    const res = response();
    const warn = jest.spyOn((failedIssue.controller as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    await expect(failedIssue.controller.accept(input, request(), res as unknown as Response)).resolves.toEqual({
      accepted: true, signedIn: false, facilityId: 'fac-1', membershipId: 'mem-9', roleCode: 'outreach_volunteer' });
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('event=outreach_invitation_link_sign_in_failed'));
    expect(failedIssue.revoke).not.toHaveBeenCalled();

    // The session was made but its audit failed: it is revoked and never handed over.
    const failedAudit = make({ audit: jest.fn(async () => { throw new Error('audit unavailable'); }) });
    jest.spyOn((failedAudit.controller as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const auditRes = response();
    await expect(failedAudit.controller.accept(input, request(), auditRes as unknown as Response))
      .resolves.toMatchObject({ accepted: true, signedIn: false });
    expect(failedAudit.revoke).toHaveBeenCalledWith('session-1', subject, expect.objectContaining({ correlationId }));
    expect(auditRes.cookie).not.toHaveBeenCalled();
  });
});

describe('AcceptOutreachInvitationByLinkDto', () => {
  it('needs the link, the outreach-invitation Turnstile action and the own or shared choice; takes no password', async () => {
    const valid = plainToInstance(AcceptOutreachInvitationByLinkDto, input);
    expect(await validate(valid)).toHaveLength(0);
    for (const bad of [{ ...input, device: 'tablet' }, { ...input, device: undefined }, { ...input, turnstileAction: 'outreach-login' },
      { ...input, token: 'short' }, { ...input, invitationId: 'not-a-uuid' }]) {
      expect((await validate(plainToInstance(AcceptOutreachInvitationByLinkDto, bad))).length).toBeGreaterThan(0);
    }
    const noToken = plainToInstance(AcceptOutreachInvitationByLinkDto, { ...input, turnstileToken: undefined });
    expect(await validate(noToken)).toHaveLength(0);
    expect(await validate(plainToInstance(AcceptOutreachInvitationByLinkDto, { ...input, password: 'a-long-fictional-password' }),
      { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
  });
});
