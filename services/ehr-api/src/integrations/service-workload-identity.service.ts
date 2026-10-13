import { readFile, stat } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';

export type ClinicalService = 'lab' | 'pharmacy';

/**
 * True only for a JWT whose payload carries an `exp` that has passed. The
 * token is not verified here; Identity verifies it. Anything that does not
 * parse is left for Identity to judge.
 */
function workloadTokenExpired(token: string, now: number): boolean {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown } | null;
    return typeof claims?.exp === 'number' && Number.isFinite(claims.exp) && claims.exp * 1000 <= now;
  } catch {
    return false;
  }
}

@Injectable()
export class ServiceWorkloadIdentityService {
  private readonly logger = new Logger(ServiceWorkloadIdentityService.name);
  private expiredTokens = 0;

  /**
   * Identity calls this process refused because the Identity workload token
   * file held an expired token: the token agent stopped renewing it (ADR-047
   * D2). Each is also logged, without the token, as
   * `identity_workload_token_expired`.
   */
  get expiredTokenRefusals(): number {
    return this.expiredTokens;
  }

  async authorization(service: ClinicalService): Promise<string> {
    const environment = getEnvironment();
    const mode = service === 'lab'
      ? environment.LAB_SERVICE_IDENTITY_MODE
      : environment.PHARMACY_SERVICE_IDENTITY_MODE;
    if (mode !== 'jwt') {
      throw new DomainProblem(
        503,
        'SERVICE_WORKLOAD_IDENTITY_UNAVAILABLE',
        'JWT workload identity is not enabled for the target service',
      );
    }
    const path = service === 'lab'
      ? environment.LAB_EHR_WORKLOAD_TOKEN_FILE
      : environment.PHARMACY_EHR_WORKLOAD_TOKEN_FILE;
    if (!path) {
      throw new DomainProblem(
        503,
        'SERVICE_WORKLOAD_IDENTITY_UNAVAILABLE',
        'Workload token source is not configured',
      );
    }
    return `Bearer ${await this.readToken(path)}`;
  }

  async identityHeaders(): Promise<Readonly<Record<string, string>>> {
    const environment = getEnvironment();
    if (environment.IDENTITY_SERVICE_IDENTITY_MODE === 'local-secret') {
      if (environment.NODE_ENV === 'production') {
        throw new DomainProblem(
          503,
          'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE',
          'Local Identity workload authentication is disabled in production',
        );
      }
      if (!environment.IDENTITY_EHR_INTERNAL_SERVICE_TOKEN) {
        throw new DomainProblem(
          503,
          'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE',
          'Identity workload identity is not configured',
        );
      }
      return { 'x-hid-service-token': environment.IDENTITY_EHR_INTERNAL_SERVICE_TOKEN };
    }
    if (!environment.IDENTITY_EHR_WORKLOAD_TOKEN_FILE) {
      throw new DomainProblem(
        503,
        'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE',
        'Identity workload token source is not configured',
      );
    }
    const token = await this.readToken(environment.IDENTITY_EHR_WORKLOAD_TOKEN_FILE);
    // An expired token is refused here rather than sent: Identity would refuse
    // it 401, and the request fails as the outage it is (A5).
    if (workloadTokenExpired(token, Date.now())) {
      this.expiredTokens += 1;
      this.logger.warn({ event: 'identity_workload_token_expired', refusals: this.expiredTokens });
      throw new DomainProblem(
        503,
        'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE',
        'The Identity workload token has expired',
      );
    }
    return { 'x-hid-service-authorization': `Bearer ${token}` };
  }

  private async readToken(path: string): Promise<string> {
    const metadata = await stat(path).catch(() => {
      throw new DomainProblem(
        503,
        'SERVICE_WORKLOAD_IDENTITY_UNAVAILABLE',
        'Workload token source is unavailable',
      );
    });
    if (!metadata.isFile() || metadata.size > 16_384) {
      throw new DomainProblem(
        503,
        'SERVICE_WORKLOAD_IDENTITY_INVALID',
        'Workload token source is invalid',
      );
    }
    const token = await readFile(path, { encoding: 'utf8' }).catch(() => {
      throw new DomainProblem(
        503,
        'SERVICE_WORKLOAD_IDENTITY_UNAVAILABLE',
        'Workload token source is unavailable',
      );
    });
    const normalized = token.trim();
    if (normalized.length < 20 || normalized.length > 16_384 || /\s/.test(normalized)) {
      throw new DomainProblem(
        503,
        'SERVICE_WORKLOAD_IDENTITY_INVALID',
        'Workload token source is invalid',
      );
    }
    return normalized;
  }
}
