import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { PoolClient } from 'pg';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { ActorContext } from '../common/request-context';
import type { CredentialIdentity, HidJwtClaims, LoginResult } from './auth.types';
import { CurrentStaffContextService } from './current-staff-context.service';
import { CurrentPatientContextService } from './current-patient-context.service';
import { isProductGateRefusal, isStaffProduct, productForOrigin, type StaffProduct } from './product-gate';
import { clearOpenPatientElsewhere, openPatientEnabled } from './open-patient';

interface SessionRow {
  session_kind?: 'staff' | 'patient';
  patient_id?: string | null;
  id: string;
  account_id: string;
  actor_subject: string;
  family_id: string;
  access_jti: string;
  token_version: string;
  expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  revocation_reason?: string | null;
  authentication_method: 'password' | 'oidc';
}

class RefreshRotationConflict extends Error {}

/**
 * A sign-in single sign-on asked for whose account changed its credentials
 * after the caller checked them (TokenService.issue with
 * `singleSignOn.accountTokenVersion`): a password reset or recovery raises
 * the account's token version in the same statement that sets
 * password_changed_at (0029, 0096), so a different version means the check
 * the caller made no longer holds.
 */
export class CredentialsChangedDuringSignIn extends UnauthorizedException {
  constructor() {
    super('Credentials changed during authentication; retry login');
  }
}

export interface SessionEventMetadata {
  correlationId: string;
  sourceIp?: string;
  userAgent?: string;
  principalHmac?: string;
  pepperVersion?: number;
  /** The browser's Origin, when it sent one: an outreach. origin gets the short idle lock. */
  origin?: string;
  /**
   * The staff product of the site the request came from (product-gate.ts),
   * when it is a product site: a staff session keeps only the memberships
   * that fit it (Q88-1). Read from `origin` when not given.
   */
  product?: StaffProduct;
}

/**
 * Where a staff or patient sign-in came from when a product issued it after
 * single sign-on on `auth.` (ADR-070, 0127): the product's client, the
 * provider's session id (`sid`, which back-channel logout names) and when the
 * person signed in at the provider (`auth_time`). The ID token itself is not
 * kept. Stored on the new family in the session's own transaction. The
 * sign-in's absolute end then counts from `authenticatedAt`, not from the
 * hand-off, and a patient's recent-sign-in check reads it too
 * (recent-authentication.ts).
 */
export interface SingleSignOnProvenance {
  clientId: string;
  providerSid: string;
  authenticatedAt: Date;
  /**
   * The account's token version read in the same statement as the
   * password_changed_at the caller compared with `authenticatedAt`. When
   * set, issue() refuses (CredentialsChangedDuringSignIn) unless the session
   * would carry this very version, so a password change that commits between
   * that check and the issue is never missed. Not stored.
   */
  accountTokenVersion?: number;
}

/** A session event a caller records in its own transaction (single sign-on's revocations). */
export interface SessionEventInput {
  eventType: 'login_succeeded' | 'login_failed' | 'refresh' | 'rotated' | 'revoked' | 'logout' | 'expired' | 'reuse_detected';
  outcome: 'success' | 'denied' | 'failure';
  accountId: string;
  sessionId?: string;
  event: SessionEventMetadata;
  details?: Readonly<Record<string, unknown>>;
}

/** A staff sign-in's choice of working facility (0129), and the membership it was made under. */
export interface FacilitySelectionInput {
  sessionId: string;
  accountId: string;
  facilityId: string;
  membershipId: string;
}

/**
 * How recordFacilitySelection ended: stored, with the caller's audit row; the
 * presented session is no longer a live staff session of the account (a
 * sign-out, rotation or revocation got there first); or 0129's guard refused
 * the row (23514 SESSION_FACILITY_SELECTION_INVALID), because the membership,
 * facility, account or sign-in ended after the request was authorized. Only
 * 'selected' wrote anything.
 */
export type FacilitySelectionOutcome = 'selected' | 'session_ended' | 'refused';

/** 0129's guard refusal of a row it does not admit (raised with SQLSTATE 23514). */
const FACILITY_SELECTION_INVALID = 'SESSION_FACILITY_SELECTION_INVALID';

/** The product a staff sign-in or refresh is gated by: the event's, else its Origin's. */
function eventProduct(event: SessionEventMetadata): StaffProduct | undefined {
  return event.product ?? productForOrigin(event.origin);
}

/** Whether an Origin is an outreach. site (production, staging or a sub-environment). */
export function isOutreachOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.hostname.startsWith('outreach.')
      && url.hostname.endsWith('healthidentitydirectory.com');
  } catch {
    return false;
  }
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
    private readonly currentPatient?: CurrentPatientContextService,
  ) {}

  /**
   * A new staff or patient sign-in. `singleSignOn` is set only by a product's
   * single sign-on callback (ADR-070): the sign-in is then issued exactly as
   * a password sign-in on that product's site (the same product gate and
   * product-bound refresh token, from `event`), its lifetimes never run past
   * the absolute lifetime counted from the provider's auth_time, and its
   * provenance is stored on the new family in the same transaction.
   */
  async issue(identity: CredentialIdentity, event: SessionEventMetadata,
    singleSignOn?: SingleSignOnProvenance): Promise<LoginResult> {
    const authenticationMethod = identity.authenticationMethod;
    const product = eventProduct(event);
    const resolvedActor = await this.resolveActor(
      identity.subject,
      identity.authenticationMethod,
      identity.actorKind ?? 'staff',
      undefined,
      product,
    );
    if (identity.accountId && identity.accountId !== resolvedActor.accountId) {
      throw new UnauthorizedException('Resolved account does not match the authenticated identity');
    }
    // A federated provider is verified and mapped before it reaches this
    // shared session lifecycle. Keep the authentication provenance in the HID
    // cookie session rather than minting a parallel token system.
    const actor = { ...resolvedActor, authenticationMethod };
    const sessionId = randomUUID();
    const accessJti = randomUUID();
    const sessionProduct = actor.kind === 'patient' ? undefined : product;
    const refreshToken = this.newRefreshToken(sessionId, authenticationMethod, sessionProduct);
    const csrfToken = this.deriveRefreshCsrf(refreshToken);
    const now = new Date();
    const lifetimes = this.lifetimes(actor.kind ?? 'staff', event.origin);
    const end = this.singleSignOnEnd(now, lifetimes.absoluteSeconds, singleSignOn);
    const expiresAt = end(new Date(now.getTime() + this.environment.AUTH_ACCESS_TTL_SECONDS * 1_000));
    const absoluteExpiresAt = end(new Date(now.getTime() + lifetimes.absoluteSeconds * 1_000));
    // Never past the family's absolute expiry (auth.sessions CHECK, 0002).
    const refreshExpiresAt = new Date(Math.min(now.getTime() + lifetimes.refreshSeconds * 1_000,
      absoluteExpiresAt.getTime()));
    const tokenVersion = await this.accountTokenVersion(actor.accountId);
    if (singleSignOn?.accountTokenVersion !== undefined && tokenVersion !== singleSignOn.accountTokenVersion) {
      throw new CredentialsChangedDuringSignIn();
    }
    const accessToken = await this.signAccessToken(actor, sessionId, accessJti, tokenVersion, csrfToken, expiresAt,
      sessionProduct);

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
        actorKind: actor.kind ?? 'staff',
        patientId: actor.patientId,
        issuedAt: now,
        expiresAt: refreshExpiresAt,
        absoluteExpiresAt,
        event,
      });
      await this.insertSessionEvent(client, {
        eventType: 'login_succeeded', outcome: 'success', accountId: actor.accountId,
        sessionId, event, details: { password_upgraded: Boolean(identity.passwordUpgrade),
          ...(singleSignOn ? { sso_client: singleSignOn.clientId } : {}) },
      });
      if (singleSignOn) await this.recordSingleSignOn(client, sessionId, actor.accountId, singleSignOn);
    });

    return { actor: { ...actor, sessionId }, accessToken, refreshToken, csrfToken, expiresAt, refreshExpiresAt };
  }

  async refresh(refreshToken: string, event: SessionEventMetadata): Promise<LoginResult> {
    const refreshHash = this.sha256(refreshToken);
    const existing = await this.database.query<SessionRow>(
      `select session.id::text, session.account_id::text,
              account.subject as actor_subject, session.family_id::text,
              session.access_jti::text, session.account_token_version::text as token_version,
              session.authentication_method, session.session_kind, session.patient_id::text,
              session.expires_at, session.absolute_expires_at, session.revoked_at, session.revocation_reason
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

    // A sign-in ended by single sign-on sign-out (a product's sign-out
    // signing out everywhere, or the provider's back-channel logout) leaves
    // its cookies on the other tabs and devices it ended: their next refresh
    // is an ordinary ended sign-in, refused and recorded as a denied refresh,
    // never as a stolen refresh token. Every other ended session is answered
    // as before.
    if (oldSession.revoked_at && oldSession.revocation_reason === 'sso_logout') {
      await this.database.withSystemTransaction(event.correlationId, async (client) => {
        await this.insertSessionEvent(client, {
          eventType: 'refresh', outcome: 'denied', accountId: oldSession.account_id, sessionId: oldSession.id, event,
          details: { reason: 'session_ended', revocation_reason: 'sso_logout',
            session_kind: oldSession.session_kind ?? 'staff' },
        });
      });
      throw new UnauthorizedException('Refresh session ended');
    }

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
    // Q88-1: the refresh re-applies the product gate. The product is the one
    // the session was issued under, kept in the server-made refresh token
    // (its hash is what auth.sessions holds, so it cannot be changed). The
    // request's Origin is the client's to set, so it may only confirm that
    // product, never replace it: a session issued on lab. refreshed with any
    // other Origin, or with none that names a product, ends. A refresh token
    // issued before the gate (no product in it) takes its site's product.
    const staffSession = (oldSession.session_kind ?? 'staff') === 'staff';
    const issuedProduct = this.refreshProduct(refreshToken);
    const requestProduct = staffSession ? eventProduct(event) : undefined;
    if (staffSession && issuedProduct && requestProduct !== issuedProduct) {
      throw new UnauthorizedException('Refresh session belongs to another site');
    }
    const product = staffSession ? issuedProduct ?? requestProduct : undefined;
    // A session that no longer fits its site ends as one whose membership
    // ended always has: 401, the answer every website already signs out on
    // (verify() does the same for each request).
    const actor = await this.resolveActor(oldSession.actor_subject, authenticationMethod,
      oldSession.session_kind ?? 'staff', undefined, product).catch((error: unknown) => {
      if (isProductGateRefusal(error)) throw new UnauthorizedException('Session no longer fits this site');
      throw error;
    });
    if (actor.accountId !== oldSession.account_id) {
      throw new UnauthorizedException('Invalid refresh session');
    }
    if (actor.kind === 'patient' && actor.patientId !== oldSession.patient_id) {
      throw new UnauthorizedException('Patient account association changed');
    }
    const accountTokenVersion = Number(oldSession.token_version);
    if (!Number.isSafeInteger(accountTokenVersion) || accountTokenVersion < 1) {
      throw new UnauthorizedException('Invalid refresh session');
    }
    const newSessionId = randomUUID();
    const accessJti = randomUUID();
    const newRefreshToken = this.newRefreshToken(newSessionId, authenticationMethod, product);
    const csrfToken = this.deriveRefreshCsrf(newRefreshToken);
    const accessExpiresAt = new Date(now.getTime() + this.environment.AUTH_ACCESS_TTL_SECONDS * 1_000);
    const refreshExpiresAt = new Date(Math.min(
      now.getTime() + this.lifetimes(actor.kind ?? 'staff', event.origin).refreshSeconds * 1_000,
      oldSession.absolute_expires_at.getTime(),
    ));
    const accessToken = await this.signAccessToken(
      actor, newSessionId, accessJti, accountTokenVersion, csrfToken, accessExpiresAt, product,
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
          actorKind: actor.kind ?? 'staff',
          patientId: actor.patientId,
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
    // Q88-1: every request keeps the product gate the session was issued
    // under. A session that no longer fits it (a membership ended meanwhile)
    // ends as one whose membership ended always has: 401.
    const actor = await this.resolveActor(claims.sub, claims.auth_method, claims.actor_kind ?? 'staff', claims.sid,
      claims.actor_kind === 'patient' ? undefined : claims.product).catch((error: unknown) => {
      if (isProductGateRefusal(error)) throw new UnauthorizedException('Session no longer fits this site');
      throw error;
    });
    if (actor.kind === 'patient' && actor.patientId !== claims.patient_id) {
      throw new UnauthorizedException('Patient account association changed');
    }
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

  /**
   * Stores a staff sign-in's choice of working facility (0129), keyed by its
   * session family, so a refresh (which keeps the family) keeps it and another
   * sign-in of the account does not see it. A new choice replaces the old.
   *
   * The presented session is locked FOR SHARE while it is a live staff session
   * of the account. Sign-out, rotation and reuse revocation update that row, so
   * each either waits for this transaction or has ended the session first, and
   * then nothing is written ('session_ended'). (Staging has no account lock,
   * main 0073, and this runtime only reads auth.accounts.) 0129's guard admits
   * the row only for a live staff sign-in of an active account and an active,
   * unheld membership of it at that facility. `withinTransaction` runs on the
   * same transaction once the row is written (the caller's audit row), so a
   * choice is stored only with it. Every other failure is rethrown, and the
   * transaction is rolled back.
   */
  async recordFacilitySelection(input: FacilitySelectionInput, event: SessionEventMetadata,
    withinTransaction: (client: PoolClient) => Promise<void>): Promise<FacilitySelectionOutcome> {
    try {
      return await this.database.withSystemTransaction(event.correlationId, async (client) => {
        const presented = await client.query<{ family_id: string }>(
          `select session.family_id::text
             from auth.sessions session
            where session.id = $1
              and session.account_id = $2
              and session.session_kind = 'staff'
              and session.revoked_at is null
              and session.expires_at > clock_timestamp()
              and session.absolute_expires_at > clock_timestamp()
              for share`,
          [input.sessionId, input.accountId],
        );
        const familyId = presented.rows[0]?.family_id;
        if (presented.rowCount !== 1 || !familyId) return 'session_ended' as const;
        const stored = await client.query<{ family_id: string }>(
          `insert into auth.session_facility_selection (family_id, account_id, facility_id, membership_id)
           values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
           on conflict (family_id) do update
              set facility_id = excluded.facility_id, membership_id = excluded.membership_id,
                  selected_at = clock_timestamp(), row_version = auth.session_facility_selection.row_version + 1
           returning family_id::text`,
          [familyId, input.accountId, input.facilityId, input.membershipId],
        );
        if (stored.rowCount !== 1) throw new Error('Facility selection was not stored');
        // SX-8 (0140): a move to another facility ends the open patient kept
        // at any other one, in this transaction (under a savepoint: a missing
        // 0140 table never rolls back the move).
        if (openPatientEnabled()) {
          await clearOpenPatientElsewhere(client, input.sessionId, input.accountId, input.facilityId);
        }
        await withinTransaction(client);
        return 'selected' as const;
      });
    } catch (error) {
      if (isDatabaseError(error) && error.code === '23514' && error.message === FACILITY_SELECTION_INVALID) {
        return 'refused';
      }
      throw error;
    }
  }

  /**
   * SX-8 (0140), for POST /auth/facility while 0129 stores no choice (its
   * setting off): clears the sign-in's open patient kept at any facility but
   * `facilityId`, through the presented session of the account, and runs
   * `withinTransaction` (the caller's audit row) on the same transaction. A
   * session that has ended clears nothing here (its row is no longer read),
   * and the audit row is still written. A missing 0140 table or grant clears
   * nothing and keeps the move (clearOpenPatientElsewhere's savepoint); every
   * other failure is rethrown, and the transaction is rolled back.
   */
  async clearOpenPatientElsewhere(input: { sessionId: string; accountId: string; facilityId: string },
    event: SessionEventMetadata, withinTransaction: (client: PoolClient) => Promise<void>): Promise<void> {
    await this.database.withSystemTransaction(event.correlationId, async (client) => {
      await clearOpenPatientElsewhere(client, input.sessionId, input.accountId, input.facilityId);
      await withinTransaction(client);
    });
  }

  /**
   * The facility a staff sign-in chose (0129), read through the presented
   * session only while it is a live staff session of the account, so a
   * signed-out or revoked sign-in never reads its choice again. The facility
   * id only: the caller matches it against the actor's current facilities by
   * id, as SecurityGuard matches X-Facility-ID. It authorizes nothing. A plain
   * read on the pool, taking no row lock; a failure is rethrown for the caller
   * to report.
   */
  async selectedFacilityId(sessionId: string, accountId: string): Promise<string | undefined> {
    const result = await this.database.query<{ facility_id: string }>(
      `select selection.facility_id::text
         from auth.sessions session
         join auth.session_facility_selection selection
           on selection.family_id = session.family_id and selection.account_id = session.account_id
        where session.id = $1
          and session.account_id = $2
          and session.session_kind = 'staff'
          and session.revoked_at is null
          and session.expires_at > clock_timestamp()
          and session.absolute_expires_at > clock_timestamp()`,
      [sessionId, accountId],
    );
    return result.rows[0]?.facility_id;
  }

  /**
   * Today's sign-out (revoke) of the sign-in a refresh token belongs to, for
   * product sign-out when the access token is gone (POST /auth/sso/logout):
   * only a `kind` sign-in refresh() could still renew now (not ended or
   * expired, its account active at the same token version) is ended, with
   * reason `logout` and a `logout` session event, in one transaction.
   * Answers the ended session, its account and subject, or nothing when no
   * such sign-in is found (nothing changes then). The caller has already
   * checked the request's Origin and the refresh CSRF token.
   */
  async revokeByRefreshToken(refreshToken: string, kind: 'staff' | 'patient', event: SessionEventMetadata):
    Promise<{ sessionId: string; accountId: string; subject: string } | undefined> {
    return this.database.withSystemTransaction(event.correlationId, async (client) => {
      const result = await client.query<{ id: string; account_id: string; subject: string }>(
        `update auth.sessions session
            set revoked_at = clock_timestamp(), revocation_reason = 'logout', row_version = session.row_version + 1
           from auth.accounts account
          where account.id = session.account_id
            and session.refresh_token_sha256 = $1
            and session.session_kind = $2
            and session.revoked_at is null
            and session.expires_at > clock_timestamp()
            and session.absolute_expires_at > clock_timestamp()
            and account.status = 'active'
            and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
            and account.token_version = session.account_token_version
          returning session.id::text, session.account_id::text, account.subject`,
        [this.sha256(refreshToken), kind],
      );
      const ended = result.rows[0];
      if (!ended) return undefined;
      await this.insertSessionEvent(client, {
        eventType: 'logout', outcome: 'success', accountId: ended.account_id, sessionId: ended.id, event,
        details: { actor_subject: ended.subject },
      });
      return { sessionId: ended.id, accountId: ended.account_id, subject: ended.subject };
    });
  }

  /**
   * The kind of the staff or patient sign-in a refresh token belongs to, read
   * without rotating it, while refresh() could still renew it: the session is
   * not revoked or expired and its account is active at the same token
   * version. Any other token has no kind here and is left to refresh(), which
   * refuses it and clears its cookies. Read only by single sign-on's session
   * check (SsoSessionEndFilter), to tell an ended sign-in from an access token
   * that merely expired.
   */
  async refreshSessionKind(refreshToken: string): Promise<'staff' | 'patient' | undefined> {
    const result = await this.database.query<{ session_kind: 'staff' | 'patient' }>(
      `select session.session_kind
         from auth.sessions session
         join auth.accounts account on account.id = session.account_id
        where session.refresh_token_sha256 = $1
          and session.session_kind in ('staff', 'patient')
          and session.revoked_at is null
          and session.expires_at > clock_timestamp()
          and session.absolute_expires_at > clock_timestamp()
          and account.status = 'active'
          and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
          and account.token_version = session.account_token_version`,
      [this.sha256(refreshToken)],
    );
    return result.rows[0]?.session_kind;
  }

  /** Appends a session event in the caller's transaction (never with secrets in details). */
  recordSessionEvent(client: PoolClient, input: SessionEventInput): Promise<void> {
    return this.insertSessionEvent(client, input);
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
    const actor = await this.currentStaff.resolve(payload.sub, 'oidc').catch((error: unknown) => {
      if (isProductGateRefusal(error)) throw new UnauthorizedException('Staff account or facility membership is inactive');
      throw error;
    });
    return { claims: payload, actor };
  }

  private async signAccessToken(
    actor: ActorContext,
    sessionId: string,
    accessJti: string,
    tokenVersion: number,
    csrfToken: string,
    expiresAt: Date,
    product?: StaffProduct,
  ): Promise<string> {
    if (!this.signingKey) throw new Error('Internal token signing is not configured');
    return new SignJWT({
      actor_kind: actor.kind ?? 'staff',
      patient_id: actor.patientId,
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
      ...(product ? { product } : {}),
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
    if (method !== 'local' && method !== 'oidc') throw new UnauthorizedException('Invalid authentication method');
    if (payload.actor_kind !== undefined && payload.actor_kind !== 'staff' && payload.actor_kind !== 'patient') {
      throw new UnauthorizedException('Invalid actor context');
    }
    if (payload.actor_kind === 'patient' && typeof payload.patient_id !== 'string') {
      throw new UnauthorizedException('Patient identity binding is missing');
    }
    if (payload.product !== undefined && !isStaffProduct(payload.product)) {
      throw new UnauthorizedException('Invalid product');
    }
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
      actor_kind: payload.actor_kind ?? 'staff',
      patient_id: typeof payload.patient_id === 'string' ? payload.patient_id : undefined,
      csrf_hash: typeof payload.csrf_hash === 'string' ? payload.csrf_hash : undefined,
      token_version: payload.token_version,
      product: isStaffProduct(payload.product) ? payload.product : undefined,
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
          and session.session_kind = $6
          and session.patient_id is not distinct from $7::uuid
          and account.token_version = session.account_token_version
          and account.status = 'active'
          and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
          and session.revoked_at is null
          and session.expires_at > clock_timestamp()
          and session.absolute_expires_at > clock_timestamp()`,
      [claims.sid, claims.sub, claims.jti, claims.token_version, this.databaseMethod(claims.auth_method), claims.actor_kind ?? 'staff', claims.patient_id ?? null],
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
      accountTokenVersion: number; authenticationMethod: 'local' | 'oidc';
      actorKind: 'staff' | 'patient';
      patientId?: string;
      issuedAt: Date; expiresAt: Date; absoluteExpiresAt: Date; event: SessionEventMetadata;
    },
  ): Promise<void> {
    await client.query(
      `insert into auth.sessions (
         id, account_id, family_id, refresh_token_sha256, access_jti,
         account_token_version, authentication_method,
         issued_at, expires_at, absolute_expires_at, source_ip, user_agent_sha256, session_kind, patient_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        input.id, input.accountId, input.familyId, this.sha256(input.refreshToken), input.accessJti,
        input.accountTokenVersion, this.databaseMethod(input.authenticationMethod),
        input.issuedAt, input.expiresAt, input.absoluteExpiresAt, input.event.sourceIp ?? null,
        input.event.userAgent ? this.sha256(input.event.userAgent) : null,
        input.actorKind,
        input.patientId ?? null,
      ],
    );
  }

  private async insertSessionEvent(client: PoolClient, input: SessionEventInput): Promise<void> {
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

  /**
   * A session's idle (refresh) and absolute lifetimes by its kind. Patients:
   * 7 days idle, 30 days at most (owner decision of 2026-10-28); staff and
   * platform sessions keep their own pair (8 hours and 24 hours by default).
   * The access token's lifetime is the same for both. A staff session
   * signed in or refreshed from an outreach. site idles out after
   * AUTH_OUTREACH_REFRESH_TTL_SECONDS instead (24 hours by default, owner
   * decision of 2026-11-14), never past the absolute lifetime.
   */
  private lifetimes(kind: 'staff' | 'patient', origin?: string): { refreshSeconds: number; absoluteSeconds: number } {
    if (kind === 'patient') {
      return { refreshSeconds: this.environment.AUTH_PATIENT_REFRESH_TTL_SECONDS,
        absoluteSeconds: this.environment.AUTH_PATIENT_ABSOLUTE_TTL_SECONDS };
    }
    const refreshSeconds = isOutreachOrigin(origin)
      ? Math.min(this.environment.AUTH_OUTREACH_REFRESH_TTL_SECONDS, this.environment.AUTH_ABSOLUTE_TTL_SECONDS)
      : this.environment.AUTH_REFRESH_TTL_SECONDS;
    return { refreshSeconds, absoluteSeconds: this.environment.AUTH_ABSOLUTE_TTL_SECONDS };
  }

  /**
   * The lifetimes of a new sign-in, as they are for any sign-in, except that
   * a single sign-on's never run past `absoluteSeconds` after the person
   * signed in at the provider: a hand-off is not a new sign-in, so the
   * absolute end counts from the provider's auth_time. Without a single
   * sign-on every lifetime is returned unchanged.
   */
  private singleSignOnEnd(now: Date, absoluteSeconds: number,
    singleSignOn: SingleSignOnProvenance | undefined): (lifetimeEnd: Date) => Date {
    if (!singleSignOn) return (lifetimeEnd) => lifetimeEnd;
    const signInEnd = singleSignOn.authenticatedAt.getTime() + absoluteSeconds * 1_000;
    if (signInEnd <= now.getTime() + 1_000) {
      throw new UnauthorizedException('The sign-in at the provider has reached its absolute end');
    }
    return (lifetimeEnd) => new Date(Math.min(lifetimeEnd.getTime(), signInEnd));
  }

  /** Stores a single sign-on's provenance on its new family (0127), in the session's transaction. */
  private async recordSingleSignOn(client: PoolClient, familyId: string, accountId: string,
    singleSignOn: SingleSignOnProvenance): Promise<void> {
    await client.query(
      `insert into auth.session_single_sign_on
         (family_id, account_id, client_id, provider_sid, authenticated_at)
       values ($1, $2, $3, $4, $5)`,
      [familyId, accountId, singleSignOn.clientId, singleSignOn.providerSid, singleSignOn.authenticatedAt],
    );
  }

  /**
   * `<session id>.<secret>.<method>`, or `<session id>.<secret>.<product>.<method>`
   * for a staff session issued on a product site (Q88-1): the product rides in
   * the token, so a refresh re-applies the product the session was issued
   * under rather than whatever Origin the refresh request names.
   */
  private newRefreshToken(sessionId: string, method: 'local' | 'oidc', product?: StaffProduct): string {
    const secret = randomBytes(48).toString('base64url');
    return product ? `${sessionId}.${secret}.${product}.${method}` : `${sessionId}.${secret}.${method}`;
  }

  /** The product a refresh token was issued under (newRefreshToken), or undefined for one with none. */
  private refreshProduct(token: string): StaffProduct | undefined {
    const parts = token.split('.');
    if (parts.length === 3) return undefined;
    if (parts.length === 4 && isStaffProduct(parts[2])) return parts[2];
    throw new UnauthorizedException('Invalid refresh session');
  }

  private async resolveActor(
    subject: string,
    method: ActorContext['authenticationMethod'],
    kind: 'staff' | 'patient',
    sessionId?: string,
    product?: StaffProduct,
  ): Promise<ActorContext> {
    if (kind === 'patient') {
      if (!this.currentPatient) throw new UnauthorizedException('Patient session is unavailable');
      const patient = await this.currentPatient.resolve(subject, sessionId);
      return { ...patient, authenticationMethod: method };
    }
    return product
      ? this.currentStaff.resolve(subject, method, sessionId, undefined, { product })
      : this.currentStaff.resolve(subject, method, sessionId);
  }

  private refreshMethod(token: string): 'local' | 'oidc' {
    const method = token.split('.').at(-1);
    if (method !== 'local' && method !== 'oidc') throw new UnauthorizedException('Invalid refresh session');
    return method;
  }

  private databaseMethod(method: 'local' | 'oidc'): 'password' | 'oidc' {
    return method === 'oidc' ? 'oidc' : 'password';
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

function isDatabaseError(value: unknown): value is { code: string; message: string } {
  return value instanceof Error && typeof (value as { code?: unknown }).code === 'string';
}
