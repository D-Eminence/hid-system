import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.service';
import type { PatientRecordsService } from './patient-records.service';
import type { AuditService } from '../../audit/audit.service';
import type { HidRequest } from '../../common/request-context';
import { PatientChatHistoryService } from './patient-chat-history.service';

const auth = { patientId: 'patient-a', subject: 'subject-a', accountId: 'account-a', sessionId: 'session-a', expiresAt: new Date(Date.now() + 30000).toISOString() };
const request = { correlationId: 'history-test' } as HidRequest;
const reply = { status: 'ready' as const, answer: 'Private answer [1].', sources: [{ number: 1, noteId: 'note-a', revisionNo: 1, title: 'Visit', signedAt: new Date().toISOString() }] };
function setup() {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('for update')) return { rows: [{ generation: 'generation-a' }] };
    if (sql.includes('content_sha256 as hash')) return { rows: [{ hash: 'a'.repeat(64) }] };
    return { rows: [] };
  });
  const authorizeSelf = jest.fn().mockResolvedValue(auth);
  const audit = jest.fn().mockResolvedValue(undefined);
  const transaction = jest.fn(async (_auth: unknown, _id: string, work: (c: PoolClient) => Promise<unknown>) => work({ query } as unknown as PoolClient));
  const history = new PatientChatHistoryService({ withPatientTransaction: transaction } as unknown as DatabaseService,
    { authorizeSelf } as unknown as PatientRecordsService, { recordWithClient: audit } as unknown as AuditService);
  return { history, query, authorizeSelf, audit, transaction };
}
describe('Patient-owned saved history', () => {
  it('rejects an old generation before saving any conversation text', async () => {
    const { history, query } = setup();
    await expect(history.save(request, 'old-generation', 'Private question', reply)).rejects.toThrow('conversation was cleared');
    expect(query.mock.calls.some(([sql]) => sql.includes('insert into ehr.patient_chat_messages'))).toBe(false);
  });
  it('does not save a reply whose source is no longer available', async () => {
    const { history, query } = setup();
    const original = query.getMockImplementation()!;
    query.mockImplementation((sql, params) => sql.includes('content_sha256 as hash') ? Promise.resolve({ rows: [] }) : original(sql, params));
    await expect(history.save(request, 'generation-a', 'Private question', reply)).rejects.toThrow('source records changed');
    expect(query.mock.calls.some(([sql]) => sql.includes('insert into ehr.patient_chat_messages'))).toBe(false);
  });
  it('binds stored sources and pruning to the freshly authorized patient without auditing message text', async () => {
    const { history, query, audit } = setup();
    await history.save(request, 'generation-a', 'Private question', reply);
    const insert = query.mock.calls.find(([sql]) => sql.includes('insert into ehr.patient_chat_messages'))!;
    expect(insert[1]?.slice(0, 3)).toEqual([auth.patientId, 'generation-a', 'Private question']);
    expect(insert[1]?.[4]).toContain('a'.repeat(64));
    expect(query.mock.calls.some(([sql, params]) => sql.includes('offset 10') && params?.[0] === auth.patientId)).toBe(true);
    expect(JSON.stringify(audit.mock.calls)).not.toContain('Private question');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('Private answer');
  });
  it('reauthorizes history reads and never touches the database after revocation', async () => {
    const { history, authorizeSelf, transaction } = setup();
    authorizeSelf.mockRejectedValue(new Error('revoked'));
    await expect(history.read(request)).rejects.toThrow('revoked');
    expect(transaction).not.toHaveBeenCalled();
  });
  it('deletes only the authorized patient messages and changes the generation after deleting', async () => {
    const { history, query } = setup();
    await expect(history.clear(request)).resolves.toEqual({ cleared: true });
    const deletion = query.mock.calls.findIndex(([sql]) => sql === 'delete from ehr.patient_chat_messages where patient_id=$1');
    const generation = query.mock.calls.findIndex(([sql]) => sql.includes('update ehr.patient_chat_state'));
    expect(deletion).toBeGreaterThan(-1);
    expect(generation).toBeGreaterThan(deletion);
    expect(query.mock.calls[deletion]?.[1]).toEqual([auth.patientId]);
  });
});
