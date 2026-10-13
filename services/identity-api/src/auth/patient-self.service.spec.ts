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
