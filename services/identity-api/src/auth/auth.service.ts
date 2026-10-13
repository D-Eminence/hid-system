import { Injectable, MethodNotAllowedException } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import type { LoginDto } from './dto/login.dto';
import type { PatientLoginDto } from './dto/patient-login.dto';
import { LocalAuthProvider } from './local-auth.provider';
import { TokenService, type RefreshRotationHook, type SessionEventMetadata } from './token.service';
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
      principalHmac: this.localProvider.principalHash(input.email),
      pepperVersion: this.environment.AUTH_LOGIN_PEPPER_VERSION,
    });
  }

  /** `onRotated` runs inside the rotation's transaction (TokenService.refresh, A6). */
  refresh(refreshToken: string, event: SessionEventMetadata, onRotated?: RefreshRotationHook): Promise<LoginResult> {
    return this.tokens.refresh(refreshToken, event, 'standard', onRotated);
  }

  revoke(
    sessionId: string | undefined,
    actorSubject: string | undefined,
    event: SessionEventMetadata,
  ): Promise<boolean> {
    return this.tokens.revoke(sessionId, actorSubject, event);
  }

  revokeByRefreshToken(refreshToken: string, event: SessionEventMetadata, expectedKind?: 'staff' | 'patient') {
    return this.tokens.revokeByRefreshToken(refreshToken, event, expectedKind);
  }
}
