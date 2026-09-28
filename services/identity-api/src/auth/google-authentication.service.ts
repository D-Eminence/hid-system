import { timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { LoginResult } from './auth.types';
import type { SessionEventMetadata } from './token.service';
import { TokenService } from './token.service';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

interface GoogleIdentityRow extends QueryResultRow {
  account_id: string;
  account_subject: string;
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

  constructor(private readonly database: DatabaseService, private readonly tokens: TokenService) {}

  async login(
    idToken: string,
    nonce: string | undefined,
    actorKind: 'patient' | 'staff',
    event: SessionEventMetadata,
  ): Promise<LoginResult> {
    if (this.environment.AUTH_MODE !== 'local' || this.clientIds.length === 0) {
      throw new DomainProblem(503, 'GOOGLE_SIGN_IN_UNAVAILABLE', 'Google sign-in is unavailable');
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

    let mapped: GoogleIdentityRow | undefined;
    try {
      const result = await this.database.query<GoogleIdentityRow>(
        `select account_id::text, account_subject
           from auth.resolve_google_identity($1)`,
        [subject],
      );
      mapped = result.rows.length === 1 ? result.rows[0] : undefined;
    } catch {
      // Mapping lookup errors and absent/revoked mappings intentionally have
      // distinct operational telemetry only, never distinct client behavior.
      throw this.denied();
    }
    if (!mapped) throw this.denied();

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
