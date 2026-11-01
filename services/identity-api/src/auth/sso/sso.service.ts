import { createHash } from 'node:crypto';
import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { PublicDetailProblem } from '../../common/problem';
import { getEnvironment } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import { AuthSessionAuditService } from '../auth-session-audit.service';
import type { LoginResult } from '../auth.types';
import { staffMfaRequired, TokenService, type SessionEventMetadata, type SingleSignOnProvenance } from '../token.service';
import { ssoClientForRequest, ssoConfiguration, type SsoClient, type SsoConfiguration } from './sso-config';
import { SsoProviderUnavailable, SsoTokenRefused } from './sso-errors';
import { SsoProviderClient, type VerifiedIdToken } from './sso-provider.client';
import {
  newTransaction,
  openTransaction,
  pkceChallenge,
  RANDOM_VALUE,
  type ReplacedSignIn,
  sameValue,
  sealTransaction,
  transactionCookieName,
  transactionDigest,
} from './sso-transaction';

/** Answers to a silent request (prompt=none) that mean "ask the person": start again with a page. */
const ASK_THE_PERSON = new Set(['login_required', 'interaction_required', 'consent_required', 'account_selection_required']);
/** A callback's query is a code, a state and an issuer: anything longer is refused unread. */
const MAX_CALLBACK_QUERY_LENGTH = 4_096;
/**
 * How far a credential change may follow the provider's `auth_time` and still
 * count as before it: `auth_time` is in whole seconds, and the provider's
 * clock and the database's may differ by a little.
 */
export const SSO_CREDENTIAL_CHANGE_ALLOWANCE_MS = 5_000;

/** What a start may ask of the provider: no page (a quiet check), or a fresh sign-in (a recent sign-in is needed). */
export type SsoPrompt = 'none' | 'login';

/** Where to send the browser to sign in at the provider, and the transaction cookie that goes with it. */
export interface SsoAuthorization {
  readonly location: string;
  readonly cookieName: string;
  readonly cookieValue: string;
}

export type SsoCallbackOutcome =
  | { readonly kind: 'signed_in'; readonly session: LoginResult; readonly returnTo: string }
  | { readonly kind: 'ask'; readonly authorization: SsoAuthorization }
  | { readonly kind: 'refused' };

/**
 * The relying party of a product host (ADR-070, contract v2 "The relying
 * party in identity-api"). It starts a sign-in at the provider, finishes it at
 * the product's callback by issuing the product's own session through today's
 * session code (TokenService.issue for a patient, issueStaffSession with the
 * account's MFA factor for staff), receives back-channel logout, and builds the
 * end-session address of a product sign-out. It never shares a cookie between
 * hosts: each product keeps its own host-only session.
 */
@Injectable()
export class SsoService {
  private readonly environment = getEnvironment();

  constructor(
    private readonly database: DatabaseService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly sessionAudit: AuthSessionAuditService,
    private readonly provider: SsoProviderClient,
  ) {}

  /** The client of the product host this request came through, while single sign-on is on. */
  clientFor(request: { header(name: string): string | undefined }): SsoClient | undefined {
    const configuration = ssoConfiguration(this.environment);
    return configuration ? ssoClientForRequest(configuration, request) : undefined;
  }

  /**
   * The live session of this product the browser already holds, if any: its
   * access cookie verifies (TokenService.verify), is of the client's kind and,
   * for staff, has live MFA assurance (MFA-1). A refused token is no session; a
   * fault is answered as one (ADR-059), never as "signed out".
   */
  async liveSession(client: SsoClient, accessToken: string | undefined): Promise<ReplacedSignIn | undefined> {
    if (!accessToken) return undefined;
    try {
      const verified = await this.tokens.verify(accessToken);
      const kind = verified.actor.kind === 'patient' ? 'patient'
        : verified.actor.kind === 'platform' ? 'platform' : 'staff';
      if (kind !== client.kind || (kind !== 'patient' && verified.mfaAssured !== true)) return undefined;
      return { accountId: verified.actor.accountId.toLowerCase(),
        ...(verified.actor.sessionId ? { sessionId: verified.actor.sessionId.toLowerCase() } : {}) };
    } catch (error) {
      if (error instanceof UnauthorizedException) return undefined;
      throw error;
    }
  }

  /**
   * A new sign-in at the provider: the authorization request openid-client
   * builds (code flow, `openid`, S256 PKCE, `state`, `nonce`, `max_age` equal
   * to the absolute sign-in lifetime, and `prompt` when asked) and the
   * transaction cookie that keeps the verifier, nonce and return page on the
   * product host. A fresh sign-in (`prompt=login`) asked for over a live
   * session of this product also keeps that sign-in (`replaces`): the callback
   * then accepts only its account, and ends it.
   */
  async authorization(client: SsoClient, returnTo: string, prompt?: SsoPrompt,
    live?: ReplacedSignIn): Promise<SsoAuthorization> {
    const configuration = this.requireConfiguration();
    const transaction = newTransaction(client.id, returnTo, prompt === 'none', Date.now(),
      prompt === 'login' ? live : undefined);
    const location = await this.provider.authorizationUrl(configuration, client, {
      state: transaction.state,
      nonce: transaction.nonce,
      codeChallenge: await pkceChallenge(transaction.verifier),
      maxAgeSeconds: this.environment.AUTH_ABSOLUTE_TTL_SECONDS,
      ...(prompt ? { prompt } : {}),
    });
    return {
      location,
      cookieName: transactionCookieName(transaction.state),
      cookieValue: sealTransaction(this.signingSecret(), transaction),
    };
  }

  /**
   * The callback. The transaction must be the one this product host started
   * for this `state` (signature, expiry, client) and is spent once. A silent
   * request the provider could not answer without the person starts again
   * with a page. A code is exchanged with the verifier and the client's
   * authentication, the ID token checked, and the product's session issued as
   * today's sign-in issues it, with the provider's `sid` stored on the family.
   * A fresh sign-in asked for over a live session (`replaces`) must be of the
   * same account, and then ends that earlier sign-in as today's sign-out ends
   * one (TokenService.revoke), so a browser keeps one sign-in per product.
   * Every other outcome is refused and audited; the caller then sends the
   * browser to the product's own sign-in page with nothing in the address.
   */
  async complete(client: SsoClient, callbackQuery: string, cookies: Readonly<Record<string, string>>,
    event: SessionEventMetadata): Promise<SsoCallbackOutcome> {
    try {
      if (callbackQuery.length > MAX_CALLBACK_QUERY_LENGTH) throw new SsoTokenRefused('callback');
      const parameters = new URLSearchParams(callbackQuery);
      const states = parameters.getAll('state');
      const state = states.length === 1 && RANDOM_VALUE.test(states[0]!) ? states[0]! : undefined;
      if (!state) throw new SsoTokenRefused('state');
      const transaction = openTransaction(this.signingSecret(), cookies[transactionCookieName(state)]);
      if (!transaction || !sameValue(transaction.state, state)) throw new SsoTokenRefused('transaction');
      if (transaction.clientId !== client.id) throw new SsoTokenRefused('transaction_client');
      const spent = await this.database.withSystemTransaction(event.correlationId, (database) =>
        this.spendOnce(database, 'transaction', transactionDigest(state), new Date(transaction.expiresAt * 1_000)));
      if (!spent) throw new SsoTokenRefused('transaction_replayed');
      const errors = parameters.getAll('error');
      if (errors.length > 0) {
        if (transaction.silent && errors.length === 1 && ASK_THE_PERSON.has(errors[0]!)) {
          return { kind: 'ask', authorization: await this.authorization(client, transaction.returnTo) };
        }
        const code = errors.length === 1 && /^[a-z_]{1,64}$/.test(errors[0]!) ? errors[0] : 'other';
        throw new SsoTokenRefused(`provider_error:${code}`);
      }
      const configuration = this.requireConfiguration();
      const { verified } = await this.provider.completeCodeFlow(configuration, client, parameters, {
        state: transaction.state,
        nonce: transaction.nonce,
        verifier: transaction.verifier,
        maxAgeSeconds: this.environment.AUTH_ABSOLUTE_TTL_SECONDS,
      });
      // A fresh sign-in as another account would leave the earlier one behind: refused.
      if (transaction.replaces && transaction.replaces.accountId !== verified.accountId) {
        throw new SsoTokenRefused('account_changed');
      }
      const provenance: SingleSignOnProvenance = {
        clientId: client.id, providerSid: verified.sid, authenticatedAt: verified.authenticatedAt,
      };
      const session = client.kind === 'staff'
        ? await this.issueStaffSession(client, verified, provenance, event)
        : await this.issuePatientSession(client, verified, provenance, event);
      if (transaction.replaces?.sessionId) {
        await this.tokens.revoke(transaction.replaces.sessionId, session.actor.subject, event);
      }
      return { kind: 'signed_in', session, returnTo: transaction.returnTo };
    } catch (error) {
      await this.recordRefusal(client, error, event);
      return { kind: 'refused' };
    }
  }

  /**
   * A back-channel logout (OpenID Connect Back-Channel Logout 1.0): a logout
   * token this client accepts, its `jti` spent once, then every sign-in the
   * provider session `sid` opened is ended, whichever product it opened (one
   * provider session ending is "signed out everywhere"), or, when the token
   * names only `sub`, every staff and patient sign-in of that account. Each is
   * ended as sign-out ends one (the account row first, 0073), recorded as a
   * `revoked` session event and audited. Answers how many sign-ins ended.
   */
  async backchannelLogout(client: SsoClient, logoutToken: string, event: SessionEventMetadata): Promise<number> {
    const configuration = this.requireConfiguration();
    const verified = await this.provider.verifyLogoutToken(configuration, client, logoutToken);
    const digest = createHash('sha256').update(`hid-sso-logout-token:${configuration.issuer}\n${verified.jti}`, 'utf8')
      .digest('hex');
    return this.database.withSystemTransaction(event.correlationId, async (database) => {
      if (!await this.spendOnce(database, 'logout_token', digest, verified.acceptableUntil)) {
        throw new SsoTokenRefused('jti_replayed');
      }
      const accounts = verified.sid
        ? (await database.query<{ account_id: string }>(
          `select distinct account_id::text from auth.session_single_sign_on
            where provider_sid = $1 and ($2::uuid is null or account_id = $2::uuid)
            order by 1`,
          [verified.sid, verified.accountId ?? null])).rows.map((row) => row.account_id)
        : [verified.accountId!];
      // Account rows first, in id order, as every revocation locks them (0073).
      for (const accountId of accounts) await database.query('select auth.lock_account_sessions($1)', [accountId]);
      const ended = verified.sid
        ? await database.query<{ id: string; account_id: string; family_id: string }>(
          `update auth.sessions session
              set revoked_at = clock_timestamp(), revocation_reason = 'sso_logout', row_version = session.row_version + 1
             from auth.session_single_sign_on single_sign_on
            where single_sign_on.family_id = session.family_id
              and single_sign_on.provider_sid = $1
              and ($2::uuid is null or single_sign_on.account_id = $2::uuid)
              and session.revoked_at is null
            returning session.id::text, session.account_id::text, session.family_id::text`,
          [verified.sid, verified.accountId ?? null])
        : await database.query<{ id: string; account_id: string; family_id: string }>(
          `update auth.sessions
              set revoked_at = clock_timestamp(), revocation_reason = 'sso_logout', row_version = row_version + 1
            where account_id = $1 and session_kind in ('staff', 'patient') and revoked_at is null
            returning id::text, account_id::text, family_id::text`,
          [verified.accountId]);
      const endedSignIns = await this.recordEndedSignIns(database, client, ended.rows, event);
      await this.audit.recordWithClient(database, {
        correlationId: event.correlationId,
        actorType: 'system',
        action: 'auth.sso.backchannel-logout',
        resourceType: 'session',
        outcome: 'success',
        sourceIp: event.sourceIp,
        userAgent: event.userAgent,
        details: { client: client.id, matchedBy: verified.sid ? 'sid' : 'sub', endedSignIns },
        provenance: 'system',
      });
      return endedSignIns;
    });
  }

  /**
   * Product sign-out signs out everywhere (contract v2). After today's
   * sign-out has ended the sign-in the request proved it holds, every other
   * unrevoked sign-in of that account and kind ends too, whichever product
   * issued it and however: through this provider session, an earlier one, or
   * a product's own sign-in page (single sign-on's fallback), which the
   * provider never saw, so its back-channel logout cannot reach it. A sign-in
   * on another device ends as well, as the product cannot tell browsers
   * apart; while that device's provider session lives, its next page hands
   * off again quietly. Ended as back-channel logout ends them: the account
   * row first (0073), reason `sso_logout`, a `revoked` session event per
   * sign-in and one audit row. Answers how many ended.
   */
  async endAccountSignIns(client: SsoClient, signedOut: { accountId: string; kind: 'staff' | 'patient' },
    event: SessionEventMetadata): Promise<number> {
    return this.database.withSystemTransaction(event.correlationId, async (database) => {
      await database.query('select auth.lock_account_sessions($1)', [signedOut.accountId]);
      const ended = await database.query<{ id: string; account_id: string; family_id: string }>(
        `update auth.sessions
            set revoked_at = clock_timestamp(), revocation_reason = 'sso_logout', row_version = row_version + 1
          where account_id = $1 and session_kind = $2 and revoked_at is null
          returning id::text, account_id::text, family_id::text`,
        [signedOut.accountId, signedOut.kind]);
      const endedSignIns = await this.recordEndedSignIns(database, client, ended.rows, event);
      await this.audit.recordWithClient(database, {
        correlationId: event.correlationId,
        actorType: signedOut.kind,
        actorAccountId: signedOut.accountId,
        action: 'auth.sso.logout',
        resourceType: 'session',
        outcome: 'success',
        sourceIp: event.sourceIp,
        userAgent: event.userAgent,
        details: { client: client.id, endedSignIns },
      });
      return endedSignIns;
    });
  }

  /**
   * The provider's end-session address for a product sign-out:
   * `post_logout_redirect_uri` is the product's own root and `client_id` this
   * client. No token travels in it (SsoProviderClient.endSessionUrl).
   */
  async endSessionUrl(client: SsoClient): Promise<string> {
    try {
      return await this.provider.endSessionUrl(this.requireConfiguration(), client);
    } catch (error) {
      if (!(error instanceof SsoProviderUnavailable)) throw error;
      throw new PublicDetailProblem(503, 'SSO_PROVIDER_UNAVAILABLE',
        'You are signed out of this product, but the other products could not be signed out. Try again.');
    }
  }

  /** Records why a start or callback was refused: no token, code or account value, only a reason. */
  async recordRefusal(client: SsoClient, error: unknown, event: SessionEventMetadata): Promise<void> {
    const fault = error instanceof SsoProviderUnavailable
      || !(error instanceof SsoTokenRefused || error instanceof HttpException);
    const reason = error instanceof SsoProviderUnavailable || error instanceof SsoTokenRefused ? error.reason
      : error instanceof HttpException ? `session_refused_${error.getStatus()}` : 'fault';
    await this.sessionAudit.record({
      correlationId: event.correlationId,
      eventType: 'login_failed',
      outcome: fault ? 'failure' : 'denied',
      sourceIp: event.sourceIp,
      userAgent: event.userAgent,
      details: { authentication_method: 'sso', sso_client: client.id, reason },
    });
  }

  /**
   * A staff session from a single sign-on, as a staff sign-in issues one
   * (MfaService.completeLogin): the account row lock first (Stage 7A), then
   * the account's active factor with a staff enrolment proof, recorded as this
   * sign-in's MFA evidence (0088); no such factor is 403 STAFF_MFA_REQUIRED
   * and no session. Eligibility is re-checked by issueStaffSession (ADR-066).
   * The provider's sign-in must not be older than the account's password
   * change or that factor's activation (signedInSinceCredentials).
   */
  private async issueStaffSession(client: SsoClient, verified: VerifiedIdToken, provenance: SingleSignOnProvenance,
    event: SessionEventMetadata): Promise<LoginResult> {
    const method = verified.mfaMethod;
    if (!method) throw new SsoTokenRefused('staff_mfa');
    return this.database.withSystemTransaction(event.correlationId, async (database) => {
      await database.query('select auth.lock_account_for_mfa($1)', [verified.accountId]);
      const account = (await database.query<{ subject: string; password_changed_at: Date | string | null }>(
        'select subject, password_changed_at from auth.accounts where id = $1', [verified.accountId])).rows[0];
      if (!account) throw new UnauthorizedException('Unknown account');
      const factor = (await database.query<{ id: string; activated_at: Date | string | null }>(
        `select id::text, activated_at from auth.mfa_factors
          where account_id = $1 and status = 'active' and enrollment_proof is not null
          for update`,
        [verified.accountId])).rows[0];
      if (!factor) throw staffMfaRequired();
      signedInSinceCredentials(verified, account.password_changed_at, factor.activated_at);
      const session = await this.tokens.issueStaffSession(database,
        { accountId: verified.accountId, subject: account.subject, factorId: factor.id, method }, event, provenance);
      const facility = session.actor.facility;
      await this.audit.recordWithClient(database, {
        correlationId: event.correlationId, actorType: 'staff', actorSubject: account.subject,
        actorAccountId: verified.accountId,
        ...(facility ? { actorMembershipId: facility.membershipId, organizationId: facility.organizationId,
          facilityId: facility.id } : {}),
        action: 'auth.login', resourceType: 'session', resourceId: session.actor.sessionId, outcome: 'success',
        sourceIp: event.sourceIp, userAgent: event.userAgent, details: { mfaMethod: method, singleSignOn: client.id },
      });
      return session;
    });
  }

  /**
   * A patient session from a single sign-on, as a patient sign-in issues one
   * (TokenService.issue), when the provider's sign-in is not older than the
   * account's password change (signedInSinceCredentials).
   */
  private async issuePatientSession(client: SsoClient, verified: VerifiedIdToken, provenance: SingleSignOnProvenance,
    event: SessionEventMetadata): Promise<LoginResult> {
    const account = (await this.database.query<{ subject: string; password_changed_at: Date | string | null }>(
      'select subject, password_changed_at from auth.accounts where id = $1', [verified.accountId])).rows[0];
    if (!account) throw new UnauthorizedException('Unknown account');
    signedInSinceCredentials(verified, account.password_changed_at);
    const session = await this.tokens.issue({
      actorKind: 'patient', subject: account.subject, accountId: verified.accountId, email: '', displayName: '',
      facilities: [], authenticationMethod: 'local',
    }, event, provenance);
    await this.audit.record({
      correlationId: event.correlationId, actorType: 'patient', actorSubject: session.actor.subject,
      actorAccountId: session.actor.accountId, action: 'auth.login', resourceType: 'session',
      resourceId: session.actor.sessionId, outcome: 'success', sourceIp: event.sourceIp, userAgent: event.userAgent,
      details: { singleSignOn: client.id },
    });
    return session;
  }

  /** A `revoked` session event for each sign-in (family) a single sign-on sign-out ended; answers how many. */
  private async recordEndedSignIns(database: PoolClient, client: SsoClient,
    rows: readonly { id: string; account_id: string; family_id: string }[], event: SessionEventMetadata): Promise<number> {
    const families = new Map<string, { id: string; account_id: string }>();
    for (const row of rows) if (!families.has(row.family_id)) families.set(row.family_id, row);
    for (const row of families.values()) {
      await this.tokens.recordSessionEvent(database, {
        eventType: 'revoked', outcome: 'success', accountId: row.account_id, sessionId: row.id, event,
        details: { reason: 'sso_logout', sso_client: client.id },
      });
    }
    return families.size;
  }

  /**
   * Records a transaction or logout token as spent (0102); false when it was
   * spent before. Rows past the moment their token could still be accepted
   * are removed first: such a token is refused by its own expiry.
   */
  private async spendOnce(database: PoolClient, purpose: 'transaction' | 'logout_token', digest: string,
    acceptableUntil: Date): Promise<boolean> {
    await database.query('delete from auth.sso_spent_tokens where expires_at < clock_timestamp()');
    const spent = await database.query(
      `insert into auth.sso_spent_tokens (purpose, token_sha256, expires_at) values ($1, $2, $3)
       on conflict (purpose, token_sha256) do nothing`,
      [purpose, digest, acceptableUntil],
    );
    return spent.rowCount === 1;
  }

  private requireConfiguration(): SsoConfiguration {
    const configuration = ssoConfiguration(this.environment);
    if (!configuration) throw new SsoProviderUnavailable('single sign-on is not configured');
    return configuration;
  }

  private signingSecret(): string {
    const secret = this.environment.AUTH_SIGNING_SECRET;
    if (!secret) throw new SsoProviderUnavailable('no signing secret');
    return secret;
  }
}

/**
 * Refuses a provider sign-in made before a credential it relies on changed.
 * Password recovery, an administrator's MFA reset, suspension and deletion
 * end every session of the account today (they raise its token_version); a
 * provider session from before them must not open a new one. The provider is
 * asked to end its own sessions then too; this is the product's check of the
 * two changes it can date: the password (`password_changed_at`, which
 * recovery sets) and, for staff, the activation of the authenticator recorded
 * as the sign-in's second factor (`activated_at`, which a new enrolment after
 * a reset sets). A change up to SSO_CREDENTIAL_CHANGE_ALLOWANCE_MS after
 * `auth_time` counts as before it. A change that cannot be read is refused.
 */
function signedInSinceCredentials(verified: VerifiedIdToken, ...changes: (Date | string | null)[]): void {
  const latestAccepted = verified.authenticatedAt.getTime() + SSO_CREDENTIAL_CHANGE_ALLOWANCE_MS;
  for (const change of changes) {
    if (change === null) continue;
    const changedAt = new Date(change).getTime();
    if (!Number.isFinite(changedAt) || changedAt > latestAccepted) throw new SsoTokenRefused('stale_provider_sign_in');
  }
}
