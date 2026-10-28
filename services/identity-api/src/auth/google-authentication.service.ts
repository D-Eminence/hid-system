import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { PoolClient, QueryResultRow } from 'pg';
import { AccountSuspendedProblem } from './account-suspended';
import { DomainProblem } from '../common/problem';
import type { ActorContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { LoginResult } from './auth.types';
import { AuthSessionAuditService } from './auth-session-audit.service';
import { LocalAuthProvider } from './local-auth.provider';
import type { SessionEventMetadata } from './token.service';
import { TokenService } from './token.service';
import { recordAccountSecurityNotice } from './account-security-notice';
import { loginPrincipalKey } from './patient-principal';
import { createContactLookupHmac } from '../identity/contact-lookup';

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

/** Google sign-in refusals a patient is told about (owner decisions of 2026-10-28). */
export const GOOGLE_NOT_REGISTERED_DETAIL = 'This Google account is not registered on Health ID. Use Sign Up first.';
export const GOOGLE_LINK_REQUIRED_DETAIL = 'Sign in with your password, then link Google from Settings.';
export const GOOGLE_ACCOUNT_EXISTS_DETAIL = 'You already have a Health ID. Sign in with Google instead.';

/** What auth.link_google_identity_by_verified_email (0093) answers. */
interface GoogleEmailLinkRow extends QueryResultRow {
  outcome: 'linked' | 'suspended' | 'none' | 'ambiguous' | 'not_verified' | 'linked_elsewhere'
    | 'already_linked' | 'workforce' | 'unverified';
  account_id: string | null;
  account_subject: string | null;
}

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
  private readonly logger = new Logger(GoogleAuthenticationService.name);

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
    // The sign-up page's Google button: an email a patient account already
    // uses starts no sign-up (owner decision of 2026-10-28); the patient signs
    // in with Google instead, which links it (login below). Patients migrated
    // from hid-1.0 count too (0093's auth.patient_email_registered).
    if (identity.verifiedEmail && await this.patientEmailRegistered(identity.verifiedEmail, event)) {
      throw new DomainProblem(409, 'GOOGLE_ACCOUNT_EXISTS', GOOGLE_ACCOUNT_EXISTS_DETAIL);
    }
    // Any other account with the email (a workforce account) is a conflict
    // hint only. It never authenticates an HID account.
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
    if (mapped) return this.issueMapped(mapped, actorKind, event);
    if (actorKind !== 'patient') throw this.denied();
    return this.linkByVerifiedEmail(identity, event);
  }

  /**
   * A patient's first Google sign-in (owner decision of 2026-10-28): when no
   * Google link exists and Google says the email is verified, 0093's
   * auth.link_google_identity_by_verified_email links the Google account to
   * the one active patient account whose verified email it is (migrated
   * hid-1.0 patients included, never a workforce account), with its audit row
   * and the SECURITY_GOOGLE_LINKED inbox notice, and the patient is signed in
   * exactly as a linked Google sign-in is. No patient with the email: 404
   * GOOGLE_NOT_REGISTERED. Two or more, an unverified or other account email,
   * an inactive account, or a Google link the account or subject already has:
   * 409 GOOGLE_LINK_REQUIRED. A suspended patient (the email's, or the one
   * this Google subject is linked to): 403 ACCOUNT_SUSPENDED. No verified
   * email, or a workforce account: the one 401 GOOGLE_SIGN_IN_DENIED.
   */
  private async linkByVerifiedEmail(identity: VerifiedGoogleIdentity, event: SessionEventMetadata): Promise<LoginResult> {
    let linked: GoogleEmailLinkRow | undefined;
    try {
      const lookup = identity.verifiedEmail ? this.emailLookupHmac(identity.verifiedEmail) : null;
      linked = (await this.database.withSystemTransaction(event.correlationId, (client) =>
        client.query<GoogleEmailLinkRow>(
          `select outcome, account_id::text, account_subject
             from auth.link_google_identity_by_verified_email($1, $2, $3)`,
          [identity.subject, identity.verifiedEmail ?? null, lookup]))).rows[0];
    } catch {
      throw this.denied();
    }
    switch (linked?.outcome) {
      case 'linked':
        if (!linked.account_id || !linked.account_subject) throw this.denied();
        return this.issueMapped({ account_id: linked.account_id, account_subject: linked.account_subject },
          'patient', event);
      case 'suspended':
        throw new AccountSuspendedProblem(linked.account_subject ?? '');
      case 'none':
        throw new DomainProblem(404, 'GOOGLE_NOT_REGISTERED', GOOGLE_NOT_REGISTERED_DETAIL);
      case 'ambiguous':
      case 'not_verified':
      case 'linked_elsewhere':
      case 'already_linked':
        throw new DomainProblem(409, 'GOOGLE_LINK_REQUIRED', GOOGLE_LINK_REQUIRED_DETAIL);
      default:
        throw this.denied();
    }
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
      // A suspended account is never linked; it is not this session's
      // account (that one is active), so it gets the one denial.
      if (error instanceof AccountSuspendedProblem) throw this.denied();
      if (!(error instanceof UnauthorizedException)) {
        throw this.unavailable();
      }
      await this.sessionAudit.recordLoginFailure(loginPrincipalKey(principal, 'patient'), event);
      throw this.denied();
    }
    if (credential.accountId !== actor.accountId) {
      await this.sessionAudit.recordLoginFailure(loginPrincipalKey(principal, 'patient'), event);
      throw this.denied();
    }
    const { subject } = await this.verifiedIdentity(idToken, nonce);
    try {
      const accountId = actor.accountId;
      await this.database.withSystemTransaction(event.correlationId, async (client) => {
        await client.query('select auth.link_google_identity_to_patient_account($1,$2)', [accountId, subject]);
        // "A Google account was linked to your Health ID" (0093).
        await recordAccountSecurityNotice(client, accountId, 'SECURITY_GOOGLE_LINKED', this.logger, event.correlationId);
      });
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

  private async patientEmailRegistered(email: string, event: SessionEventMetadata): Promise<boolean> {
    try {
      const lookup = this.emailLookupHmac(email);
      const result = await this.database.withSystemTransaction(event.correlationId, (client) =>
        client.query<{ registered: boolean }>('select auth.patient_email_registered($1, $2) as registered',
          [email, lookup]));
      return result.rows[0]?.registered === true;
    } catch {
      throw this.unavailable();
    }
  }

  /** The email's contact lookup HMAC (a patient's contact email), or null when the key is not configured. */
  private emailLookupHmac(email: string): string | null {
    try {
      return createContactLookupHmac('email', email);
    } catch {
      return null;
    }
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
