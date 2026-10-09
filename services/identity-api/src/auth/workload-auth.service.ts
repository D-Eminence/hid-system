import { createHash, timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getEnvironment, type Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

export type IdentityCaller = 'ehr-api' | 'lab-api' | 'pharmacy-api' | 'ocr-api' | 'outreach-api';

export interface WorkloadActor {
  subject: string;
  accountId: string;
}

const MAX_WORKLOAD_TOKEN_LENGTH = 16_384;

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

@Injectable()
export class WorkloadAuthService {
  private readonly environment = getEnvironment();
  private readonly jwks = this.environment.WORKLOAD_JWKS_URL
    ? createRemoteJWKSet(new URL(this.environment.WORKLOAD_JWKS_URL)) : undefined;

  constructor(private readonly database: DatabaseService) {}

  async authenticateScanner(authorization: string | undefined): Promise<WorkloadActor> {
    if (!this.jwks || !this.environment.WORKLOAD_ISSUER_URL) {
      throw new ServiceUnavailableException('Workload authentication is not configured');
    }
    const token = this.bearerToken(authorization);
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.environment.WORKLOAD_ISSUER_URL,
      audience: this.environment.WORKLOAD_AUDIENCE,
      algorithms: ['RS256', 'ES256'],
    }).catch(() => { throw new UnauthorizedException('Invalid workload token'); });
    if (!payload.sub) throw new UnauthorizedException('Workload token subject is missing');
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
    if (!accountId) throw new UnauthorizedException('Workload is not authorized as a document scanner');
    return { subject: payload.sub, accountId };
  }

  async authenticateService(
    callerValue: string | undefined,
    authorization: string | undefined,
    localToken: string | undefined,
  ): Promise<WorkloadActor> {
    if (!isIdentityCaller(callerValue)) throw new UnauthorizedException('Approved workload identity is required');
    if (this.environment.IDENTITY_SERVICE_IDENTITY_MODE === 'local-secret') {
      if (this.environment.NODE_ENV === 'production') {
        throw new ServiceUnavailableException('Local workload authentication is disabled in production');
      }
      const expected = this.environment[LOCAL_TOKEN_KEYS[callerValue]];
      if (typeof expected !== 'string' || !localToken || !this.equal(localToken, expected)) {
        throw new UnauthorizedException('Approved workload identity is required');
      }
      return { subject: `local:${callerValue}`, accountId: `local:${callerValue}` };
    }
    if (!this.jwks || !this.environment.WORKLOAD_ISSUER_URL) {
      throw new ServiceUnavailableException('Workload authentication is not configured');
    }
    const token = this.bearerToken(authorization);
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.environment.WORKLOAD_ISSUER_URL,
      audience: this.environment.WORKLOAD_AUDIENCE,
      algorithms: ['RS256', 'ES256'],
    }).catch(() => { throw new UnauthorizedException('Invalid workload token'); });
    const expectedSubject = this.environment[SUBJECT_KEYS[callerValue]];
    if (typeof expectedSubject !== 'string' || payload.sub !== expectedSubject) {
      throw new ForbiddenException('Workload caller subject is not authorized');
    }
    return { subject: payload.sub, accountId: payload.sub };
  }

  authenticateOutreach(
    caller: string | undefined,
    authorization: string | undefined,
    localToken: string | undefined,
  ): Promise<WorkloadActor> {
    if (caller !== 'outreach-api') return Promise.reject(new UnauthorizedException('Outreach workload identity is required'));
    return this.authenticateService(caller, authorization, localToken);
  }

  private equal(candidate: string, expected: string): boolean {
    return timingSafeEqual(
      createHash('sha256').update(candidate).digest(),
      createHash('sha256').update(expected).digest(),
    );
  }

  private bearerToken(authorization: string | undefined): string {
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Workload bearer token is required');
    }
    const token = authorization.slice('Bearer '.length).trim();
    if (!token || token.length > MAX_WORKLOAD_TOKEN_LENGTH || /\s/.test(token)) {
      throw new UnauthorizedException('Invalid workload token');
    }
    return token;
  }
}

export function isIdentityCaller(value: string | undefined): value is IdentityCaller {
  return value === 'ehr-api' || value === 'lab-api' || value === 'pharmacy-api'
    || value === 'ocr-api' || value === 'outreach-api';
}
