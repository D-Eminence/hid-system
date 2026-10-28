import { Injectable, MethodNotAllowedException } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import type { LoginDto } from './dto/login.dto';
import type { PatientLoginDto } from './dto/patient-login.dto';
import { LocalAuthProvider } from './local-auth.provider';
import { loginPrincipalKey } from './patient-principal';
import { TokenService, type SessionEventMetadata } from './token.service';
import type { LoginResult } from './auth.types';

@Injectable()
export class AuthService {
  private readonly environment = getEnvironment();

  constructor(
    private readonly localProvider: LocalAuthProvider,
    private readonly tokens: TokenService,
  ) {}

  async login(input: LoginDto | PatientLoginDto, event: SessionEventMetadata, actorKind: 'staff' | 'patient' = 'staff'): Promise<LoginResult> {
    if (this.environment.AUTH_MODE === 'oidc') {
      throw new MethodNotAllowedException('Password login is disabled; use the configured OIDC authorization flow');
    }
    const identity = await this.localProvider.authenticate(input.email, input.password, actorKind,
      event.correlationId);
    return this.tokens.issue({ ...identity, actorKind }, {
      ...event,
      // The lockout's key: a phone's E.164 number, so 0803... and +234803...
      // share one lockout (owner decision of 2026-10-28).
      principalHmac: this.localProvider.principalHash(loginPrincipalKey(input.email, actorKind)),
      pepperVersion: this.environment.AUTH_LOGIN_PEPPER_VERSION,
    });
  }

  refresh(refreshToken: string, event: SessionEventMetadata): Promise<LoginResult> {
    return this.tokens.refresh(refreshToken, event);
  }

  revoke(
    sessionId: string | undefined,
    actorSubject: string | undefined,
    event: SessionEventMetadata,
  ): Promise<void> {
    return this.tokens.revoke(sessionId, actorSubject, event);
  }
}
