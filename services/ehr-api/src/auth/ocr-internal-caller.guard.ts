import { createHash, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { JWTVerifyGetKey, JWTVerifyOptions } from 'jose';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';

// The workload token contract (ADR-047): the issuer signs ES256 tokens with
// iat = nbf, exp = iat + 300 s and token_use 'workload'. A token without exp
// or iat, older than 300 s, issued in the future, signed with any other
// algorithm or meant for another use is refused. The 5 s clock tolerance
// matches the agent's own allowance for an iat ahead of its clock.
const WORKLOAD_TOKEN_POLICY = {
  algorithms: ['ES256'], requiredClaims: ['exp', 'iat'], maxTokenAge: 300, clockTolerance: 5,
} satisfies JWTVerifyOptions;

@Injectable()
export class OcrInternalCallerGuard implements CanActivate {
  private readonly environment = getEnvironment();
  // One key set per process, not per request: jose caches the JWKS for 10 minutes and refetches it
  // early only for an unknown kid.
  private jwks?: JWTVerifyGetKey;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HidRequest>();
    if (request.header('x-hid-internal-caller') !== 'ocr-api') {
      throw new DomainProblem(401, 'INTERNAL_SERVICE_AUTH_REQUIRED',
        'Authenticated OCR service identity is required');
    }
    if (this.environment.EHR_SERVICE_IDENTITY_MODE === 'local-secret') {
      if (!this.environment.EHR_INTERNAL_SERVICE_TOKEN
          || !this.equal(request.header('x-hid-service-token'), this.environment.EHR_INTERNAL_SERVICE_TOKEN)) {
        throw new DomainProblem(401, 'INTERNAL_SERVICE_AUTH_REQUIRED',
          'Authenticated OCR service identity is required');
      }
      return true;
    }
    await this.authenticateJwt(request.header('x-hid-service-authorization'));
    return true;
  }

  private async authenticateJwt(authorization: string | undefined): Promise<void> {
    const { EHR_WORKLOAD_ISSUER_URL: issuer, EHR_WORKLOAD_AUDIENCE: audience,
      EHR_WORKLOAD_JWKS_URL: jwksUrl, EHR_OCR_CALLER_SUBJECT: subject } = this.environment;
    if (!issuer || !audience || !jwksUrl || !subject) {
      throw new DomainProblem(503, 'WORKLOAD_IDENTITY_UNAVAILABLE',
        'EHR workload verification is unavailable');
    }
    if (!authorization?.startsWith('Bearer ')) {
      throw new DomainProblem(401, 'INTERNAL_SERVICE_AUTH_REQUIRED', 'Workload bearer token is required');
    }
    const token = authorization.slice(7).trim();
    if (token.length < 20 || token.length > 16_384 || /\s/.test(token)) {
      throw new DomainProblem(401, 'INVALID_WORKLOAD_IDENTITY', 'Workload identity is invalid or expired');
    }
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    const jwks = this.jwks ??= createRemoteJWKSet(new URL(jwksUrl));
    const { payload } = await jwtVerify(token, jwks, {
      issuer, audience, ...WORKLOAD_TOKEN_POLICY,
    }).catch(() => { throw new DomainProblem(401, 'INVALID_WORKLOAD_IDENTITY',
      'Workload identity is invalid or expired'); });
    if (payload.token_use !== 'workload') {
      throw new DomainProblem(401, 'INVALID_WORKLOAD_IDENTITY', 'Workload identity is invalid or expired');
    }
    if (payload.sub !== subject) {
      throw new DomainProblem(403, 'WORKLOAD_CALLER_DENIED',
        'Workload identity is not authorized for the OCR caller');
    }
  }

  private equal(candidate: string | undefined, expected: string): boolean {
    if (!candidate) return false;
    return timingSafeEqual(createHash('sha256').update(candidate).digest(),
      createHash('sha256').update(expected).digest());
  }
}
