const signed: Array<Record<string, unknown>> = [];
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  SignJWT: class {
    private readonly claims: Record<string, unknown>;
    constructor(claims: Record<string, unknown>) { this.claims = { ...claims }; }
    setProtectedHeader() { return this; }
    setSubject(subject: string) { this.claims.sub = subject; return this; }
    setIssuer() { return this; }
    setAudience() { return this; }
    setJti(jti: string) { this.claims.jti = jti; return this; }
    setIssuedAt() { return this; }
    setExpirationTime(seconds: number) { this.claims.exp = seconds; return this; }
    async sign() { signed.push(this.claims); return 'renewed-access-token'; }
  },
}));

import { createHash, createHmac } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { ActorContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { NoActiveFacilityMembershipProblem } from './product-gate';
import { type SessionRenewal, TokenService } from './token.service';

// SX-6 (0205): TokenService.renewSignIn, the presented staff sign-in renewed in its own family after the password
// change raised the account's token version. The database call is the caller's (commit); this checks what it is
// given and what comes back.

const SECRET = 'test-signing-secret-with-at-least-32-characters';
const actor: ActorContext = {
  id: 'staff:fictional-ada', subject: 'staff:fictional-ada', accountId: '40000000-0000-4000-8000-000000000001',
  email: 'ada@example.test', displayName: 'Ada Fictional', authenticationMethod: 'local', roles: ['doctor'],
  permissions: ['ehr.encounter.read'], facilityIds: [], facilities: [],
};

describe('TokenService.renewSignIn (SX-6)', () => {
  const original = { ...process.env };
  beforeEach(() => {
    signed.length = 0;
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
      CORS_ORIGINS: 'https://ehr.staging.healthidentitydirectory.com', AUTH_MODE: 'local', AUTH_SIGNING_SECRET: SECRET,
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', AUTH_REFRESH_TTL_SECONDS: '28800',
      AUTH_OUTREACH_REFRESH_TTL_SECONDS: '86400', AUTH_ACCESS_TTL_SECONDS: '900' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function service(resolve = jest.fn().mockResolvedValue(actor)) {
    const database = { query: jest.fn(), withSystemTransaction: jest.fn() };
    return { resolve, database,
      tokens: new TokenService(database as unknown as DatabaseService, { resolve } as unknown as CurrentStaffContextService) };
  }

  it('resolves the actor under the session\'s product, hands the database only the refresh token\'s digest, signs at the new version', async () => {
    const s = service();
    let given: SessionRenewal | undefined;
    const before = Date.now();
    const result = await s.tokens.renewSignIn({ subject: actor.subject, authenticationMethod: 'local', product: 'lab',
      origin: 'https://lab.staging.healthidentitydirectory.com' }, async (renewal) => {
      given = renewal;
      return { tokenVersion: 7, refreshExpiresAt: new Date('2026-11-26T20:00:00Z') };
    });
    expect(s.resolve).toHaveBeenCalledWith(actor.subject, 'local', undefined, undefined, { product: 'lab' });
    expect(given).toBeDefined();
    // The refresh token is <session id>.<secret>.<product>.<method>, and only its SHA-256 reaches the database.
    const parts = result.refreshToken.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe(given!.sessionId);
    expect(parts.slice(2)).toEqual(['lab', 'local']);
    expect(given!.refreshTokenSha256).toBe(createHash('sha256').update(result.refreshToken, 'utf8').digest('hex'));
    expect(JSON.stringify(given)).not.toContain(parts[1]);
    // The idle end asked for is the staff refresh lifetime from now (8 hours); the one kept is the database's.
    expect(given!.refreshExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 28_800_000);
    expect(given!.refreshExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 28_800_000);
    expect(result.refreshExpiresAt).toEqual(new Date('2026-11-26T20:00:00Z'));
    // The CSRF token is the refresh token's, as refresh() derives it.
    expect(result.csrfToken).toBe(createHmac('sha256', SECRET).update(`csrf:${result.refreshToken}`, 'utf8').digest('base64url'));
    expect(signed).toEqual([expect.objectContaining({ sub: actor.subject, sid: given!.sessionId, jti: given!.accessJti,
      token_version: 7, product: 'lab', auth_method: 'local', actor_kind: 'staff' })]);
    expect(result).toMatchObject({ accessToken: 'renewed-access-token', actor: { sessionId: given!.sessionId } });
    expect(s.database.query).not.toHaveBeenCalled();
    expect(s.database.withSystemTransaction).not.toHaveBeenCalled();
  });

  it('a session issued on no product site keeps none; an outreach Origin gets the outreach idle lifetime', async () => {
    const s = service();
    let given: SessionRenewal | undefined;
    const result = await s.tokens.renewSignIn({ subject: actor.subject, authenticationMethod: 'local',
      origin: 'https://outreach.staging.healthidentitydirectory.com' }, async (renewal) => {
      given = renewal;
      return { tokenVersion: 2, refreshExpiresAt: renewal.refreshExpiresAt };
    });
    expect(s.resolve).toHaveBeenCalledWith(actor.subject, 'local', undefined);
    expect(result.refreshToken.split('.')).toHaveLength(3);
    expect(signed[0]).not.toHaveProperty('product');
    expect(given!.refreshExpiresAt.getTime() - Date.now()).toBeGreaterThan(86_000_000);
  });

  it('signs the renewed access token for AUTH_ACCESS_TTL_SECONDS (900 s) from now, as its cookie\'s end', async () => {
    const s = service();
    const before = Date.now();
    const result = await s.tokens.renewSignIn({ subject: actor.subject, authenticationMethod: 'local' },
      async (renewal) => ({ tokenVersion: 3, refreshExpiresAt: renewal.refreshExpiresAt }));
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 900_000);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 900_000);
    expect(signed[0]!.exp).toBe(Math.floor(result.expiresAt.getTime() / 1_000));
  });

  it('keeps a single sign-on method: the refresh token\'s last part and the signed auth_method are oidc', async () => {
    // CurrentStaffContextService.resolve carries the method it is given into the actor.
    const s = service(jest.fn(async (_subject: string, method: 'local' | 'oidc') => ({ ...actor,
      authenticationMethod: method })));
    const result = await s.tokens.renewSignIn({ subject: actor.subject, authenticationMethod: 'oidc', product: 'ehr',
      origin: 'https://ehr.staging.healthidentitydirectory.com' },
    async (renewal) => ({ tokenVersion: 4, refreshExpiresAt: renewal.refreshExpiresAt }));
    expect(s.resolve).toHaveBeenCalledWith(actor.subject, 'oidc', undefined, undefined, { product: 'ehr' });
    expect(result.refreshToken.split('.').slice(2)).toEqual(['ehr', 'oidc']);
    expect(signed).toEqual([expect.objectContaining({ auth_method: 'oidc', product: 'ehr', token_version: 4 })]);
  });

  it.each([
    ['an outreach Origin', 'https://outreach.staging.healthidentitydirectory.com'],
    ['another product\'s Origin', 'https://lab.staging.healthidentitydirectory.com'],
    ['no Origin', undefined],
  ])('an ehr session presented with %s ends as refresh() ends it (401), before anything is stored', async (_label, origin) => {
    const s = service();
    const commit = jest.fn();
    await expect(s.tokens.renewSignIn({ subject: actor.subject, authenticationMethod: 'local', product: 'ehr', origin },
      commit)).rejects.toThrow(new UnauthorizedException('Refresh session belongs to another site'));
    expect(commit).not.toHaveBeenCalled();
    expect(s.resolve).not.toHaveBeenCalled();
    expect(signed).toEqual([]);
  });

  it('an outreach session from its own site keeps the outreach idle lifetime (24 hours)', async () => {
    const s = service();
    let given: SessionRenewal | undefined;
    await s.tokens.renewSignIn({ subject: actor.subject, authenticationMethod: 'local', product: 'outreach',
      origin: 'https://outreach.staging.healthidentitydirectory.com' }, async (renewal) => {
      given = renewal;
      return { tokenVersion: 2, refreshExpiresAt: renewal.refreshExpiresAt };
    });
    expect(given!.refreshExpiresAt.getTime() - Date.now()).toBeGreaterThan(86_000_000);
    expect(signed[0]).toMatchObject({ product: 'outreach' });
  });

  it('a session that no longer fits its site ends before anything is stored (401, commit never called)', async () => {
    const s = service(jest.fn().mockRejectedValue(new NoActiveFacilityMembershipProblem()));
    const commit = jest.fn();
    await expect(s.tokens.renewSignIn({ subject: actor.subject, authenticationMethod: 'local', product: 'ehr',
      origin: 'https://ehr.staging.healthidentitydirectory.com' }, commit)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(commit).not.toHaveBeenCalled();
  });

  it('a failed commit signs nothing', async () => {
    const s = service();
    await expect(s.tokens.renewSignIn({ subject: actor.subject, authenticationMethod: 'local' },
      async () => { throw new Error('refused'); })).rejects.toThrow('refused');
    expect(signed).toEqual([]);
  });

  it('refuses a commit that answers no usable token version', async () => {
    const s = service();
    await expect(s.tokens.renewSignIn({ subject: actor.subject, authenticationMethod: 'local' },
      async () => ({ tokenVersion: Number.NaN, refreshExpiresAt: new Date() }))).rejects.toThrow('no token version');
    expect(signed).toEqual([]);
  });
});
