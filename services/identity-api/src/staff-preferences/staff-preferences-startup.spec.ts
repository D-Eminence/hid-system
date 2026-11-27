jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { Logger } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import {
  STAFF_PREFERENCES_FUNCTIONS, STAFF_PREFERENCES_STARTUP_ATTEMPTS, STAFF_PREFERENCES_STARTUP_RETRY_MS,
  StaffPreferencesStartupCheck,
} from './staff-preferences';
import { StaffPreferencesController } from './staff-preferences.controller';
import { StaffPreferencesModule } from './staff-preferences.module';
import { StaffPreferencesService } from './staff-preferences.service';

// With STAFF_PREFERENCES_ENABLED=true, Identity starts only on a definite
// answer that it may execute each of 0206's three functions, so a deploy made
// before 0206 (or before its grants) rolls back and the old tasks keep serving.

type Row = Record<string, boolean | null>;
const ALL: Row = { function_0: true, function_1: true, function_2: true };

describe('the start-up check of STAFF_PREFERENCES_ENABLED (SX-7, 0206)', () => {
  const original = { ...process.env };
  let warn: jest.SpyInstance;
  let pause: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    pause = jest.spyOn(StaffPreferencesStartupCheck.prototype as unknown as { pause: (ms: number) => Promise<void> }, 'pause')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    pause.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function environment(value: string | undefined): void {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'http://localhost:5173', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
    if (value === undefined) delete process.env.STAFF_PREFERENCES_ENABLED;
    else process.env.STAFF_PREFERENCES_ENABLED = value;
    resetEnvironmentForTests();
  }

  function check(answer: Row | undefined | Error, ...later: (Row | undefined | Error)[]) {
    const answers = [answer, ...later];
    let call = 0;
    const database = { query: jest.fn(async (_sql: string) => {
      const next = answers[Math.min(call, answers.length - 1)];
      call += 1;
      if (next instanceof Error) throw next;
      return { rows: next ? [next] : [], rowCount: next ? 1 : 0 };
    }) };
    return { database, subject: new StaffPreferencesStartupCheck(database as unknown as DatabaseService) };
  }

  it.each([['unset', undefined], ['false', 'false']] as const)('%s: off, reads nothing and starts', async (_label, value) => {
    environment(value);
    expect(getEnvironment().STAFF_PREFERENCES_ENABLED).toBe(false);
    const { database, subject } = check({ function_0: null, function_1: null, function_2: null });
    await expect(subject.onModuleInit()).resolves.toBeUndefined();
    expect(database.query).not.toHaveBeenCalled();
  });

  it.each(['TRUE', '1', 'yes', 'on', ''])('refuses to boot on %j: only true or false', (value) => {
    environment(value);
    expect(() => getEnvironment()).toThrow();
  });

  it('true: starts when the runtime may execute each of the three functions, asked separately', async () => {
    environment('true');
    expect(getEnvironment().STAFF_PREFERENCES_ENABLED).toBe(true);
    const { database, subject } = check(ALL);
    await expect(subject.onModuleInit()).resolves.toBeUndefined();
    expect(database.query).toHaveBeenCalledTimes(1);
    const sql = String(database.query.mock.calls[0]![0]);
    expect([...sql.matchAll(/has_function_privilege\(to_regprocedure\('([^']+)'\)::oid, 'EXECUTE'\) as function_(\d)/g)]
      .map(([, signature, index]) => `${index} ${signature}`)).toEqual([
      '0 identity.read_my_staff_preferences()',
      '1 identity.save_my_staff_preferences(text,bigint,text,text)',
      '2 identity.save_my_staff_shortcuts(text[],bigint,text,text)',
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(STAFF_PREFERENCES_FUNCTIONS.map((signature, index) => [signature, index] as const))(
    'refuses to start when %s is missing or not granted, naming only it', async (signature, index) => {
      environment('true');
      for (const value of [false, null]) {
        const { subject } = check({ ...ALL, [`function_${index}`]: value });
        const failure = await subject.onModuleInit().then(() => undefined, (error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain(signature);
        expect((failure as Error).message).toContain('0206');
        for (const other of STAFF_PREFERENCES_FUNCTIONS.filter((name) => name !== signature)) {
          expect((failure as Error).message).not.toContain(other);
        }
      }
    });

  it('tries an unreachable database again, then refuses to start, logging one event per try with no diagnostic', async () => {
    environment('true');
    const { database, subject } = check(Object.assign(
      new Error('password authentication failed for user "hid_identity_api_runtime"'), { code: '28P01' }));
    await expect(subject.onModuleInit()).rejects.toThrow(
      new RegExp(`could not be read after ${STAFF_PREFERENCES_STARTUP_ATTEMPTS} attempts`));
    expect(database.query).toHaveBeenCalledTimes(STAFF_PREFERENCES_STARTUP_ATTEMPTS);
    expect(pause).toHaveBeenCalledTimes(STAFF_PREFERENCES_STARTUP_ATTEMPTS - 1);
    for (const [milliseconds] of pause.mock.calls) expect(milliseconds).toBe(STAFF_PREFERENCES_STARTUP_RETRY_MS);
    expect(warn.mock.calls.map(([message]) => message)).toEqual(Array.from({ length: STAFF_PREFERENCES_STARTUP_ATTEMPTS },
      (_value, index) => ({ event: 'identity.staff_preferences.startup_check_unavailable', attempt: index + 1 })));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/password|hid_identity_api_runtime|28P01/);
  });

  it('starts when a later try answers; an empty answer is no answer', async () => {
    environment('true');
    const unreachable = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const reached = check(unreachable, ALL);
    await expect(reached.subject.onModuleInit()).resolves.toBeUndefined();
    expect(reached.database.query).toHaveBeenCalledTimes(2);
    const empty = check(undefined);
    await expect(empty.subject.onModuleInit()).rejects.toThrow(/could not be read/);
  });

  it('stops the application from initialising when it refuses', async () => {
    environment('true');
    const database = { query: jest.fn(async () => ({ rows: [{ ...ALL, function_2: false }], rowCount: 1 })) };
    const module = await Test.createTestingModule({ providers: [StaffPreferencesStartupCheck,
      { provide: DatabaseService, useValue: database }] }).compile();
    await expect(module.init()).rejects.toThrow(/save_my_staff_shortcuts/);
    await module.close().catch(() => undefined);
  });

  it('.env.example documents the setting, off, as the code\'s default', () => {
    const example = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
    expect(/^STAFF_PREFERENCES_ENABLED=(.*)$/m.exec(example)?.[1]).toBe('false');
    expect(example).toMatch(/# A staff member's own language and Home shortcuts \(SX-7, 0206\)\.[^]*?STAFF_PREFERENCES_ENABLED=false/);
    environment(undefined);
    expect(getEnvironment().STAFF_PREFERENCES_ENABLED).toBe(false);
  });

  it('StaffPreferencesModule holds the check, the service and the controller, and AppModule imports it', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StaffPreferencesModule)).toEqual(
      expect.arrayContaining([StaffPreferencesStartupCheck, StaffPreferencesService]));
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, StaffPreferencesModule)).toEqual([StaffPreferencesController]);
    const appModule = readFileSync(join(__dirname, '../app.module.ts'), 'utf8');
    expect(appModule).toMatch(/imports: \[[^\]]*\bStaffPreferencesModule\b[^\]]*\]/);
  });
});
