import type { ActorContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';

/** Unit-test fixtures for platform sessions (Stage 2A). Excluded from the build. */
export const PLATFORM_SESSION_ID = '90000000-0000-4000-8000-0000000000f1';

export const SUPER_ADMIN_PERMISSIONS = [
  'platform.admin.access', 'platform.audit.read', 'platform.control.manage', 'platform.control.read',
  'platform.demo.manage', 'platform.demo.read', 'platform.facility.manage', 'platform.facility.read',
  'platform.identity-review.read', 'platform.integration.manage', 'platform.integration.read',
  'platform.integration.test', 'platform.mfa.reset', 'platform.operations.read', 'platform.pricing.manage',
  'platform.pricing.read', 'platform.principal.export', 'platform.principal.manage', 'platform.principal.read',
  'platform.role.manage', 'platform.session.revoke',
] as const;

export function platformActor(actor: Partial<ActorContext> = {}): ActorContext {
  return {
    kind: 'platform', id: 'synthetic:platform-admin', subject: 'synthetic:platform-admin',
    accountId: '20000000-0000-4000-8000-000000000001', sessionId: PLATFORM_SESSION_ID,
    roles: [], permissions: [], platformRoles: ['platform_super_admin'],
    platformPermissions: [...SUPER_ADMIN_PERMISSIONS], facilityIds: [], facilities: [],
    authenticationMethod: 'local', ...actor,
  };
}

/** True for the server-side assurance lookup in auth/platform-assurance.ts. */
export function isAssuranceQuery(sql: unknown): boolean {
  return typeof sql === 'string' && sql.includes('join auth.session_assurance assurance')
    && sql.includes('step_up_fresh');
}

export function assuranceResult(options: { stepUpFresh?: boolean; active?: boolean } = {}) {
  if (options.active === false) return { rows: [], rowCount: 0 };
  const now = Date.now();
  const stepUpFresh = options.stepUpFresh ?? true;
  return { rowCount: 1, rows: [{
    mfa_verified_at: new Date(now - 60_000), mfa_method: 'totp',
    step_up_at: stepUpFresh ? new Date(now - 10_000) : null, step_up_fresh: stepUpFresh,
    step_up_expires_at: stepUpFresh ? new Date(now + 290_000) : null,
    expires_at: new Date(now + 600_000), absolute_expires_at: new Date(now + 3_600_000),
  }] };
}

/**
 * A pg client mock whose assurance lookup answers as configured and whose
 * other queries go to `command`, which each test controls.
 */
export function assuredClient(command: jest.Mock, options: { stepUpFresh?: boolean; active?: boolean } = {}) {
  return {
    query: jest.fn(async (sql: unknown, parameters?: unknown[]) =>
      isAssuranceQuery(sql) ? assuranceResult(options) : command(sql, parameters)),
  };
}

/** Minimal valid local environment for specs that reach getEnvironment(). */
export function useTestEnvironment(overrides: Record<string, string> = {}): void {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://example@localhost/hid', CORS_ORIGINS: 'http://localhost:5173',
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: 'example-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'example-login-pepper-with-at-least-32-characters', ...overrides,
    });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    process.env = saved;
    resetEnvironmentForTests();
  });
}
