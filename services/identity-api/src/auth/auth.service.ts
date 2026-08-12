import { Injectable, MethodNotAllowedException } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import type { LoginDto } from './dto/login.dto';
import { LocalAuthProvider } from './local-auth.provider';
import { TokenService, type SessionEventMetadata } from './token.service';
import type { LoginResult } from './auth.types';

@Injectable()
export class AuthService {
  private readonly environment = getEnvironment();

  constructor(
    private readonly localProvider: LocalAuthProvider,
    private readonly tokens: TokenService,
  ) {}

  async login(input: LoginDto, event: SessionEventMetadata): Promise<LoginResult> {
    if (this.environment.AUTH_MODE === 'oidc') {
      throw new MethodNotAllowedException('Password login is disabled; use the configured OIDC authorization flow');
    }
    const identity = await this.localProvider.authenticate(input.email, input.password);
    return this.tokens.issue(identity, {
      ...event,
      principalHmac: this.localProvider.principalHash(input.email),
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
