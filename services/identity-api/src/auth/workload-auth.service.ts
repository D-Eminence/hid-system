import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyOptions } from 'jose';
import { DomainProblem } from '../common/problem';
import { getEnvironment, type Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { jwksUnavailable } from './jwks-fault';

export type IdentityCaller = 'ehr-api' | 'lab-api' | 'pharmacy-api' | 'ocr-api' | 'outreach-api';

export interface WorkloadActor {
  subject: string;
  accountId: string;
}

const MAX_WORKLOAD_TOKEN_LENGTH = 16_384;

// The workload token contract (ADR-047): the issuer signs ES256 tokens with
// iat = nbf, exp = iat + 300 s and token_use 'workload'. A token without exp
// or iat, older than 300 s, issued in the future, signed with any other
// algorithm or meant for another use is refused. The 5 s clock tolerance
// matches the agent's own allowance for an iat ahead of its clock.
const WORKLOAD_TOKEN_POLICY = {
  algorithms: ['ES256'], requiredClaims: ['exp', 'iat'], maxTokenAge: 300, clockTolerance: 5,
} satisfies JWTVerifyOptions;

const LOCAL_TOKEN_KEYS: Readonly<Record<IdentityCaller, keyof Environment>> = {
  'ehr-api': 'IDENTITY_EHR_INTERNAL_SERVICE_TOKEN',
  'lab-api': 'IDENTITY_LAB_INTERNAL_SERVICE_TOKEN',
  'pharmacy-api': 'IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN',
  'ocr-api': 'IDENTITY_OCR_INTERNAL_SERVICE_TOKEN',
  'outreach-api': 'OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN',
};

const SUBJECT_KEYS: Readonly<Record<IdentityCaller, keyof Environment>> = {
  'ehr-api': 'IDENTITY_EHR_CALLER_SUBJECT',
  'lab-api': 'IDENTITY_LAB_CALLER_SUBJECT',
  'pharmacy-api': 'IDENTITY_PHARMACY_CALLER_SUBJECT',
  'ocr-api': 'IDENTITY_OCR_CALLER_SUBJECT',
  'outreach-api': 'OUTREACH_CALLER_SUBJECT',
};

/**
 * Workload (service-to-service) refusals carry their own codes, never a user
 * refusal's (A5): a calling service tells "Identity refused my workload
 * credential", a fault between services it answers 503, apart from "Identity
 * refused the user's session", which it relays.
 *  - 503 WORKLOAD_IDENTITY_UNAVAILABLE: the issuer's JWKS cannot be fetched or
 *    used, or workload authentication is not configured;
 *  - 401 WORKLOAD_AUTHENTICATION_FAILED: no, or an invalid, workload credential;
 *  - 403 WORKLOAD_CALLER_DENIED: a valid workload token of another caller.
 * A document scanner token is the EHR caller's own credential, not EHR's, so
 * its refusal is 401 DOCUMENT_SCANNER_AUTHENTICATION_FAILED, which EHR relays.
 */
const unavailable = (detail: string) => new DomainProblem(503, 'WORKLOAD_IDENTITY_UNAVAILABLE', detail);
const workloadFailed = () => new DomainProblem(401, 'WORKLOAD_AUTHENTICATION_FAILED', 'Workload authentication failed');
const scannerFailed = () => new DomainProblem(401, 'DOCUMENT_SCANNER_AUTHENTICATION_FAILED',
  'Document scanner authentication failed');

@Injectable()
export class WorkloadAuthService {
  private readonly environment = getEnvironment();
  private readonly jwks = this.environment.WORKLOAD_JWKS_URL
    ? createRemoteJWKSet(new URL(this.environment.WORKLOAD_JWKS_URL)) : undefined;

  constructor(private readonly database: DatabaseService) {}

  async authenticateScanner(authorization: string | undefined): Promise<WorkloadActor> {
    if (!this.jwks || !this.environment.WORKLOAD_ISSUER_URL) {
      throw unavailable('Workload authentication is not configured');
    }
    const payload = await this.verify(this.bearerToken(authorization, scannerFailed), scannerFailed);
    if (!payload.sub) throw scannerFailed();
    const account = await this.database.query<{ account_id: string }>(
      `select account.id::text as account_id
         from auth.accounts account
        where account.subject = $1
          and account.status = 'active'
          and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
          and auth.account_has_active_role(account.id, 'document_scanner')`,
      [payload.sub],
    );
    const accountId = account.rows[0]?.account_id;
    if (!accountId) throw scannerFailed();
    return { subject: payload.sub, accountId };
  }

  async authenticateService(
    callerValue: string | undefined,
    authorization: string | undefined,
    localToken: string | undefined,
  ): Promise<WorkloadActor> {
    if (!isIdentityCaller(callerValue)) throw workloadFailed();
    if (this.environment.IDENTITY_SERVICE_IDENTITY_MODE === 'local-secret') {
      if (this.environment.NODE_ENV === 'production') {
        throw unavailable('Local workload authentication is disabled in production');
      }
      const expected = this.environment[LOCAL_TOKEN_KEYS[callerValue]];
      if (typeof expected !== 'string' || !localToken || !this.equal(localToken, expected)) {
        throw workloadFailed();
      }
      return { subject: `local:${callerValue}`, accountId: `local:${callerValue}` };
    }
    if (!this.jwks || !this.environment.WORKLOAD_ISSUER_URL) {
      throw unavailable('Workload authentication is not configured');
    }
    const payload = await this.verify(this.bearerToken(authorization, workloadFailed), workloadFailed);
    const expectedSubject = this.environment[SUBJECT_KEYS[callerValue]];
    if (typeof expectedSubject !== 'string' || payload.sub !== expectedSubject) {
      throw new DomainProblem(403, 'WORKLOAD_CALLER_DENIED', 'This workload is not an approved caller of this route');
    }
    return { subject: payload.sub, accountId: payload.sub };
  }

  authenticateOutreach(
    caller: string | undefined,
    authorization: string | undefined,
    localToken: string | undefined,
  ): Promise<WorkloadActor> {
    if (caller !== 'outreach-api') return Promise.reject(workloadFailed());
    return this.authenticateService(caller, authorization, localToken);
  }

  /**
   * Verifies a workload token. A JWKS that cannot be fetched or used is the
   * issuer's outage (503); every other verification failure refuses the token
   * with `refused`.
   */
  private async verify(token: string, refused: () => DomainProblem): Promise<JWTPayload> {
    if (!this.jwks || !this.environment.WORKLOAD_ISSUER_URL) {
      throw unavailable('Workload authentication is not configured');
    }
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.environment.WORKLOAD_ISSUER_URL,
      audience: this.environment.WORKLOAD_AUDIENCE,
      ...WORKLOAD_TOKEN_POLICY,
    }).catch((error: unknown) => {
      if (jwksUnavailable(error)) throw unavailable('Workload identity verification is temporarily unavailable');
      throw refused();
    });
    if (payload.token_use !== 'workload') throw refused();
    return payload;
  }

  private equal(candidate: string, expected: string): boolean {
    return timingSafeEqual(
      createHash('sha256').update(candidate).digest(),
      createHash('sha256').update(expected).digest(),
    );
  }

  private bearerToken(authorization: string | undefined, refused: () => DomainProblem): string {
    if (!authorization?.startsWith('Bearer ')) throw refused();
    const token = authorization.slice('Bearer '.length).trim();
    if (!token || token.length > MAX_WORKLOAD_TOKEN_LENGTH || /\s/.test(token)) throw refused();
    return token;
  }
}

export function isIdentityCaller(value: string | undefined): value is IdentityCaller {
  return value === 'ehr-api' || value === 'lab-api' || value === 'pharmacy-api'
    || value === 'ocr-api' || value === 'outreach-api';
}
