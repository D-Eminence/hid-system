import { resetEnvironmentForTests } from '../config/environment';

/**
 * The environment of a single sign-on test (ADR-070, 0125), set before each
 * test and restored after it: a local test environment with no single
 * sign-on settings, which a test may add to (overrides). From main's
 * testing/platform-assurance.ts useTestEnvironment, which production does not
 * have (no platform sessions).
 */
export function useTestEnvironment(overrides: Record<string, string> = {}): void {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://example@localhost/hid', CORS_ORIGINS: 'http://localhost:5173',
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: 'example-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'example-login-pepper-with-at-least-32-characters', ...overrides,
    });
    for (const name of ['AUTH_SSO_ISSUER', 'AUTH_SSO_INTERNAL_BASE_URL', 'AUTH_SSO_CLIENTS', 'AUTH_SSO_CLIENT_CREDENTIALS']) {
      if (!(name in overrides)) delete process.env[name];
    }
    resetEnvironmentForTests();
  });
  afterEach(() => {
    process.env = saved;
    resetEnvironmentForTests();
  });
}
