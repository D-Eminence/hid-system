import { createHash, timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyOptions } from 'jose';
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
export class WorkloadAuthService {
  private readonly environment = getEnvironment();
  private readonly jwks = this.environment.WORKLOAD_JWKS_URL ? createRemoteJWKSet(new URL(this.environment.WORKLOAD_JWKS_URL)) : undefined;

  async authenticate(caller: string | undefined, authorization: string | undefined, localToken: string | undefined): Promise<string> {
    if (caller !== 'identity-api') throw new UnauthorizedException('Identity workload is required');
    if (this.environment.NOTIFICATION_WORKLOAD_IDENTITY_MODE === 'local-secret') {
      if (this.environment.NODE_ENV === 'production') throw new ServiceUnavailableException('Local workload authentication is disabled');
      const expected = this.environment.NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN;
      if (!expected || !localToken || !this.equal(expected, localToken)) throw new UnauthorizedException('Identity workload is required');
      return 'local:identity-api';
    }
    if (!this.jwks || !this.environment.WORKLOAD_ISSUER_URL || !this.environment.IDENTITY_CALLER_SUBJECT) throw new ServiceUnavailableException('Workload authentication is not configured');
    if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException('Workload bearer token is required');
    const token = authorization.slice(7).trim();
    if (!token || token.length > 16_384 || /\s/.test(token)) throw new UnauthorizedException('Invalid workload token');
    const { payload } = await jwtVerify(token, this.jwks, { issuer: this.environment.WORKLOAD_ISSUER_URL, audience: this.environment.WORKLOAD_AUDIENCE, ...WORKLOAD_TOKEN_POLICY })
      .catch(() => { throw new UnauthorizedException('Invalid workload token'); });
    if (payload.token_use !== 'workload') throw new UnauthorizedException('Invalid workload token');
    if (payload.sub !== this.environment.IDENTITY_CALLER_SUBJECT) throw new ForbiddenException('Workload subject is not authorized');
    return payload.sub;
  }

  private equal(first: string, second: string): boolean {
    return timingSafeEqual(createHash('sha256').update(first).digest(), createHash('sha256').update(second).digest());
  }
}
