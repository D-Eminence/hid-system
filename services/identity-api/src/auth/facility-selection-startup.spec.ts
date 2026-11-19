jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { Logger } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from './auth.module';
import { FacilitySelectionStartupCheck } from './facility-selection';

// With STAFF_FACILITY_SELECTION_MODE on (keep or ask), Identity refuses to
// start while auth.session_facility_selection (0129) or any one of the three
// privileges the runtime needs on it is missing, so a deploy made before 0129
// rolls back and the old tasks keep serving. It refuses only on a definite
// false: a database it cannot reach at boot is left to GET /health/ready.

type Row = { present: boolean | null; can_select: boolean | null; can_insert: boolean | null; can_update: boolean | null };
const ALL: Row = { present: true, can_select: true, can_insert: true, can_update: true };
const normalized = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

describe('the start-up check of STAFF_FACILITY_SELECTION_MODE (0129)', () => {
  const original = { ...process.env };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function environment(mode: string | undefined): void {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'http://localhost:5173', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
    if (mode === undefined) delete process.env.STAFF_FACILITY_SELECTION_MODE;
    else process.env.STAFF_FACILITY_SELECTION_MODE = mode;
    resetEnvironmentForTests();
  }

  function check(answer: Row | undefined | Error) {
    const database = { query: jest.fn(async (_sql: string) => {
      if (answer instanceof Error) throw answer;
      return { rows: answer ? [answer] : [], rowCount: answer ? 1 : 0 };
    }) };
    return { database, subject: new FacilitySelectionStartupCheck(database as unknown as DatabaseService) };
  }

  it.each([['unset', undefined], ['off', 'off']] as const)('%s: reads nothing and starts', async (_label, mode) => {
    environment(mode);
    const { database, subject } = check({ present: false, can_select: null, can_insert: null, can_update: null });

    await expect(subject.onModuleInit()).resolves.toBeUndefined();
    expect(database.query).not.toHaveBeenCalled();
  });

  it.each(['keep', 'ask'])('%s: starts when the table and each of its three privileges are there', async (mode) => {
    environment(mode);
    const { database, subject } = check(ALL);

    await expect(subject.onModuleInit()).resolves.toBeUndefined();

    expect(database.query).toHaveBeenCalledTimes(1);
    const sql = normalized(database.query.mock.calls[0]![0]);
    expect(sql).toContain("to_regclass('auth.session_facility_selection')");
    // Three separate calls: has_table_privilege(t, 'SELECT,INSERT,UPDATE') is
    // true when ANY of them is held, so it cannot find a missing one.
    const calls = [...sql.matchAll(/has_table_privilege\(([^)]*)\)/g)].map(([, args]) => args!);
    expect(calls).toHaveLength(3);
    expect(calls.map((args) => /'([A-Z, ]+)'$/.exec(args.trim())?.[1])).toEqual(['SELECT', 'INSERT', 'UPDATE']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses to start when the table is missing (0129 not applied)', async () => {
    environment('keep');
    const { subject } = check({ present: false, can_select: null, can_insert: null, can_update: null });

    await expect(subject.onModuleInit()).rejects.toThrow(/STAFF_FACILITY_SELECTION_MODE.*auth\.session_facility_selection.*0129/);
  });

  it.each([
    ['SELECT', { ...ALL, can_select: false }],
    ['INSERT', { ...ALL, can_insert: false }],
    ['UPDATE', { ...ALL, can_update: false }],
  ] as const)('refuses to start when %s alone is missing', async (privilege, row) => {
    environment('ask');
    const { subject } = check(row);

    const failure = await subject.onModuleInit().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(new RegExp(`\\b${privilege}\\b`));
    expect((failure as Error).message).toContain('auth.session_facility_selection');
    for (const other of ['SELECT', 'INSERT', 'UPDATE'].filter((name) => name !== privilege)) {
      expect((failure as Error).message).not.toMatch(new RegExp(`\\b${other}\\b`));
    }
  });

  it('does not refuse when the database cannot be reached at boot: readiness decides, and one event is logged', async () => {
    environment('keep');
    const failure = Object.assign(new Error('password authentication failed for user "hid_identity_api_runtime"'),
      { code: '28P01' });
    const { subject } = check(failure);

    await expect(subject.onModuleInit()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toEqual({ event: 'auth.facility_selection.startup_check_unavailable' });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/password|hid_identity_api_runtime|28P01/);
  });

  it('does not refuse on an answer that is not a definite false', async () => {
    environment('keep');
    for (const answer of [undefined, { present: true, can_select: null, can_insert: true, can_update: true }]) {
      const { subject } = check(answer);
      await expect(subject.onModuleInit()).resolves.toBeUndefined();
    }
  });

  it('stops the application from initialising when it refuses', async () => {
    environment('keep');
    const database = { query: jest.fn(async () => ({ rows: [{ ...ALL, can_update: false }], rowCount: 1 })) };
    const module = await Test.createTestingModule({ providers: [FacilitySelectionStartupCheck,
      { provide: DatabaseService, useValue: database }] }).compile();

    await expect(module.init()).rejects.toThrow(/UPDATE/);
    await module.close().catch(() => undefined);
  });

  it('is one of AuthModule\'s providers', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AuthModule) as readonly unknown[];
    expect(providers).toContain(FacilitySelectionStartupCheck);
  });
});
