jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { Logger } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPEN_PATIENT_STARTUP_ATTEMPTS, OPEN_PATIENT_STARTUP_RETRY_MS, OpenPatientStartupCheck } from '../auth/open-patient';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { OpenPatientController } from './open-patient.controller';
import { OpenPatientModule } from './open-patient.module';
import { OpenPatientService } from './open-patient.service';

// With STAFF_OPEN_PATIENT_ENABLED=true, Identity starts only on a definite
// answer that auth.session_open_patient (0140), each of the four privileges
// the runtime needs on it, and EXECUTE on 0140's patient existence check are
// there, so a deploy made before 0140 rolls back and the old tasks keep
// serving. A read that fails is tried again; still none after the last try,
// it refuses too (Ola's review of #295, item 3).

type Row = { present: boolean | null; can_select: boolean | null; can_insert: boolean | null;
  can_update: boolean | null; can_delete: boolean | null; can_check_patient: boolean | null };
const ALL: Row = { present: true, can_select: true, can_insert: true, can_update: true, can_delete: true,
  can_check_patient: true };
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const normalized = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

describe('the start-up check of STAFF_OPEN_PATIENT_ENABLED (SX-8, 0140)', () => {
  const original = { ...process.env };
  let warn: jest.SpyInstance;
  let pause: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    pause = jest.spyOn(OpenPatientStartupCheck.prototype as unknown as { pause: (ms: number) => Promise<void> }, 'pause')
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
    if (value === undefined) delete process.env.STAFF_OPEN_PATIENT_ENABLED;
    else process.env.STAFF_OPEN_PATIENT_ENABLED = value;
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
    return { database, subject: new OpenPatientStartupCheck(database as unknown as DatabaseService) };
  }

  it.each([['unset', undefined], ['false', 'false']] as const)('%s: reads nothing and starts', async (_label, value) => {
    environment(value);
    const { database, subject } = check({ present: false, can_select: null, can_insert: null, can_update: null,
      can_delete: null, can_check_patient: null });
    await expect(subject.onModuleInit()).resolves.toBeUndefined();
    expect(database.query).not.toHaveBeenCalled();
  });

  it.each(['TRUE', '1', 'yes', 'on'])('refuses to boot on %s: only true or false', (value) => {
    environment(value);
    expect(() => getEnvironment()).toThrow();
  });

  it('true: starts when the table and each of its four privileges are there, asked separately', async () => {
    environment('true');
    const { database, subject } = check(ALL);
    await expect(subject.onModuleInit()).resolves.toBeUndefined();
    expect(database.query).toHaveBeenCalledTimes(1);
    const sql = normalized(database.query.mock.calls[0]![0]);
    expect(sql).toContain("to_regclass('auth.session_open_patient')");
    const calls = [...sql.matchAll(/has_table_privilege\(([^)]*)\)/g)].map(([, args]) => args!);
    expect(calls.map((args) => /'([A-Z, ]+)'$/.exec(args.trim())?.[1])).toEqual(PRIVILEGES);
    expect(sql).toContain("has_function_privilege(to_regprocedure('auth.session_open_patient_target_exists(uuid)')::oid, "
      + "'EXECUTE') as can_check_patient");
    expect(warn).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it('refuses to start when the table is missing (0140 not applied)', async () => {
    environment('true');
    const { subject } = check({ present: false, can_select: null, can_insert: null, can_update: null, can_delete: null,
      can_check_patient: null });
    await expect(subject.onModuleInit()).rejects.toThrow(/STAFF_OPEN_PATIENT_ENABLED.*auth\.session_open_patient.*0140/);
  });

  it.each(PRIVILEGES)('refuses to start when %s alone is missing, naming only it', async (privilege) => {
    environment('true');
    const column = `can_${privilege.toLowerCase()}` as keyof Row;
    const { subject } = check({ ...ALL, [column]: false });
    const failure = await subject.onModuleInit().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(new RegExp(`\\b${privilege}\\b`));
    expect((failure as Error).message).toContain('auth.session_open_patient');
    for (const other of PRIVILEGES.filter((name) => name !== privilege)) {
      expect((failure as Error).message).not.toMatch(new RegExp(`\\b${other}\\b`));
    }
  });

  it('refuses to start when it cannot execute the patient existence check (0140 D6)', async () => {
    environment('true');
    for (const value of [false, null]) {
      const { subject } = check({ ...ALL, can_check_patient: value });
      await expect(subject.onModuleInit()).rejects.toThrow(/auth\.session_open_patient_target_exists\(uuid\)/);
    }
  });

  it('tries an unreachable database again, then refuses to start, logging one event per try with no diagnostic',
    async () => {
      environment('true');
      const { database, subject } = check(Object.assign(
        new Error('password authentication failed for user "hid_identity_api_runtime"'), { code: '28P01' }));
      await expect(subject.onModuleInit()).rejects.toThrow(
        new RegExp(`could not be read after ${OPEN_PATIENT_STARTUP_ATTEMPTS} attempts`));
      expect(database.query).toHaveBeenCalledTimes(OPEN_PATIENT_STARTUP_ATTEMPTS);
      expect(pause).toHaveBeenCalledTimes(OPEN_PATIENT_STARTUP_ATTEMPTS - 1);
      for (const [milliseconds] of pause.mock.calls) expect(milliseconds).toBe(OPEN_PATIENT_STARTUP_RETRY_MS);
      expect(warn.mock.calls.map(([message]) => message)).toEqual(Array.from({ length: OPEN_PATIENT_STARTUP_ATTEMPTS },
        (_value, index) => ({ event: 'auth.open_patient.startup_check_unavailable', attempt: index + 1 })));
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/password|hid_identity_api_runtime|28P01/);
    });

  it('starts when a later try answers, and refuses when a later try finds the table missing', async () => {
    environment('true');
    const unreachable = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const reached = check(unreachable, unreachable, ALL);
    await expect(reached.subject.onModuleInit()).resolves.toBeUndefined();
    expect(reached.database.query).toHaveBeenCalledTimes(3);
    const missing = check(unreachable, { ...ALL, present: false, can_select: null, can_insert: null, can_update: null,
      can_delete: null, can_check_patient: null });
    await expect(missing.subject.onModuleInit()).rejects.toThrow(/does not exist/);
  });

  it('an empty answer is no answer: tried again, then refused', async () => {
    environment('true');
    const { database, subject } = check(undefined);
    await expect(subject.onModuleInit()).rejects.toThrow(/could not be read/);
    expect(database.query).toHaveBeenCalledTimes(OPEN_PATIENT_STARTUP_ATTEMPTS);
  });

  it('a privilege answered null is not a definite yes: refused, naming it', async () => {
    environment('true');
    const { subject } = check({ ...ALL, can_delete: null });
    await expect(subject.onModuleInit()).rejects.toThrow(/\bDELETE\b/);
  });

  it('stops the application from initialising when it refuses', async () => {
    environment('true');
    const database = { query: jest.fn(async () => ({ rows: [{ ...ALL, can_delete: false }], rowCount: 1 })) };
    const module = await Test.createTestingModule({ providers: [OpenPatientStartupCheck,
      { provide: DatabaseService, useValue: database }] }).compile();
    await expect(module.init()).rejects.toThrow(/DELETE/);
    await module.close().catch(() => undefined);
  });

  it('OpenPatientModule holds the check, the service and the controller, and AppModule imports it', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, OpenPatientModule)).toEqual(
      expect.arrayContaining([OpenPatientStartupCheck, OpenPatientService]));
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, OpenPatientModule)).toEqual([OpenPatientController]);
    // Read as text: importing AppModule here would build every module.
    const appModule = readFileSync(join(__dirname, '../app.module.ts'), 'utf8');
    expect(appModule).toMatch(/imports: \[[^\]]*\bOpenPatientModule\b[^\]]*\]/);
  });
});
