import type { PoolClient } from 'pg';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { staffEmailFirstName } from './email-first-name';
import { NotificationOtpClient } from './notification-otp.client';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';
import type { TurnstileService } from './turnstile.service';
import type { HidRequest } from '../common/request-context';

// Owner decision of 17 November 2026 (Q89): a staff site's or the admin
// site's password reset code goes in the patients' branded layout, greeting
// the staff member by the first name of the account's display name, with no
// Health ID. Patients' emails are unchanged.

const original = { ...process.env };
const key = Buffer.alloc(32, 7);

beforeEach(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: 'https://ehr.healthidentitydirectory.com', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
    AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    OTP_HMAC_KEY_B64: key.toString('base64'), OTP_EXPIRY_SECONDS: '300',
    NOTIFICATION_API_URL: 'http://127.0.0.1:3007',
    NOTIFICATION_SERVICE_IDENTITY_MODE: 'local-secret',
    NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN: 'test-service-token-with-32-characters',
  });
  resetEnvironmentForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
  Object.assign(process.env, original);
  resetEnvironmentForTests();
});

describe('the staff greeting: the display name\'s first word after any titles', () => {
  it.each([
    ['Dr Ada Obi', 'Ada'],
    ['Dr. Ada Obi', 'Ada'],
    ['DR. ada obi', 'ada'],
    ['Prof Chinwe Eze', 'Chinwe'],
    ['Prof. Dr. Chinwe Eze', 'Chinwe'],
    ['Professor Chinwe Eze', 'Chinwe'],
    ['Mr Musa Bello', 'Musa'],
    ['Mrs. Ngozi Okafor', 'Ngozi'],
    ['Ms Amaka Uche', 'Amaka'],
    ['Miss Amaka Uche', 'Amaka'],
    ['Nurse Bisi Ade', 'Bisi'],
    ['  Nurse   Bisi  ', 'Bisi'],
    ['Ada', 'Ada'],
    ['Ada Obi', 'Ada'],
    ["O'Neil Smith", "O'Neil"],
    ['Jean-Paul Okeke', 'Jean-Paul'],
    ['QA Lab Checker', 'QA'],
    ['Drew Barrymore', 'Drew'],
    ['Missy Elliot', 'Missy'],
  ])('%p greets "Hello %s,"', (displayName, expected) => {
    expect(staffEmailFirstName(displayName)).toBe(expected);
  });

  it.each([[''], ['   '], ['Dr'], ['Dr.'], ['Dr. Mrs.'], ['Nurse'], ['1234'], [null], [undefined], [42]])(
    '%p has no first name, so the email says "Hello there,"', (displayName) => {
      expect(staffEmailFirstName(displayName)).toBeUndefined();
    });
});

describe('NotificationOtpClient.deliverStaffPasswordResetCode', () => {
  const plan = { capability: 'email', primary: 'ses', fallback: 'brevo', configuration: {} };
  const accepted = () => new Response(JSON.stringify({ outcome: 'accepted', primary: { provider: 'ses' } }), { status: 202 });
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  function client() {
    const integrations = { deliveryPlan: jest.fn().mockResolvedValue(plan) };
    return new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService);
  }
  const calls = () => (global.fetch as jest.Mock).mock.calls.map(([url, init]: [string, RequestInit]) => ({
    route: String(url).split('/api/v1/notifications/')[1],
    key: (init.headers as Record<string, string>)['idempotency-key'],
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  }));
  const input = { challengeId: 'challenge-21', recipient: 'ada@example.test', code: '012345', firstName: 'Ada',
    expiresInMinutes: 5, correlationId: 'request-21' };

  it('posts to staff-password-reset-code under the challenge\'s OTP key, with no Health ID', async () => {
    global.fetch = jest.fn().mockResolvedValue(accepted());
    await expect(client().deliverStaffPasswordResetCode(input)).resolves.toEqual({ outcome: 'accepted', provider: 'ses' });
    expect(calls()).toEqual([{ route: 'staff-password-reset-code', key: 'otp:challenge-21',
      body: { channel: 'email', recipient: 'ada@example.test', code: '012345', firstName: 'Ada', expiresInMinutes: 5,
        plan } }]);
  });

  it('leaves the first name out when there is none', async () => {
    global.fetch = jest.fn().mockResolvedValue(accepted());
    const { firstName: _omitted, ...nameless } = input;
    await client().deliverStaffPasswordResetCode(nameless);
    expect(calls()[0]?.body).not.toHaveProperty('firstName');
  });

  it('falls back once to the generic OTP route, under the same key, when an older notification-api answers 404', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(new Response('{}', { status: 404 })).mockResolvedValueOnce(accepted());
    await expect(client().deliverStaffPasswordResetCode(input)).resolves.toEqual({ outcome: 'accepted', provider: 'ses' });
    expect(calls()).toEqual([
      { route: 'staff-password-reset-code', key: 'otp:challenge-21', body: expect.objectContaining({ firstName: 'Ada' }) },
      { route: 'otp', key: 'otp:challenge-21',
        body: { channel: 'email', recipient: 'ada@example.test', code: '012345', purpose: 'PASSWORD_RESET', plan } },
    ]);
  });

  it.each([[500, 'unknown'], [503, 'unknown'], [400, 'definitive_failure'], [401, 'definitive_failure']] as const)(
    'never sends the code twice after a %s from the new route', async (status, outcome) => {
      global.fetch = jest.fn().mockResolvedValue(new Response('{}', { status }));
      await expect(client().deliverStaffPasswordResetCode(input)).resolves.toEqual({ outcome, safeCode: `http_${status}` });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

  it('never sends the code twice after a transport failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('timeout'));
    await expect(client().deliverStaffPasswordResetCode(input)).resolves.toEqual({ outcome: 'unknown', safeCode: 'transport_error' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('sends nothing without an email delivery plan', async () => {
    global.fetch = jest.fn();
    const integrations = { deliveryPlan: jest.fn().mockRejectedValue(new Error('no plan')) };
    await expect(new NotificationOtpClient(integrations as unknown as IntegrationRuntimeService)
      .deliverStaffPasswordResetCode(input)).resolves.toEqual({ outcome: 'definitive_failure' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('POST /auth/otp/start chooses the staff email for a staff site\'s or the admin site\'s reset', () => {
  function notificationMock() {
    return {
      deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'ses' }),
      deliverPasswordResetCode: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'ses' }),
      deliverStaffPasswordResetCode: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'ses' }),
    };
  }

  const staffAccount = { id: 'account-1', email: 'doctor@example.test', token_version: '1', phone_enrollment_id: null,
    phone_ciphertext: null, phone_key_version: null };

  function database(account: Record<string, unknown> | undefined, options: { displayName?: string | null;
    patient?: { first: string | null; hid: string | null } } = {}) {
    const calls: { sql: string; values: readonly unknown[] }[] = [];
    const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('auth.find_patient_account')) {
        return { rows: options.patient ? [{ patient_first_name: options.patient.first, patient_hid_code: options.patient.hid }] : [] };
      }
      if (sql.includes('from auth.accounts account')) return { rows: account ? [account] : [] };
      if (sql === 'select display_name from auth.accounts where id = $1::uuid') {
        return { rows: [{ display_name: options.displayName ?? null }] };
      }
      return { rows: [] };
    }) } as unknown as PoolClient;
    return { calls, database: {
      withSystemTransaction: jest.fn(async (_c: string, work: (value: PoolClient) => Promise<unknown>) => work(client)),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as DatabaseService };
  }

  async function start(service: OtpService, audience?: 'staff' | 'patient', purpose: 'PASSWORD_RESET'
    | 'LEGACY_ACCOUNT_RECOVERY' = 'PASSWORD_RESET') {
    const answer = await service.start({ identifier: 'doctor@example.test', purpose, remoteIp: '192.0.2.10',
      correlationId: 'staff-reset-0001', ...(audience ? { audience } : {}) });
    await service.settleDeliveries();
    return answer;
  }

  it('greets the staff member by the first name of the display name, titles dropped, with the expiry in minutes', async () => {
    const notification = notificationMock();
    const { calls, database: db } = database(staffAccount, { displayName: 'Dr. Ada Obi' });
    const service = new OtpService(db, notification as never);
    const answer = await start(service, 'staff');
    expect(notification.deliverStaffPasswordResetCode).toHaveBeenCalledWith({ challengeId: answer.challengeId,
      recipient: 'doctor@example.test', code: expect.stringMatching(/^\d{6}$/), firstName: 'Ada', expiresInMinutes: 5,
      correlationId: 'staff-reset-0001' });
    expect(notification.deliver).not.toHaveBeenCalled();
    expect(notification.deliverPasswordResetCode).not.toHaveBeenCalled();
    expect(calls.find(({ sql }) => sql === 'select display_name from auth.accounts where id = $1::uuid')?.values)
      .toEqual(['account-1']);
  });

  it('reads OTP_EXPIRY_SECONDS for the minutes', async () => {
    process.env.OTP_EXPIRY_SECONDS = '600';
    resetEnvironmentForTests();
    const notification = notificationMock();
    await start(new OtpService(database(staffAccount, { displayName: 'Ada' }).database, notification as never), 'staff');
    expect(notification.deliverStaffPasswordResetCode.mock.calls[0]?.[0]).toMatchObject({ expiresInMinutes: 10 });
  });

  it.each([[null], ['Dr.'], ['1234']])('greets "there" (no firstName) for the display name %p', async (displayName) => {
    const notification = notificationMock();
    await start(new OtpService(database(staffAccount, { displayName }).database, notification as never), 'staff');
    expect(notification.deliverStaffPasswordResetCode.mock.calls[0]?.[0]).not.toHaveProperty('firstName');
  });

  it('keeps the patient email for a patient account, whatever site asked', async () => {
    const notification = notificationMock();
    await start(new OtpService(database(staffAccount, { patient: { first: 'Ada', hid: 'HID-ABC234' } }).database,
      notification as never), 'staff');
    expect(notification.deliverPasswordResetCode).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'Ada',
      healthId: 'HID-ABC234' }));
    expect(notification.deliverStaffPasswordResetCode).not.toHaveBeenCalled();
  });

  it.each([
    ['the patient portal\'s reset of a staff-only account', 'patient' as const, 'PASSWORD_RESET' as const],
    ['a caller that names no audience', undefined, 'PASSWORD_RESET' as const],
    ['a legacy recovery', 'staff' as const, 'LEGACY_ACCOUNT_RECOVERY' as const],
  ])('keeps the generic code message for %s, reading no display name', async (_label, audience, purpose) => {
    const notification = notificationMock();
    const { calls, database: db } = database(staffAccount, { displayName: 'Dr Ada Obi' });
    await start(new OtpService(db, notification as never), audience, purpose);
    expect(notification.deliverStaffPasswordResetCode).not.toHaveBeenCalled();
    expect(notification.deliver).toHaveBeenCalledWith(expect.objectContaining({ purpose, channel: 'email' }));
    expect(calls.some(({ sql }) => sql.includes('select display_name'))).toBe(false);
  });

  it('answers a staff account and an unknown identifier with the same body', async () => {
    const answers = [];
    for (const account of [staffAccount, undefined]) {
      const service = new OtpService(database(account, { displayName: 'Ada' }).database, notificationMock() as never);
      const answer = await start(service, 'staff');
      answers.push({ ...answer, challengeId: typeof answer.challengeId });
    }
    expect(answers[1]).toEqual(answers[0]);
  });

  it.each([
    ['staff-reset', 'staff'], ['admin-reset', 'staff'], ['patient-reset-start', 'patient'], ['legacy-recovery', 'patient'],
  ] as const)('the controller maps the %s check to the %s audience', async (turnstileAction, audience) => {
    const otp = { start: jest.fn().mockResolvedValue({ accepted: true }) };
    const turnstile = { verify: jest.fn().mockResolvedValue(undefined) };
    const controller = new OtpController(otp as unknown as OtpService, turnstile as unknown as TurnstileService);
    const headers: Record<string, string> = { origin: 'https://ehr.healthidentitydirectory.com' };
    await controller.start({ identifier: 'doctor@example.test', purpose: 'PASSWORD_RESET', turnstileAction,
      turnstileToken: 'token' } as never, { correlationId: 'staff-reset-0002', ip: '192.0.2.10',
      header: (name: string) => headers[name] } as unknown as HidRequest);
    expect(otp.start).toHaveBeenCalledWith(expect.objectContaining({ audience }));
  });
});
