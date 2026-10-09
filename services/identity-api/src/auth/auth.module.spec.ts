jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  SignJWT: class {
    setProtectedHeader() { return this; }
    setSubject() { return this; }
    setIssuer() { return this; }
    setAudience() { return this; }
    setJti() { return this; }
    setIssuedAt() { return this; }
    setExpirationTime() { return this; }
    async sign() { return 'signed-access-token'; }
  },
}));

import { MODULE_METADATA } from '@nestjs/common/constants';
import { AuthController } from './auth.controller';
import { AuthModule } from './auth.module';
import { GoogleAuthenticationService } from './google-authentication.service';

describe('AuthModule Google authentication wiring', () => {
  it('registers the Google authentication service with the auth controller module', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AuthModule) as readonly unknown[];
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AuthModule) as readonly unknown[];

    expect(providers).toContain(GoogleAuthenticationService);
    expect(controllers).toContain(AuthController);
  });
});
