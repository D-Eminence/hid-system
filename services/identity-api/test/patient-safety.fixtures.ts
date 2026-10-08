import type { PoolClient } from 'pg';
import { resetEnvironmentForTests } from '../src/config/environment';
import type { HidRequest } from '../src/common/request-context';
import type { DatabaseService } from '../src/database/database.service';

/** Synthetic configuration for patient-safety unit tests; never real key material. */
export function usePatientSafetyTestEnvironment(overrides: Record<string, string> = {}): void {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      NIN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 3).toString('base64'),
      NIN_KEY_VERSION: 'test-v1',
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 5).toString('base64'),
      ...overrides,
    });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });
}

export const patientRequest = {
  correlationId: 'patient-safety-test-correlation',
  actor: {
    kind: 'patient', id: 'patient:safety', subject: 'patient:safety',
    accountId: '70000000-0000-4000-8000-000000000001',
    patientId: '50000000-0000-4000-8000-000000000001',
    sessionId: '80000000-0000-4000-8000-000000000001',
    roles: [], permissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local',
  },
} as unknown as HidRequest;

export const patientSession = ['patient:safety', '80000000-0000-4000-8000-000000000001'] as const;

export function fakeDatabase() {
  const query = jest.fn();
  const client = { query } as unknown as PoolClient;
  const withSystemTransaction = jest.fn(
    async (_correlationId: string, operation: (transactionClient: PoolClient) => Promise<unknown>) => operation(client),
  );
  const database = { withSystemTransaction } as unknown as DatabaseService;
  return { query, withSystemTransaction, database };
}
