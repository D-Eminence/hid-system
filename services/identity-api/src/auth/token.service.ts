import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { PoolClient } from 'pg';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { ActorContext } from '../common/request-context';
import type { CredentialIdentity, HidJwtClaims, LoginResult } from './auth.types';
import { CurrentStaffContextService } from './current-staff-context.service';

interface SessionRow {
  id: string;
  account_id: string;
  actor_subject: string;
  family_id: string;
  access_jti: string;
  token_version: string;
  expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  authentication_method: 'password';
}

class RefreshRotationConflict extends Error {}

export interface SessionEventMetadata {
  correlationId: string;
  sourceIp?: string;
  userAgent?: string;
  principalHmac?: string;
  pepperVersion?: number;
}

@Injectable()
export class TokenService {
  private readonly environment = getEnvironment();
  private readonly signingKey = this.environment.AUTH_SIGNING_SECRET
    ? new TextEncoder().encode(this.environment.AUTH_SIGNING_SECRET)
    : undefined;
  private readonly oidcJwks = this.environment.OIDC_JWKS_URL
    ? createRemoteJWKSet(new URL(this.environment.OIDC_JWKS_URL))
    : undefined;

  constructor(
    private readonly database: DatabaseService,
    private readonly currentStaff: CurrentStaffContextService,
  ) {}

  async issue(identity: CredentialIdentity, event: SessionEventMetadata): Promise<LoginResult> {
    if (identity.authenticationMethod === 'oidc') {
      throw new Error('OIDC identities are not issued internal password sessions');
    }
    const authenticationMethod = identity.authenticationMethod;
    const actor = await this.currentStaff.resolve(identity.subject, identity.authenticationMethod);
    const sessionId = randomUUID();
    const accessJti = randomUUID();
    const refreshToken = this.newRefreshToken(sessionId, authenticationMethod);
    const csrfToken = this.deriveRefreshCsrf(refreshToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.environment.AUTH_ACCESS_TTL_SECONDS * 1_000);
    const refreshExpiresAt = new Date(now.getTime() + this.environment.AUTH_REFRESH_TTL_SECONDS * 1_000);
    const absoluteExpiresAt = new Date(now.getTime() + this.environment.AUTH_ABSOLUTE_TTL_SECONDS * 1_000);
    const tokenVersion = await this.accountTokenVersion(actor.accountId);
    const accessToken = await this.signAccessToken(actor, sessionId, accessJti, tokenVersion, csrfToken, expiresAt);

    await this.database.withSystemTransaction(event.correlationId, async (client) => {
      if (identity.passwordUpgrade) {
        const upgraded = await client.query<{ upgraded: boolean }>(
          `select auth.upgrade_legacy_password($1, $2, $3, $4) as upgraded`,
          [
            actor.accountId,
            actor.subject,
            identity.passwordUpgrade.expectedRowVersion,
            identity.passwordUpgrade.hash,
          ],
        );
        if (upgraded.rows[0]?.upgraded !== true) {
          throw new UnauthorizedException('Credentials changed during authentication; retry login');
        }
      }
      if (event.principalHmac && event.pepperVersion) {
        await client.query(
          `delete from auth.login_attempts where principal_hmac = $1 and pepper_version = $2`,
          [event.principalHmac, event.pepperVersion],
        );
      }
      await this.insertSession(client, {
        id: sessionId,
        accountId: actor.accountId,
        familyId: sessionId,
        refreshToken,
        accessJti,
        accountTokenVersion: tokenVersion,
        authenticationMethod,
        issuedAt: now,
        expiresAt: refreshExpiresAt,
        absoluteExpiresAt,
        event,
      });
      await this.insertSessionEvent(client, {
        eventType: 'login_succeeded', outcome: 'success', accountId: actor.accountId,
        sessionId, event, details: { password_upgraded: Boolean(identity.passwordUpgrade) },
      });
    });

    return { actor: { ...actor, sessionId }, accessToken, refreshToken, csrfToken, expiresAt, refreshExpiresAt };
  }

  async refresh(refreshToken: string, event: SessionEventMetadata): Promise<LoginResult> {
    const refreshHash = this.sha256(refreshToken);
    const existing = await this.database.query<SessionRow>(
      `select session.id::text, session.account_id::text,
              account.subject as actor_subject, session.family_id::text,
              session.access_jti::text, session.account_token_version::text as token_version,
              session.authentication_method,
              session.expires_at, session.absolute_expires_at, session.revoked_at
         from auth.sessions session
         join auth.accounts account on account.id = session.account_id
        where session.refresh_token_sha256 = $1
          and account.status = 'active'
          and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
          and account.token_version = session.account_token_version`,
      [refreshHash],
    );
    const oldSession = existing.rows[0];
    if (!oldSession) throw new UnauthorizedException('Invalid refresh session');

    if (oldSession.revoked_at) {
      await this.database.withSystemTransaction(event.correlationId, async (client) => {
        await client.query(
          `update auth.sessions
              set revoked_at = coalesce(revoked_at, clock_timestamp()),
                  revocation_reason = coalesce(revocation_reason, 'refresh_token_reuse'),
                  row_version = row_version + 1
            where family_id = $1 and revoked_at is null`,
          [oldSession.family_id],
        );
        await this.insertSessionEvent(client, {
          eventType: 'reuse_detected', outcome: 'denied', accountId: oldSession.account_id,
          sessionId: oldSession.id, event,
        });
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    const now = new Date();
    if (oldSession.expires_at <= now || oldSession.absolute_expires_at <= now) {
      await this.expireSession(oldSession, event);
      throw new UnauthorizedException('Refresh session expired');
    }

    const authenticationMethod = this.refreshMethod(refreshToken);
    if (this.databaseMethod(authenticationMethod) !== oldSession.authentication_method) {
      throw new UnauthorizedException('Invalid refresh session');
    }
    const actor = await this.currentStaff.resolve(oldSession.actor_subject, authenticationMethod);
    if (actor.accountId !== oldSession.account_id) {
      throw new UnauthorizedException('Invalid refresh session');
    }
    const accountTokenVersion = Number(oldSession.token_version);
    if (!Number.isSafeInteger(accountTokenVersion) || accountTokenVersion < 1) {
      throw new UnauthorizedException('Invalid refresh session');
    }
    const newSessionId = randomUUID();
    const accessJti = randomUUID();
    const newRefreshToken = this.newRefreshToken(newSessionId, authenticationMethod);
    const csrfToken = this.deriveRefreshCsrf(newRefreshToken);
    const accessExpiresAt = new Date(now.getTime() + this.environment.AUTH_ACCESS_TTL_SECONDS * 1_000);
    const refreshExpiresAt = new Date(Math.min(
      now.getTime() + this.environment.AUTH_REFRESH_TTL_SECONDS * 1_000,
      oldSession.absolute_expires_at.getTime(),
    ));
    const accessToken = await this.signAccessToken(
      actor, newSessionId, accessJti, accountTokenVersion, csrfToken, accessExpiresAt,
    );

    try {
      await this.database.withSystemTransaction(event.correlationId, async (client) => {
        await this.insertSession(client, {
          id: newSessionId,
          accountId: oldSession.account_id,
          familyId: oldSession.family_id,
          refreshToken: newRefreshToken,
          accessJti,
          accountTokenVersion,
          authenticationMethod,
          issuedAt: now,
          expiresAt: refreshExpiresAt,
          absoluteExpiresAt: oldSession.absolute_expires_at,
          event,
        });
        const rotated = await client.query(
          `update auth.sessions
              set revoked_at = clock_timestamp(), revocation_reason = 'rotated',
                  replaced_by_session_id = $2, row_version = row_version + 1
            where id = $1 and revoked_at is null`,
          [oldSession.id, newSessionId],
        );
        if (rotated.rowCount !== 1) throw new RefreshRotationConflict();
        await this.insertSessionEvent(client, {
          eventType: 'rotated', outcome: 'success', accountId: oldSession.account_id,
          sessionId: oldSession.id, event,
        });
      });
    } catch (error) {
      if (!(error instanceof RefreshRotationConflict)) throw error;
      await this.revokeReusedFamily(oldSession, event);
      throw new UnauthorizedException('Concurrent refresh token reuse detected');
    }

    return {
      actor: { ...actor, sessionId: newSessionId },
      accessToken,
      refreshToken: newRefreshToken,
      csrfToken,
      expiresAt: accessExpiresAt,
      refreshExpiresAt,
    };
  }

  async verify(token: string): Promise<{ actor: ActorContext; claims: HidJwtClaims | JWTPayload }> {
    if (this.environment.AUTH_MODE === 'oidc') return this.verifyOidc(token);
    if (!this.signingKey) throw new UnauthorizedException('Token verification is unavailable');
    const { payload } = await jwtVerify(token, this.signingKey, {
      issuer: this.environment.AUTH_ISSUER,
      audience: this.environment.AUTH_AUDIENCE,
      algorithms: ['HS256'],
    }).catch(() => { throw new UnauthorizedException('Invalid or expired access token'); });
    const claims = this.parseInternalClaims(payload);
    await this.assertSessionActive(claims);
    const actor = await this.currentStaff.resolve(claims.sub, claims.auth_method, claims.sid);
    return { actor, claims };
  }

  async revoke(
    sessionId: string | undefined,
    actorSubject: string | undefined,
    event: SessionEventMetadata,
  ): Promise<void> {
    if (!sessionId) return;
    await this.database.withSystemTransaction(event.correlationId, async (client) => {
      const result = await client.query<{ account_id: string }>(
        `update auth.sessions
            set revoked_at = coalesce(revoked_at, clock_timestamp()),
                revocation_reason = coalesce(revocation_reason, 'logout'),
                row_version = row_version + 1
          where id = $1
          returning account_id::text`,
        [sessionId],
      );
      const accountId = result.rows[0]?.account_id;
      if (accountId) {
        await this.insertSessionEvent(client, {
          eventType: 'logout', outcome: 'success', accountId, sessionId, event,
          details: actorSubject ? { actor_subject: actorSubject } : {},
        });
      }
    });
  }

  verifyCsrf(claims: HidJwtClaims | JWTPayload, cookieToken: string | undefined, headerToken: string | undefined): boolean {
    if (!('csrf_hash' in claims) || typeof claims.csrf_hash !== 'string' || !cookieToken || !headerToken) return false;
    const cookieHash = this.sha256Base64(cookieToken);
    const headerHash = this.sha256Base64(headerToken);
    return this.safeEqual(cookieHash, headerHash) && this.safeEqual(cookieHash, claims.csrf_hash);
  }

  verifyRefreshCsrf(refreshToken: string, cookieToken: string | undefined, headerToken: string | undefined): boolean {
    if (!cookieToken || !headerToken) return false;
    const expected = this.deriveRefreshCsrf(refreshToken);
    return this.safeEqual(cookieToken, headerToken) && this.safeEqual(cookieToken, expected);
  }

  private async verifyOidc(token: string): Promise<{ actor: ActorContext; claims: JWTPayload }> {
    if (!this.oidcJwks || !this.environment.OIDC_ISSUER_URL || !this.environment.OIDC_AUDIENCE) {
      throw new UnauthorizedException('OIDC verification is unavailable');
    }
    const { payload } = await jwtVerify(token, this.oidcJwks, {
      issuer: this.environment.OIDC_ISSUER_URL,
      audience: this.environment.OIDC_AUDIENCE,
      algorithms: ['RS256', 'ES256'],
    }).catch(() => { throw new UnauthorizedException('Invalid or expired access token'); });
    if (!payload.sub) throw new UnauthorizedException('Token subject is missing');
    return { claims: payload, actor: await this.currentStaff.resolve(payload.sub, 'oidc') };
  }

  private async signAccessToken(
    actor: ActorContext,
    sessionId: string,
    accessJti: string,
    tokenVersion: number,
    csrfToken: string,
    expiresAt: Date,
  ): Promise<string> {
    if (!this.signingKey) throw new Error('Internal token signing is not configured');
    return new SignJWT({
      sid: sessionId,
      email: actor.email,
      name: actor.displayName,
      roles: actor.roles,
      permissions: actor.permissions,
      platform_roles: actor.platformRoles ?? [],
      platform_permissions: actor.platformPermissions ?? [],
      facility_ids: actor.facilityIds,
      auth_method: actor.authenticationMethod,
      csrf_hash: this.sha256Base64(csrfToken),
      token_version: tokenVersion,
    } satisfies Omit<HidJwtClaims, keyof JWTPayload>)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(actor.subject)
      .setIssuer(this.environment.AUTH_ISSUER)
      .setAudience(this.environment.AUTH_AUDIENCE)
      .setJti(accessJti)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
      .sign(this.signingKey);
  }

  private parseInternalClaims(payload: JWTPayload): HidJwtClaims {
    if (!payload.sub || typeof payload.sid !== 'string' || typeof payload.jti !== 'string'
      || typeof payload.auth_method !== 'string' || typeof payload.token_version !== 'number') {
      throw new UnauthorizedException('Access token claims are incomplete');
    }
    const method = payload.auth_method;
    if (method !== 'local') throw new UnauthorizedException('Invalid authentication method');
    return {
      ...payload,
      sub: payload.sub,
      sid: payload.sid,
      roles: this.stringArrayClaim(payload.roles),
      permissions: this.stringArrayClaim(payload.permissions),
      platform_roles: this.stringArrayClaim(payload.platform_roles),
      platform_permissions: this.stringArrayClaim(payload.platform_permissions),
      facility_ids: this.stringArrayClaim(payload.facility_ids),
      auth_method: method,
      csrf_hash: typeof payload.csrf_hash === 'string' ? payload.csrf_hash : undefined,
      token_version: payload.token_version,
    };
  }

  private async assertSessionActive(claims: HidJwtClaims): Promise<void> {
    const result = await this.database.query(
      `select 1
         from auth.sessions session
         join auth.accounts account on account.id = session.account_id
        where session.id = $1
          and account.subject = $2
          and session.access_jti = $3
          and session.account_token_version = $4
          and session.authentication_method = $5
          and account.token_version = session.account_token_version
          and account.status = 'active'
          and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
          and session.revoked_at is null
          and session.expires_at > clock_timestamp()`,
      [claims.sid, claims.sub, claims.jti, claims.token_version, this.databaseMethod(claims.auth_method)],
    );
    if (result.rowCount !== 1) throw new UnauthorizedException('Session is no longer active');
  }

  private async accountTokenVersion(accountId: string): Promise<number> {
    const result = await this.database.query<{ token_version: string }>(
      `select token_version::text from auth.accounts
        where id = $1 and status = 'active'
          and (disabled_until is null or disabled_until <= clock_timestamp())`,
      [accountId],
    );
    const version = Number(result.rows[0]?.token_version);
    if (!Number.isSafeInteger(version) || version < 1) throw new UnauthorizedException('Account is inactive');
    return version;
  }

  private async insertSession(
    client: PoolClient,
    input: {
      id: string; accountId: string; familyId: string; refreshToken: string; accessJti: string;
      accountTokenVersion: number; authenticationMethod: 'local';
      issuedAt: Date; expiresAt: Date; absoluteExpiresAt: Date; event: SessionEventMetadata;
    },
  ): Promise<void> {
    await client.query(
      `insert into auth.sessions (
         id, account_id, family_id, refresh_token_sha256, access_jti,
         account_token_version, authentication_method,
         issued_at, expires_at, absolute_expires_at, source_ip, user_agent_sha256
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        input.id, input.accountId, input.familyId, this.sha256(input.refreshToken), input.accessJti,
        input.accountTokenVersion, this.databaseMethod(input.authenticationMethod),
        input.issuedAt, input.expiresAt, input.absoluteExpiresAt, input.event.sourceIp ?? null,
        input.event.userAgent ? this.sha256(input.event.userAgent) : null,
      ],
    );
  }

  private async insertSessionEvent(
    client: PoolClient,
    input: {
      eventType: 'login_succeeded' | 'login_failed' | 'refresh' | 'rotated' | 'revoked' | 'logout' | 'expired' | 'reuse_detected';
      outcome: 'success' | 'denied' | 'failure'; accountId: string; sessionId?: string;
      event: SessionEventMetadata; details?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await client.query(
      `insert into auth.session_events (
         session_id, account_id, event_type, outcome, correlation_id,
         source_ip, user_agent_sha256, details
       ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        input.sessionId ?? null, input.accountId, input.eventType, input.outcome,
        input.event.correlationId, input.event.sourceIp ?? null,
        input.event.userAgent ? this.sha256(input.event.userAgent) : null,
        JSON.stringify(input.details ?? {}),
      ],
    );
  }

  private async expireSession(session: SessionRow, event: SessionEventMetadata): Promise<void> {
    await this.database.withSystemTransaction(event.correlationId, async (client) => {
      await client.query(
        `update auth.sessions
            set revoked_at = coalesce(revoked_at, clock_timestamp()),
                revocation_reason = coalesce(revocation_reason, 'expired'),
                row_version = row_version + 1
          where id = $1`,
        [session.id],
      );
      await this.insertSessionEvent(client, {
        eventType: 'expired', outcome: 'denied', accountId: session.account_id,
        sessionId: session.id, event,
      });
    });
  }

  private async revokeReusedFamily(session: SessionRow, event: SessionEventMetadata): Promise<void> {
    await this.database.withSystemTransaction(event.correlationId, async (client) => {
      await client.query(
        `update auth.sessions
            set revoked_at = coalesce(revoked_at, clock_timestamp()),
                revocation_reason = coalesce(revocation_reason, 'refresh_token_reuse'),
                row_version = row_version + 1
          where family_id = $1 and revoked_at is null`,
        [session.family_id],
      );
      await this.insertSessionEvent(client, {
        eventType: 'reuse_detected', outcome: 'denied', accountId: session.account_id,
        sessionId: session.id, event,
      });
    });
  }

  private newRefreshToken(sessionId: string, method: 'local'): string {
    return `${sessionId}.${randomBytes(48).toString('base64url')}.${method}`;
  }

  private refreshMethod(token: string): 'local' {
    const method = token.split('.').at(-1);
    if (method !== 'local') throw new UnauthorizedException('Invalid refresh session');
    return method;
  }

  private databaseMethod(_method: 'local'): 'password' {
    return 'password';
  }

  private deriveRefreshCsrf(refreshToken: string): string {
    if (!this.environment.AUTH_SIGNING_SECRET) throw new Error('CSRF derivation is not configured');
    return createHmac('sha256', this.environment.AUTH_SIGNING_SECRET)
      .update(`csrf:${refreshToken}`, 'utf8')
      .digest('base64url');
  }

  private stringArrayClaim(value: unknown): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return [];
    return [...new Set(value as string[])];
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private sha256Base64(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('base64url');
  }

  private safeEqual(first: string, second: string): boolean {
    const firstBuffer = Buffer.from(first);
    const secondBuffer = Buffer.from(second);
    return firstBuffer.length === secondBuffer.length && timingSafeEqual(firstBuffer, secondBuffer);
  }
}
