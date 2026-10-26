import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { PatientSelfService, publishAccessHistory } from './patient-self.service';

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
  it('historical inbox binds the active session and paginates only its account',async()=>{
    const s=setup(null);s.query.mockReset();
    s.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{active:true}]}).mockResolvedValueOnce({rows:[{id:'synthetic-item'}]});
    await expect(s.service.importedNotifications(request,50,undefined,100)).resolves.toEqual([{id:'synthetic-item'}]);
    expect(s.query.mock.calls[1][1]).toEqual(['session-id','account-id','patient-subject','patient','patient-id']);
    expect(s.query.mock.calls[2][1]).toEqual([50,100]);
    expect(s.record).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({action:'identity.imported.notification.list'}));
  });
  it('revoked inbox sessions cannot read or mark historical items',async()=>{
    const s=setup(null);s.query.mockReset();s.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{active:false}]});
    await expect(s.service.importedNotifications(request,50,'synthetic-item')).rejects.toThrow('active account session');
    expect(s.query).toHaveBeenCalledTimes(2);
  });
  it('historical inbox disclosure fails when durable audit fails',async()=>{
    const s=setup(null,true);s.query.mockReset();s.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{active:true}]}).mockResolvedValueOnce({rows:[{id:'synthetic-item'}]});
    await expect(s.service.importedNotifications(request)).rejects.toThrow('audit unavailable');
  });
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
  it('configures a PIN only through the patient-session-bound database command', async () => {
    const { service, query } = setup({ ignored: true });
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ held: false }] });
    query.mockResolvedValueOnce({ rows: [{ recent: true }] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ patient_id: 'patient-id' }] });
    await expect(service.setAccessPin(request, '1234')).resolves.toEqual({ configured: true });
    expect(query.mock.calls[0]?.[0]).toContain('auth.otp_challenges');
    expect(query.mock.calls[0]?.[1]).toEqual(['account-id', 24]);
    expect(query).toHaveBeenNthCalledWith(
      3,
      "select set_config('app.actor_subject',$1,true)",
      ['patient-subject'],
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      'select identity.set_my_patient_access_pin($1, $2, $3) as patient_id',
      ['patient-subject', 'session-id', '1234'],
    );
  });
  it('holds a PIN set for 24 hours after an OTP recovery, before the sign-in check, as main', async () => {
    const { service, query } = setup({ ignored: true });
    query.mockReset().mockResolvedValueOnce({ rows: [{ held: true }] });
    await expect(service.setAccessPin(request, '1234')).rejects.toMatchObject({
      status: 403, code: 'PATIENT_RECENT_RECOVERY_HOLD' });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('a PIN revocation is never held by a recovery', async () => {
    const { service, query } = setup({ ignored: true });
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ recent: true }] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ patient_id: 'patient-id' }] });
    await expect(service.revokeAccessPin(request)).resolves.toEqual({ revoked: true });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('auth.otp_challenges'))).toBe(false);
  });
  it('revokes a PIN only through the patient-session-bound database command', async () => {
    const { service, query } = setup({ ignored: true });
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ recent: true }] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ patient_id: 'patient-id' }] });
    await expect(service.revokeAccessPin(request)).resolves.toEqual({ revoked: true });
    expect(query).toHaveBeenNthCalledWith(
      2,
      "select set_config('app.actor_subject',$1,true)",
      ['patient-subject'],
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      'select identity.revoke_my_patient_access_pin($1, $2) as patient_id',
      ['patient-subject', 'session-id'],
    );
  });
  it('denies a PIN change when the authentication family is no longer recent', async () => {
    const { service, query } = setup({ ignored: true });
    query.mockReset().mockResolvedValueOnce({ rows: [{ held: false }] }).mockResolvedValueOnce({ rows: [{ recent: false }] });
    await expect(service.setAccessPin(request, '1234')).rejects.toThrow('Sign in again');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain('min(family.issued_at)');
  });
});

describe('Access history labels (0087)', () => {
  const item = (fields: Record<string, unknown>) => ({ consentGrantId: 'grant-id', scope: 'read_records', purpose: 'direct-care',
    status: 'active', startsAt: '2026-10-25T00:00:00Z', expiresAt: '2026-10-26T00:00:00Z', reason: 'Visit',
    facilityName: 'Synthetic Facility', ...fields });

  it('publishes revocableByPatient as the website\'s patientRevocable and drops the database key', async () => {
    const { service, query } = setup({ items: [item({ breakGlass: false, revocableByPatient: true }),
      item({ consentGrantId: 'emergency-id', scope: 'break_glass', breakGlass: true, revocableByPatient: false })] });
    const history = await service.history(request) as { items: Array<Record<string, unknown>> };
    expect(history.items).toEqual([item({ breakGlass: false, patientRevocable: true }),
      item({ consentGrantId: 'emergency-id', scope: 'break_glass', breakGlass: true, patientRevocable: false })]);
    expect(query.mock.calls[1]?.[0]).toContain('identity.patient_self_access_history($1,$2)');
    expect(query.mock.calls[1]?.[1]).toEqual(['patient-subject', 'session-id']);
  });

  it('answers patientRevocable false when the database sends no label, and never true for break-glass', () => {
    expect(publishAccessHistory({ items: [item({})] })).toEqual({ items: [item({ patientRevocable: false })] });
    expect(publishAccessHistory({ items: [item({ breakGlass: true, revocableByPatient: true })] }))
      .toEqual({ items: [item({ breakGlass: true, patientRevocable: false })] });
    expect(publishAccessHistory({ items: [] })).toEqual({ items: [] });
  });

  it('leaves the profile and a denied history unchanged', async () => {
    await expect(setup({ patientId: 'patient-id', revocableByPatient: true }).service.profile(request))
      .resolves.toEqual({ patientId: 'patient-id', revocableByPatient: true });
    await expect(setup(null).service.history(request)).rejects.toThrow('Patient access is unavailable');
  });
});
