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
});
