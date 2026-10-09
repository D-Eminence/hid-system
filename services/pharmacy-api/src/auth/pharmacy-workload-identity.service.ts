import { Injectable } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';

const MAX_WORKLOAD_TOKEN_LENGTH = 16_384;

@Injectable()
export class PharmacyWorkloadIdentityService {
  private readonly environment = getEnvironment();
  async authenticate(caller: 'ehr-api' | 'ocr-api', authorization: string | undefined): Promise<void> {
    if (this.environment.PHARMACY_SERVICE_IDENTITY_MODE === 'local-secret') return;
    if (!this.environment.PHARMACY_WORKLOAD_JWKS_URL || !this.environment.PHARMACY_WORKLOAD_ISSUER_URL
        || !this.environment.PHARMACY_WORKLOAD_AUDIENCE) {
      throw new DomainProblem(503, 'WORKLOAD_IDENTITY_UNAVAILABLE',
        'Pharmacy workload verification is unavailable');
    }
    if (!authorization?.startsWith('Bearer ')) throw new DomainProblem(401,
      'INTERNAL_SERVICE_AUTH_REQUIRED', 'Workload bearer token is required');
    const token = authorization.slice(7).trim();
    if (!token || token.length > MAX_WORKLOAD_TOKEN_LENGTH || /\s/.test(token)) {
      throw new DomainProblem(401, 'INVALID_WORKLOAD_IDENTITY',
        'Workload identity is invalid or expired');
    }
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    const jwks = createRemoteJWKSet(new URL(this.environment.PHARMACY_WORKLOAD_JWKS_URL));
    const expectedSubject = caller === 'ehr-api'
      ? this.environment.PHARMACY_EHR_CALLER_SUBJECT : this.environment.PHARMACY_OCR_CALLER_SUBJECT;
    const { payload } = await jwtVerify(token, jwks, {
      issuer: this.environment.PHARMACY_WORKLOAD_ISSUER_URL,
      audience: this.environment.PHARMACY_WORKLOAD_AUDIENCE,
      algorithms: ['RS256', 'ES256'],
    }).catch(() => { throw new DomainProblem(401, 'INVALID_WORKLOAD_IDENTITY',
      'Workload identity is invalid or expired'); });
    if (!expectedSubject || payload.sub !== expectedSubject) throw new DomainProblem(403,
      'WORKLOAD_CALLER_DENIED', 'Workload identity is not authorized for this caller');
  }

  async identityHeaders(): Promise<Readonly<Record<string, string>>> {
    if (this.environment.IDENTITY_SERVICE_IDENTITY_MODE === 'local-secret') {
      if (this.environment.NODE_ENV === 'production') throw new DomainProblem(503,
        'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE', 'Local Identity workload authentication is disabled in production');
      if (!this.environment.IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN) throw new DomainProblem(503,
        'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE', 'Pharmacy-to-Identity workload identity is not configured');
      return { 'x-hid-service-token': this.environment.IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN };
    }
    const path = this.environment.IDENTITY_PHARMACY_WORKLOAD_TOKEN_FILE;
    if (!path) throw new DomainProblem(503, 'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE',
      'Identity workload token source is not configured');
    return { 'x-hid-service-authorization': `Bearer ${await this.readToken(path)}` };
  }

  private async readToken(path: string): Promise<string> {
    const metadata = await stat(path).catch(() => { throw new DomainProblem(503,
      'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE', 'Identity workload token source is unavailable'); });
    if (!metadata.isFile() || metadata.size > 16_384) throw new DomainProblem(503,
      'IDENTITY_WORKLOAD_IDENTITY_INVALID', 'Identity workload token source is invalid');
    const token = (await readFile(path, 'utf8').catch(() => { throw new DomainProblem(503,
      'IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE', 'Identity workload token source is unavailable'); })).trim();
    if (token.length < 20 || token.length > 16_384 || /\s/.test(token)) throw new DomainProblem(503,
      'IDENTITY_WORKLOAD_IDENTITY_INVALID', 'Identity workload token source is invalid');
    return token;
  }
}
