jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { Logger } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import {
  OWN_PROFILE_STARTUP_ATTEMPTS, OWN_PROFILE_STARTUP_RETRY_MS, OWN_PROFILE_STARTUP_SQL, StaffProfileChangeStartupCheck,
} from './staff-profile-changes';
import { StaffProfileModule } from './staff-profile.module';

// SX-6 (0205): with STAFF_PASSWORD_CHANGE_ENABLED or STAFF_NAME_CHANGE_ENABLED true, Identity starts only on a
// definite answer that the runtime may execute the 0205 functions that setting needs, so a deploy made before 0205
// rolls back and the old tasks keep serving (OpenPatientStartupCheck's form).

type Row = { can_change_password: boolean | null; can_change_name: boolean | null; can_read_version: boolean | null };
const ALL: Row = { can_change_password: true, can_change_name: true, can_read_version: true };

describe('the start-up check of SX-6\'s settings (0205)', () => {
  const original = { ...process.env };
  let warn: jest.SpyInstance;
  let pause: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    pause = jest.spyOn(StaffProfileChangeStartupCheck.prototype as unknown as { pause: (ms: number) => Promise<void> },
      'pause').mockResolvedValue(undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    pause.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function environment(settings: Record<string, string>): void {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'http://localhost:5173', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
    delete process.env.STAFF_PASSWORD_CHANGE_ENABLED;
    delete process.env.STAFF_NAME_CHANGE_ENABLED;
    Object.assign(process.env, settings);
    resetEnvironmentForTests();
  }

  function check(...answers: (Row | Error)[]) {
    let call = 0;
    const query = jest.fn(async () => {
      const answer = answers[Math.min(call++, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return { rows: [answer] };
    });
    return { query, check: new StaffProfileChangeStartupCheck({ query } as unknown as DatabaseService) };
  }

  it('is part of StaffProfileModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StaffProfileModule)).toContain(StaffProfileChangeStartupCheck);
  });

  it('reads nothing with both settings off (the default) or set to false', async () => {
    for (const settings of [{}, { STAFF_PASSWORD_CHANGE_ENABLED: 'false', STAFF_NAME_CHANGE_ENABLED: 'false' }] as Record<string, string>[]) {
      environment(settings);
      const s = check({ can_change_password: null, can_change_name: null, can_read_version: null });
      await expect(s.check.onModuleInit()).resolves.toBeUndefined();
      expect(s.query).not.toHaveBeenCalled();
    }
  });

  it('refuses a setting that is not exactly true or false', () => {
    environment({ STAFF_NAME_CHANGE_ENABLED: 'yes' });
    expect(() => getEnvironment()).toThrow(/STAFF_NAME_CHANGE_ENABLED/);
    environment({ STAFF_PASSWORD_CHANGE_ENABLED: 'TRUE' });
    expect(() => getEnvironment()).toThrow(/STAFF_PASSWORD_CHANGE_ENABLED/);
  });

  it('starts when every function it needs is executable; asks each one by its exact signature', async () => {
    environment({ STAFF_PASSWORD_CHANGE_ENABLED: 'true', STAFF_NAME_CHANGE_ENABLED: 'true' });
    const s = check(ALL);
    await expect(s.check.onModuleInit()).resolves.toBeUndefined();
    expect(s.query).toHaveBeenCalledWith(OWN_PROFILE_STARTUP_SQL);
    expect(OWN_PROFILE_STARTUP_SQL).toContain(
      "to_regprocedure('auth.change_own_password(uuid,uuid,text,text,text,uuid,uuid,text,timestamp with time zone,inet,text)')");
    expect(OWN_PROFILE_STARTUP_SQL).toContain("to_regprocedure('auth.change_own_display_name(text,bigint,text,uuid,inet,text)')");
    expect(OWN_PROFILE_STARTUP_SQL).toContain("to_regprocedure('auth.own_profile_version()')");
  });

  it('the password setting refuses to start without EXECUTE on the password change (0205 missing)', async () => {
    environment({ STAFF_PASSWORD_CHANGE_ENABLED: 'true' });
    await expect(check({ ...ALL, can_change_password: null }).check.onModuleInit())
      .rejects.toThrow(/STAFF_PASSWORD_CHANGE_ENABLED is true, but the Identity runtime cannot execute auth\.change_own_password/);
    // The name functions are not its concern.
    await expect(check({ ...ALL, can_change_name: false, can_read_version: null }).check.onModuleInit()).resolves.toBeUndefined();
  });

  it('the name setting refuses to start without EXECUTE on the name edit or the profile version', async () => {
    environment({ STAFF_NAME_CHANGE_ENABLED: 'true' });
    await expect(check({ ...ALL, can_change_name: false }).check.onModuleInit()).rejects.toThrow(/STAFF_NAME_CHANGE_ENABLED is true/);
    await expect(check({ ...ALL, can_read_version: null }).check.onModuleInit()).rejects.toThrow(/STAFF_NAME_CHANGE_ENABLED is true/);
    await expect(check({ ...ALL, can_change_password: null }).check.onModuleInit()).resolves.toBeUndefined();
  });

  it('tries a failed read again, and refuses after the last attempt, logging no diagnostic', async () => {
    environment({ STAFF_NAME_CHANGE_ENABLED: 'true' });
    const failure = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432 secret detail'), { code: 'ECONNREFUSED' });
    const recovered = check(failure, failure, ALL);
    await expect(recovered.check.onModuleInit()).resolves.toBeUndefined();
    expect(recovered.query).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledWith(OWN_PROFILE_STARTUP_RETRY_MS);
    const down = check(failure);
    await expect(down.check.onModuleInit()).rejects.toThrow(/could not be read after 5 attempts/);
    expect(down.query).toHaveBeenCalledTimes(OWN_PROFILE_STARTUP_ATTEMPTS);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret detail');
  });
});
