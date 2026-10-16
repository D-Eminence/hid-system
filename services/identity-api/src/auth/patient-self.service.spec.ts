import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { PatientSelfService } from './patient-self.service';

const request = { actor: { kind: 'patient', patientId: 'patient-id', accountId: 'account-id',
  subject: 'patient-subject', sessionId: 'session-id' }, correlationId: 'self-test-request',
  header: () => undefined } as unknown as HidRequest;

function setup(value: unknown, auditFailure = false) {
  const query = jest.fn().mockResolvedValue({ rows: [{ value }] });
  const client = { query } as unknown as PoolClient;
  const transaction = jest.fn(async (_id: string, callback: (c: PoolClient) => Promise<unknown>) => callback(client));
  const record = auditFailure ? jest.fn().mockRejectedValue(new Error('audit unavailable')) : jest.fn().mockResolvedValue(undefined);
  const service = new PatientSelfService({ withSystemTransaction: transaction } as unknown as DatabaseService,
    { recordWithClient: record } as unknown as AuditService);
  return { service, query, transaction, record };
}

describe('Patient self service', () => {
  it('derives profile target from the verified subject/session and commits audit before returning', async () => {
    const { service, query, record } = setup({ patientId: 'patient-id', hid: 'HID-ABCDEFGH' });
    await expect(service.profile(request)).resolves.toMatchObject({ patientId: 'patient-id' });
    expect(query.mock.calls[1]?.[1]).toEqual(['patient-subject', 'session-id']);
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorType: 'patient', actorAccountId: 'account-id', patientId: 'patient-id', outcome: 'success',
    }));
  });
  it('does not return PHI if required audit persistence fails', async () => {
    await expect(setup({ patientId: 'patient-id' }, true).service.profile(request)).rejects.toThrow('audit unavailable');
  });
  it('commits a denial event when a session is revoked or mapped identity is unavailable', async () => {
    const { service, record } = setup(null);
    await expect(service.profile(request)).rejects.toThrow('Patient access is unavailable');
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'denied' }));
  });
  it('rejects workforce callers and a different authorized patient', async () => {
    const { service, transaction } = setup('other-patient');
    await expect(service.authorize(request)).rejects.toThrow('Patient access is unavailable');
    transaction.mockClear();
    await expect(service.profile({ ...request, actor: { ...request.actor, kind: 'staff' } } as HidRequest))
      .rejects.toThrow('An active patient session is required');
    expect(transaction).not.toHaveBeenCalled();
  });
  /** Answers the PIN transaction by statement: recovery hold, recent sign-in, then the command. */
  function pinStatements(query: jest.Mock, options: { held?: boolean; recent?: boolean } = {}) {
    query.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: options.held ?? false }] };
      if (sql.includes('min(family.issued_at)')) return { rows: [{ recent: options.recent ?? true }] };
      if (sql.includes('_my_patient_access_pin')) return { rows: [{ patient_id: 'patient-id' }] };
      return { rows: [] };
    });
  }
  const index = (query: jest.Mock, text: string) => query.mock.calls.findIndex(([sql]) => String(sql).includes(text));

  it('configures a PIN only through the patient-session-bound database command', async () => {
    const { service, query } = setup({ ignored: true });
    pinStatements(query);
    await expect(service.setAccessPin(request, '1234')).resolves.toEqual({ configured: true });
    expect(query).toHaveBeenCalledWith("select set_config('app.actor_subject',$1,true)", ['patient-subject']);
    expect(query).toHaveBeenCalledWith('select identity.set_my_patient_access_pin($1, $2, $3) as patient_id',
      ['patient-subject', 'session-id', '1234']);
    expect(index(query, 'set_config')).toBeLessThan(index(query, 'set_my_patient_access_pin'));
  });
  it('revokes a PIN only through the patient-session-bound database command', async () => {
    const { service, query } = setup({ ignored: true });
    pinStatements(query);
    await expect(service.revokeAccessPin(request)).resolves.toEqual({ revoked: true });
    expect(query).toHaveBeenCalledWith("select set_config('app.actor_subject',$1,true)", ['patient-subject']);
    expect(query).toHaveBeenCalledWith('select identity.revoke_my_patient_access_pin($1, $2) as patient_id',
      ['patient-subject', 'session-id']);
    expect(index(query, 'set_config')).toBeLessThan(index(query, 'revoke_my_patient_access_pin'));
  });
  it('denies a PIN change when the authentication family is no longer recent', async () => {
    const { service, query } = setup({ ignored: true });
    pinStatements(query, { recent: false });
    await expect(service.setAccessPin(request, '1234')).rejects.toThrow('Sign in again');
    expect(index(query, 'min(family.issued_at)')).toBeGreaterThan(-1);
    expect(index(query, 'set_my_patient_access_pin')).toBe(-1);
  });
  it('refuses to set a PIN for 24 hours after an OTP account recovery, even right after sign-in (REC-NOTIFY)', async () => {
    const { service, query } = setup({ ignored: true });
    pinStatements(query, { held: true, recent: true });
    await expect(service.setAccessPin(request, '1234'))
      .rejects.toMatchObject({ status: 403, code: 'PATIENT_RECENT_RECOVERY_HOLD' });
    expect(index(query, 'set_my_patient_access_pin')).toBe(-1);
    const hold = query.mock.calls.find(([sql]) => String(sql).includes('from auth.otp_challenges'));
    expect(hold?.[1]).toEqual(['account-id', 24]);
  });
  it('still revokes a PIN during the recovery hold', async () => {
    const { service, query } = setup({ ignored: true });
    pinStatements(query, { held: true, recent: true });
    await expect(service.revokeAccessPin(request)).resolves.toEqual({ revoked: true });
    expect(index(query, 'from auth.otp_challenges')).toBe(-1);
  });
});

// Imported legacy medical history (owner decision 3 of 2026-10-16, ADR-065):
// the patient's own choice to share it with the facilities they approve,
// through session-bound database commands, audited in the same transaction.
describe('Patient imported history sharing', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const environment = require('../config/environment') as typeof import('../config/environment');
  const sharingSwitch = (enabled: boolean) => jest.spyOn(environment, 'getEnvironment').mockReturnValue(
    { IMPORTED_HISTORY_SHARING_ENABLED: enabled } as ReturnType<typeof environment.getEnvironment>);
  beforeEach(() => { sharingSwitch(true); });
  afterEach(() => { jest.restoreAllMocks(); });

  /** Answers the sharing transaction by statement. */
  function sharingStatements(query: jest.Mock, options: { held?: boolean; recent?: boolean; refused?: boolean;
    row?: Record<string, unknown> } = {}) {
    query.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: options.held ?? false }] };
      if (sql.includes('min(family.issued_at)')) return { rows: [{ recent: options.recent ?? true }] };
      if (sql.includes('imported_history_sharing(')) {
        if (options.refused) throw Object.assign(new Error('PATIENT_SELF_SESSION_REQUIRED'), { code: '42501' });
        return { rows: [options.row ?? { shared: true, changed: true, updatedAt: '2026-10-16T00:00:00.000Z' }] };
      }
      return { rows: [] };
    });
  }
  const index = (query: jest.Mock, text: string) => query.mock.calls.findIndex(([sql]) => String(sql).includes(text));

  it('reads the choice through the session-bound command with the verified subject and session', async () => {
    const { service, query, record } = setup(null);
    sharingStatements(query, { row: { shared: false, updatedAt: null } });
    await expect(service.importedHistorySharing(request)).resolves.toEqual({ shared: false, updatedAt: null });
    const command = index(query, 'identity.my_imported_history_sharing($1,$2)');
    expect(command).toBeGreaterThan(index(query, "set_config('app.actor_subject'"));
    expect(query.mock.calls[command]?.[1]).toEqual(['patient-subject', 'session-id']);
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'identity.patient.self.imported-history-sharing.read', actorType: 'patient', patientId: 'patient-id',
      purposeOfUse: 'patient-self', outcome: 'success', details: { shared: false } }));
  });

  it('turns sharing on only after the recovery hold and recent sign-in checks, and audits the change', async () => {
    const { service, query, record } = setup(null);
    sharingStatements(query);
    await expect(service.setImportedHistorySharing(request, true)).resolves.toEqual({ shared: true, changed: true,
      updatedAt: '2026-10-16T00:00:00.000Z' });
    const command = index(query, 'identity.set_my_imported_history_sharing($1,$2,$3)');
    expect(index(query, 'from auth.otp_challenges')).toBeLessThan(command);
    expect(index(query, 'min(family.issued_at)')).toBeLessThan(command);
    expect(query.mock.calls[command]?.[1]).toEqual(['patient-subject', 'session-id', true]);
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'identity.patient.self.imported-history-sharing.change', purposeOfUse: 'patient-self', outcome: 'success',
      details: { shared: true, changed: true } }));
  });

  it.each([
    ['a recovery hold', { held: true }, 'PATIENT_RECENT_RECOVERY_HOLD'],
    ['no recent sign-in', { recent: false }, 'PATIENT_RECENT_AUTH_REQUIRED'],
  ])('refuses to turn sharing on with %s, before the command', async (_case, options, code) => {
    const { service, query, record } = setup(null);
    sharingStatements(query, options);
    await expect(service.setImportedHistorySharing(request, true)).rejects.toMatchObject({ status: 403, code });
    expect(index(query, 'set_my_imported_history_sharing')).toBe(-1);
    expect(record).not.toHaveBeenCalled();
  });

  it('names the held change in a sentence the client may show', async () => {
    const { service, query } = setup(null);
    sharingStatements(query, { held: true });
    const refusal = await service.setImportedHistorySharing(request, true).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ status: 403, code: 'PATIENT_RECENT_RECOVERY_HOLD' });
    expect((refusal as Error).message).toMatch(/; imported medical history sharing changes are available again once that period ends$/);
  });

  it('refuses to turn sharing on while the sharing switch is off, before any transaction', async () => {
    sharingSwitch(false);
    const { service, transaction, record } = setup(null);
    await expect(service.setImportedHistorySharing(request, true)).rejects.toMatchObject({ status: 503,
      code: 'IMPORTED_HISTORY_SHARING_DISABLED' });
    expect(transaction).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('turns sharing off while the sharing switch is off: withdrawing is always allowed', async () => {
    sharingSwitch(false);
    const { service, query, record } = setup(null);
    sharingStatements(query, { held: true, recent: false, row: { shared: false, changed: true, updatedAt: null } });
    await expect(service.setImportedHistorySharing(request, false)).resolves.toEqual({ shared: false, changed: true,
      updatedAt: null });
    const command = index(query, 'identity.set_my_imported_history_sharing($1,$2,$3)');
    expect(query.mock.calls[command]?.[1]).toEqual(['patient-subject', 'session-id', false]);
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'identity.patient.self.imported-history-sharing.change', details: { shared: false, changed: true } }));
  });

  it('turns sharing off without the recovery hold or recent sign-in checks', async () => {
    const { service, query } = setup(null);
    sharingStatements(query, { held: true, recent: false, row: { shared: false, changed: true, updatedAt: null } });
    await expect(service.setImportedHistorySharing(request, false)).resolves.toEqual({ shared: false, changed: true,
      updatedAt: null });
    expect(index(query, 'from auth.otp_challenges')).toBe(-1);
    expect(index(query, 'min(family.issued_at)')).toBe(-1);
  });

  it.each(['read', 'change'] as const)('answers 403 PATIENT_ACCESS_DENIED when the command refuses the session (%s)',
    async (operation) => {
      const { service, query } = setup(null);
      sharingStatements(query, { refused: true });
      const call = operation === 'read' ? service.importedHistorySharing(request)
        : service.setImportedHistorySharing(request, false);
      await expect(call).rejects.toMatchObject({ status: 403, code: 'PATIENT_ACCESS_DENIED' });
    });

  it('discloses nothing when the audit row cannot be written', async () => {
    const { service, query } = setup(null, true);
    sharingStatements(query, { row: { shared: true, updatedAt: '2026-10-16T00:00:00.000Z' } });
    await expect(service.importedHistorySharing(request)).rejects.toThrow('audit unavailable');
  });

  it('refuses a staff actor before any transaction', async () => {
    const { service, transaction } = setup(null);
    const staff = { ...request, actor: { ...request.actor, kind: 'staff' } } as HidRequest;
    await expect(service.importedHistorySharing(staff)).rejects.toThrow('An active patient session is required');
    await expect(service.setImportedHistorySharing(staff, true)).rejects.toThrow('An active patient session is required');
    expect(transaction).not.toHaveBeenCalled();
  });
});
