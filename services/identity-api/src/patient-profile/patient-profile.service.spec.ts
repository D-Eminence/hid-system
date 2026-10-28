import { createCipheriv, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { PatientProfileCrypto } from './patient-profile-crypto';
import { PatientProfileService, profileDetailText } from './patient-profile.service';
import { syntheticJpeg } from '../../test/profile-photo.fixtures';

const originalEnvironment = { ...process.env };
const request = { actor: { kind: 'patient', patientId: 'patient-id', accountId: 'account-id', subject: 'patient-subject',
  sessionId: 'session-id' }, correlationId: 'profile-request', ip: '203.0.113.4', header: () => undefined } as unknown as HidRequest;

beforeEach(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    NIN_ENCRYPTION_KEY_B64: randomBytes(32).toString('base64'), NIN_KEY_VERSION: 'nin-v7',
    OTP_HMAC_KEY_B64: randomBytes(32).toString('base64'),
  });
  resetEnvironmentForTests();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  resetEnvironmentForTests();
});

function setup(handlers: Record<string, (values: unknown[]) => { rows: unknown[] }>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    for (const [needle, handler] of Object.entries(handlers)) if (sql.includes(needle)) return handler(values);
    return { rows: [] };
  });
  const database = { withSystemTransaction: jest.fn(async (_id: string, work: (c: PoolClient) => Promise<unknown>) =>
    work({ query } as unknown as PoolClient)) } as unknown as DatabaseService;
  const record = jest.fn().mockResolvedValue(undefined);
  const crypto = new PatientProfileCrypto();
  return { service: new PatientProfileService(database, { recordWithClient: record } as unknown as AuditService, crypto),
    calls, record, crypto };
}

async function problem(promise: Promise<unknown>): Promise<DomainProblem> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return error;
    throw error;
  }
  throw new Error('No problem was raised');
}

function signupProfile(enrollmentId: string, json: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(process.env.NIN_ENCRYPTION_KEY_B64!, 'base64'), nonce);
  cipher.setAAD(Buffer.from(`identity:public-patient-enrollment:${enrollmentId}:profile`));
  return Buffer.concat([Buffer.from([1]), nonce, cipher.update(json, 'utf8'), cipher.final(), cipher.getAuthTag()]);
}

describe('PatientProfileService (0094)', () => {
  it('answers saved details, and audits the read', async () => {
    const s = setup({ 'read_my_profile_details': () => ({ rows: [{ hospital_currently_using: 'Lagos General',
      hmo_name: 'Hygeia', row_version: '3', saved: true }] }) });
    await expect(s.service.details(request)).resolves.toEqual({ hospitalCurrentlyUsing: 'Lagos General',
      hmoName: 'Hygeia', rowVersion: 3 });
    expect(s.calls.some((call) => call.sql.includes('public_patient_enrollments'))).toBe(false);
    expect(s.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'identity.patient.self.profile-details', patientId: 'patient-id', outcome: 'success' }));
  });

  it('before the first save, answers the hospital the sign-up declared (rowVersion 0)', async () => {
    const profile = signupProfile('enrollment-1', JSON.stringify({ kind: 'signup', firstName: 'Ada',
      hospitalCurrentlyUsing: 'Reddington Hospital' }));
    const s = setup({
      'read_my_profile_details': () => ({ rows: [{ hospital_currently_using: null, hmo_name: null, row_version: '0',
        saved: false }] }),
      'public_patient_enrollments': () => ({ rows: [{ id: 'enrollment-1', key_version: 'nin-v7', nin_route: false,
        profile_ciphertext: profile }] }),
    });
    await expect(s.service.details(request)).resolves.toEqual({ hospitalCurrentlyUsing: 'Reddington Hospital',
      hmoName: null, rowVersion: 0 });
    const none = setup({ 'read_my_profile_details': () => ({ rows: [{ hospital_currently_using: null, hmo_name: null,
      row_version: '0', saved: false }] }) });
    await expect(none.service.details(request)).resolves.toEqual({ hospitalCurrentlyUsing: null, hmoName: null,
      rowVersion: 0 });
    const denied = await problem(setup({}).service.details(request));
    expect([denied.getStatus(), denied.code]).toEqual([403, 'PATIENT_ACCESS_DENIED']);
  });

  it('saves trimmed values (blank is null) with the expected version, and answers 409 on a stale one', async () => {
    const s = setup({ 'save_my_profile_details': (values) => ({ rows: [{ outcome: 'saved',
      hospital_currently_using: values[3], hmo_name: values[4], row_version: '1' }] }) });
    await expect(s.service.saveDetails(request, { hospitalCurrentlyUsing: '  Lagos General ', hmoName: '   ',
      expectedVersion: 0 })).resolves.toEqual({ hospitalCurrentlyUsing: 'Lagos General', hmoName: null, rowVersion: 1 });
    expect(s.calls.find((call) => call.sql.includes('save_my_profile_details'))?.values)
      .toEqual(['patient-subject', 'session-id', 0, 'Lagos General', null]);
    const stale = setup({ 'save_my_profile_details': () => ({ rows: [{ outcome: 'conflict',
      hospital_currently_using: 'Other', hmo_name: null, row_version: '4' }] }) });
    const conflict = await problem(stale.service.saveDetails(request, { hospitalCurrentlyUsing: 'X', hmoName: null,
      expectedVersion: 2 }));
    expect([conflict.getStatus(), conflict.code]).toEqual([409, 'VERSION_CONFLICT']);
  });

  it('refuses more than 120 characters and control characters', () => {
    expect(profileDetailText('a'.repeat(120), 'hmoName')).toHaveLength(120);
    for (const value of ['a'.repeat(121), 'Line\nbreak', 'Tab\there', 'Bell\u0007', 42]) {
      expect(() => profileDetailText(value, 'hmoName')).toThrow('at most 120 characters');
    }
    expect(profileDetailText(undefined, 'hmoName')).toBeNull();
  });

  it('stores the photo encrypted with its checks, serves it back, and removes it', async () => {
    let stored: unknown[] = [];
    const s = setup({
      'set_my_profile_photo': (values) => { stored = values; return { rows: [{ saved: true }] }; },
      'read_my_profile_photo': () => ({ rows: [{ ciphertext: stored[2], media_type: stored[3], sha256: stored[4],
        key_version: stored[8] }] }),
    });
    const jpeg = syntheticJpeg(512, 512);
    await expect(s.service.savePhoto(request, { mediaType: 'image/jpeg', data: jpeg.toString('base64') }))
      .resolves.toEqual({ hasPhoto: true });
    expect(stored.slice(3)).toEqual(['image/jpeg', expect.stringMatching(/^[0-9a-f]{64}$/), jpeg.length, 512, 512, 'nin-v7']);
    expect((stored[2] as Buffer).includes(jpeg.subarray(0, 64))).toBe(false);
    await expect(s.service.photo(request)).resolves.toEqual({ mediaType: 'image/jpeg', bytes: jpeg });
    await expect(s.service.removePhoto(request)).resolves.toEqual({ hasPhoto: false });
    expect(s.calls.some((call) => call.sql.includes('remove_my_profile_photo'))).toBe(true);
    const invalid = await problem(s.service.savePhoto(request, { mediaType: 'image/png', data: jpeg.toString('base64') }));
    expect([invalid.getStatus(), invalid.code]).toEqual([400, 'PHOTO_INVALID']);
    const missing = await problem(setup({}).service.photo(request));
    expect([missing.getStatus(), missing.code]).toEqual([404, 'PHOTO_NOT_FOUND']);
  });

  it('answers 403 when the session-bound command refuses the session', async () => {
    const s = setup({ 'set_my_profile_photo': () => { throw Object.assign(new Error('denied'), { code: '42501' }); } });
    const denied = await problem(s.service.savePhoto(request, { mediaType: 'image/jpeg',
      data: syntheticJpeg(512, 512).toString('base64') }));
    expect([denied.getStatus(), denied.code]).toEqual([403, 'PATIENT_ACCESS_DENIED']);
  });
});
