import { createCipheriv, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { resetEnvironmentForTests } from '../config/environment';
import { PatientContactReader } from './patient-contact-reader';
import { PatientProfileCrypto } from './patient-profile-crypto';

const originalEnvironment = { ...process.env };
const actor = { subject: 'patient-subject', sessionId: 'session-id', patientId: 'patient-id' };

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

function client(contact: Record<string, unknown> | undefined, enrollments: Array<Record<string, unknown>> = []) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('identity.patient_self_contact')) return { rows: contact ? [contact] : [] };
    if (sql.includes('identity.public_patient_enrollments')) return { rows: enrollments };
    return { rows: [] };
  });
  return { query, client: { query } as unknown as PoolClient };
}

function contactRow(extra: Record<string, unknown>) {
  return { email: 'pat@example.invalid', email_verified: true, phone_ciphertext: null, phone_lookup_hmac: null,
    phone_change_id: null, phone_change_key_version: null, has_photo: false, ...extra };
}

/** What sign-up stored: the NIN key and AAD identity:public-patient-enrollment:<id>:<purpose>. */
function enrollmentCiphertext(id: string, purpose: string, value: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(process.env.NIN_ENCRYPTION_KEY_B64!, 'base64'), nonce);
  cipher.setAAD(Buffer.from(`identity:public-patient-enrollment:${id}:${purpose}`));
  return Buffer.concat([Buffer.from([1]), nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
}

describe('PatientContactReader (GET identity/me, 0094)', () => {
  it('reads the phone a contact change wrote, unverified, and never reads enrollments without a phone', async () => {
    const crypto = new PatientProfileCrypto();
    const ciphertext = crypto.encryptContact('change-1', 'phone', '+447700900123');
    const { client: withPhone } = client(contactRow({ phone_ciphertext: ciphertext, phone_lookup_hmac: 'a'.repeat(64),
      phone_change_id: 'change-1', phone_change_key_version: 'nin-v7', has_photo: true }));
    await expect(new PatientContactReader(crypto).read(withPhone, actor)).resolves.toEqual({
      email: 'pat@example.invalid', emailVerified: true, phone: '+447700900123', phoneVerified: false, hasPhoto: true,
    });
    const { client: withoutPhone, query } = client(contactRow({ email_verified: false }));
    await expect(new PatientContactReader(crypto).read(withoutPhone, actor)).resolves.toEqual({
      email: 'pat@example.invalid', emailVerified: false, phone: null, phoneVerified: false, hasPhoto: false,
    });
    expect(query.mock.calls.map(([sql]) => sql).join(' ')).not.toContain('public_patient_enrollments');
  });

  it('reads a sign-up\'s declared phone (unverified) and a NIN route\'s verified phone contact, as system:auth and then the patient again', async () => {
    const crypto = new PatientProfileCrypto();
    const declared = enrollmentCiphertext('enrollment-1', 'phone', '+2348031234567');
    const signup = client(contactRow({ phone_ciphertext: declared, phone_lookup_hmac: 'b'.repeat(64) }), [{
      id: 'enrollment-1', key_version: 'nin-v7', nin_route: false, contact_channel: 'email',
      contact_ciphertext: Buffer.alloc(40), contact_lookup_hmac: 'c'.repeat(64), contact_verified_at: new Date(),
      signup_phone_ciphertext: declared, signup_phone_lookup_hmac: 'b'.repeat(64), profile_ciphertext: null }]);
    await expect(new PatientContactReader(crypto).read(signup.client, actor)).resolves
      .toMatchObject({ phone: '+2348031234567', phoneVerified: false });
    const calls = signup.query.mock.calls as unknown as Array<[string, unknown[]?]>;
    const index = calls.findIndex(([sql]) => sql.includes('public_patient_enrollments'));
    expect(calls[index - 1]?.[0]).toContain("'system:auth'");
    expect(calls[index]?.[1]).toEqual(['patient-id']);
    expect(calls[index + 1]).toEqual(["select set_config('app.actor_subject',$1,true)", ['patient-subject']]);

    const verified = enrollmentCiphertext('enrollment-2', 'contact', '+2348099999999');
    const nin = client(contactRow({ email: null, email_verified: false, phone_ciphertext: verified,
      phone_lookup_hmac: 'd'.repeat(64) }), [{
      id: 'enrollment-2', key_version: 'nin-v7', nin_route: true, contact_channel: 'phone',
      contact_ciphertext: verified, contact_lookup_hmac: 'd'.repeat(64), contact_verified_at: new Date(),
      signup_phone_ciphertext: null, signup_phone_lookup_hmac: null, profile_ciphertext: null }]);
    await expect(new PatientContactReader(crypto).read(nin.client, actor)).resolves
      .toEqual({ email: null, emailVerified: false, phone: '+2348099999999', phoneVerified: true, hasPhoto: false });
  });

  it('answers a migrated patient\'s phone (the migration key) as null, and nothing without a live session', async () => {
    const crypto = new PatientProfileCrypto();
    const legacy = client(contactRow({ phone_ciphertext: randomBytes(60), phone_lookup_hmac: 'e'.repeat(64) }));
    await expect(new PatientContactReader(crypto).read(legacy.client, actor)).resolves
      .toMatchObject({ phone: null, phoneVerified: false });
    await expect(new PatientContactReader(crypto).read(client(undefined).client, actor)).resolves.toBeUndefined();
  });
});
