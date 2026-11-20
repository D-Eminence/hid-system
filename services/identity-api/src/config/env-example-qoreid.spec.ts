import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEnvironment, resetEnvironmentForTests } from './environment';

/**
 * A local setup copied from .env.example waits for QoreID as long as the code
 * does by default (Q118: 11 s; 0137: the answer read for 90 s), so a desk,
 * sign-up or profile check behaves locally as the contract describes.
 * Fictional values only.
 */
describe('.env.example QoreID waits', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('match the code defaults', () => {
    const example = readFileSync(join(__dirname, '..', '..', '.env.example'), 'utf8');
    const value = (name: string) => Number(new RegExp(`^${name}=(\\d+)$`, 'm').exec(example)?.[1]);
    for (const key of ['QOREID_TIMEOUT_MS', 'QOREID_NIN_ANSWER_CEILING_MS']) delete process.env[key];
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://app.fixture.invalid', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456' });
    resetEnvironmentForTests();
    expect(value('QOREID_TIMEOUT_MS')).toBe(getEnvironment().QOREID_TIMEOUT_MS);
    expect(value('QOREID_NIN_ANSWER_CEILING_MS')).toBe(getEnvironment().QOREID_NIN_ANSWER_CEILING_MS);
  });
});
