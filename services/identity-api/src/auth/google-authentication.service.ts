import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { ActorContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { LoginResult } from './auth.types';
import { AuthSessionAuditService } from './auth-session-audit.service';
import { LocalAuthProvider } from './local-auth.provider';
import type { SessionEventMetadata } from './token.service';
import { TokenService } from './token.service';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

interface GoogleIdentityRow extends QueryResultRow {
  account_id: string;
  account_subject: string;
}

interface VerifiedGoogleIdentity {
  subject: string;
  verifiedEmail?: string;
}

export interface GooglePendingOnboarding {
  stage: 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY';
  expiresAt: string;
}

export type GoogleExchangeResult =
  | { kind: 'session'; session: LoginResult }
  | { kind: 'pending'; cookie: string; progress: GooglePendingOnboarding; expiresAt: Date };

const PENDING_TOKEN_TTL_MS = 30 * 60 * 1_000;

@Injectable()
export class GoogleAuthenticationService {
  private readonly environment = getEnvironment();
  private readonly clientIds = Object.freeze(
    (this.environment.GOOGLE_OIDC_CLIENT_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  private readonly jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

  constructor(
    private readonly database: DatabaseService,
    private readonly tokens: TokenService,
    private readonly localProvider: LocalAuthProvider,
    private readonly sessionAudit: AuthSessionAuditService,
  ) {}

  get onboardingCookieName(): string {
    return `${this.environment.AUTH_COOKIE_NAME}_google_onboarding`;
  }

  async exchange(
    idToken: string,
    nonce: string | undefined,
    actorKind: 'patient' | 'staff',
    intent: 'sign_in' | 'enroll',
    event: SessionEventMetadata,
  ): Promise<GoogleExchangeResult> {
    const identity = await this.verifiedIdentity(idToken, nonce);
    const mapped = await this.resolveExisting(identity.subject);
    if (mapped) return { kind: 'session', session: await this.issueMapped(mapped, actorKind, event) };
    if (intent !== 'enroll' || actorKind !== 'patient') throw this.denied();
    // A verified Google email is a conflict hint only. It never authenticates
    // an HID account or proves two patient identities belong to one person.
    if (identity.verifiedEmail && await this.hasExistingAccountEmail(identity.verifiedEmail)) {
      throw new DomainProblem(409, 'GOOGLE_EXISTING_ACCOUNT_LINK_REQUIRED',
        'Sign in to your existing Health ID account to link Google');
    }

    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.sha256(token);
    try {
      const result = await this.database.withSystemTransaction(event.correlationId, (client) =>
        client.query<{ expires_at: Date }>(
          'select auth.create_google_onboarding_capability($1,$2,$3) as expires_at',
          [id, tokenHash, identity.subject],
        ));
      const expiresAt = result.rows[0]?.expires_at;
      if (!(expiresAt instanceof Date) || expiresAt.getTime() > Date.now() + PENDING_TOKEN_TTL_MS + 5_000) {
        throw new Error('Invalid Google onboarding expiry');
      }
      return {
        kind: 'pending', cookie: `${id}.${token}`, expiresAt,
        progress: { stage: 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY', expiresAt: expiresAt.toISOString() },
      };
    } catch {
      // A revoked, disabled, or concurrently linked Google subject is never
      // turned into a new patient through this path.
      throw this.denied();
    }
  }

  async login(
    idToken: string,
    nonce: string | undefined,
    actorKind: 'patient' | 'staff',
    event: SessionEventMetadata,
  ): Promise<LoginResult> {
    const identity = await this.verifiedIdentity(idToken, nonce);
    const mapped = await this.resolveExisting(identity.subject);
    if (!mapped) throw this.denied();
    return this.issueMapped(mapped, actorKind, event);
  }

  async onboardingStatus(cookie: string | undefined): Promise<GooglePendingOnboarding> {
    const capability = this.parsePendingCookie(cookie);
    let result;
    try {
      result = await this.database.query<{ expires_at: Date }>(
        'select auth.google_onboarding_capability_status($1,$2) as expires_at',
        [capability.id, capability.tokenHash],
      );
    } catch {
      throw this.unavailable();
    }
    const expiresAt = result.rows[0]?.expires_at;
    if (!(expiresAt instanceof Date)) throw this.pendingDenied();
    return { stage: 'GOOGLE_AUTHENTICATED_PENDING_IDENTITY', expiresAt: expiresAt.toISOString() };
  }

  async bindPendingInTransaction(
    client: PoolClient,
    cookie: string,
    enrollmentId: string,
    enrollmentTokenHmac: string,
  ): Promise<void> {
    const capability = this.parsePendingCookie(cookie);
    try {
      await client.query('select auth.bind_google_onboarding_capability($1,$2,$3,$4)',
        [capability.id, capability.tokenHash, enrollmentId, enrollmentTokenHmac]);
    } catch (error) {
      throw this.pendingMutationError(error);
    }
  }

  async consumePendingInTransaction(
    client: PoolClient,
    cookie: string | undefined,
    enrollmentId: string,
    accountId: string,
  ): Promise<void> {
    const capability = cookie ? this.parsePendingCookie(cookie) : undefined;
    try {
      await client.query('select auth.consume_google_onboarding_capability($1,$2,$3,$4)',
        [capability?.id ?? null, capability?.tokenHash ?? null, enrollmentId, accountId]);
    } catch (error) {
      throw this.pendingMutationError(error);
    }
  }

  async linkExistingPatient(
    idToken: string,
    nonce: string | undefined,
    principal: string,
    password: string,
    actor: ActorContext,
    event: SessionEventMetadata,
  ): Promise<void> {
    if (actor.kind !== 'patient' || !actor.patientId) throw this.denied();
    // An existing session alone is insufficient to link an external identity.
    // Password verification is a fresh HID proof, independent of Google email.
    let credential;
    try {
      credential = await this.localProvider.authenticate(principal, password, 'patient', event.correlationId);
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) {
        throw this.unavailable();
      }
      await this.sessionAudit.recordLoginFailure(principal, event);
      throw this.denied();
    }
    if (credential.accountId !== actor.accountId) {
      await this.sessionAudit.recordLoginFailure(principal, event);
      throw this.denied();
    }
    const { subject } = await this.verifiedIdentity(idToken, nonce);
    try {
      await this.database.withSystemTransaction(event.correlationId, (client) =>
        client.query('select auth.link_google_identity_to_patient_account($1,$2)',
          [actor.accountId, subject]));
    } catch {
      throw this.denied();
    }
  }

  private async verifiedIdentity(idToken: string, nonce: string | undefined): Promise<VerifiedGoogleIdentity> {
    if (this.environment.AUTH_MODE !== 'local' || this.clientIds.length === 0) {
      throw this.unavailable();
    }
    const token = idToken.trim();
    if (token.length < 32 || token.length > 12_000 || !nonce || nonce.length < 32 || nonce.length > 256) {
      throw this.denied();
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: [...GOOGLE_ISSUERS],
        audience: [...this.clientIds],
        algorithms: ['RS256'],
      }));
    } catch {
      throw this.denied();
    }
    if (!this.matchesNonce(payload, nonce) || !this.validAudienceAndAuthorizedParty(payload)) {
      throw this.denied();
    }
    const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!subject || subject.length > 255) throw this.denied();

    const email = (payload as JWTPayload & { email?: unknown }).email;
    const verified = (payload as JWTPayload & { email_verified?: unknown }).email_verified === true;
    const verifiedEmail = verified && typeof email === 'string' ? email.trim().toLowerCase() : '';
    return { subject,
      ...(verifiedEmail && verifiedEmail.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(verifiedEmail)
        ? { verifiedEmail } : {}),
    };
  }

  private async hasExistingAccountEmail(email: string): Promise<boolean> {
    try {
      const result = await this.database.query<{ found: boolean }>(
        `select exists (select 1 from auth.accounts
          where lower(email) = $1 and status <> 'deleted') as found`, [email]);
      return result.rows[0]?.found === true;
    } catch {
      throw this.unavailable();
    }
  }

  private async resolveExisting(subject: string): Promise<GoogleIdentityRow | undefined> {
    try {
      const result = await this.database.query<GoogleIdentityRow>(
        `select account_id::text, account_subject
           from auth.resolve_google_identity($1)`,
        [subject],
      );
      return result.rows.length === 1 ? result.rows[0] : undefined;
    } catch {
      // Mapping lookup errors and absent/revoked mappings intentionally have
      // distinct operational telemetry only, never distinct client behavior.
      throw this.denied();
    }
  }

  private async issueMapped(mapped: GoogleIdentityRow, actorKind: 'patient' | 'staff', event: SessionEventMetadata) {
    try {
      return await this.tokens.issue({
        subject: mapped.account_subject,
        accountId: mapped.account_id,
        email: '',
        displayName: '',
        facilities: [],
        actorKind,
        authenticationMethod: 'oidc',
      }, event);
    } catch {
      // A link can point to an inactive or wrong-kind account. It must not
      // trigger a fallback account/patient creation or reveal why it failed.
      throw this.denied();
    }
  }

  private parsePendingCookie(cookie: string | undefined): { id: string; tokenHash: string } {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i
      .exec(cookie ?? '');
    if (!match) throw this.pendingDenied();
    return { id: match[1]!, tokenHash: this.sha256(match[2]!) };
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private pendingDenied(): DomainProblem {
    return new DomainProblem(404, 'GOOGLE_ONBOARDING_NOT_FOUND', 'No pending Google onboarding was found');
  }

  private pendingMutationError(error: unknown): DomainProblem {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code : undefined;
    return code === '23505' || code === '42501' ? this.pendingDenied() : this.unavailable();
  }

  private unavailable(): DomainProblem {
    return new DomainProblem(503, 'GOOGLE_SIGN_IN_UNAVAILABLE', 'Google sign-in is unavailable');
  }

  private validAudienceAndAuthorizedParty(payload: JWTPayload): boolean {
    const audiences = Array.isArray(payload.aud)
      ? payload.aud.filter((value): value is string => typeof value === 'string')
      : typeof payload.aud === 'string' ? [payload.aud] : [];
    if (!audiences.some((value) => this.clientIds.includes(value))) return false;
    const authorizedParty = (payload as JWTPayload & { azp?: unknown }).azp;
    return audiences.length <= 1
      || (typeof authorizedParty === 'string'
        && audiences.includes(authorizedParty)
        && this.clientIds.includes(authorizedParty));
  }

  private matchesNonce(payload: JWTPayload, nonce: string): boolean {
    const tokenNonce = (payload as JWTPayload & { nonce?: unknown }).nonce;
    if (typeof tokenNonce !== 'string') return false;
    const expected = Buffer.from(nonce);
    const actual = Buffer.from(tokenNonce);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private denied(): DomainProblem {
    return new DomainProblem(401, 'GOOGLE_SIGN_IN_DENIED', 'Google sign-in could not be completed for this HID account');
  }
}
