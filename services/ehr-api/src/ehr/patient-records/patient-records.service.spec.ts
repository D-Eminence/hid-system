import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import { ClinicalRepository } from '../shared/clinical.repository';
import { PatientRecordsService } from './patient-records.service';

// PATIENT_ENTRIES_ENABLED (0116), off unless a test turns it on.
let mockEntriesEnabled = false;
jest.mock('../patient-entries/patient-entries.flag', () => ({ patientEntriesEnabled: () => mockEntriesEnabled }));
afterEach(() => { mockEntriesEnabled = false; });

const actor = { kind: 'patient', patientId: 'patient-id', accountId: 'account-id', subject: 'subject', sessionId: 'session-id' };
const request = { actor, correlationId: 'patient-record-test', header: () => undefined } as unknown as HidRequest;
function setup() {
  const authorization = { ...actor, expiresAt: new Date(Date.now() + 30_000).toISOString(), allowed: true };
  const authorizeSelf = jest.fn().mockResolvedValue(authorization);
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const transaction = jest.fn(async (_auth: unknown, _correlation: string, work: (c: PoolClient) => Promise<unknown>) => work({ query } as unknown as PoolClient));
  const recordWithClient = jest.fn().mockResolvedValue(undefined);
  const run = jest.fn(async (_context: unknown, _patient: string, _access: string, _event: unknown,
    operation: (c: PoolClient) => Promise<{ value: unknown }>) => (await operation({ query } as unknown as PoolClient)).value);
  const service = new PatientRecordsService({ withPatientTransaction: transaction } as unknown as DatabaseService,
    { authorizeSelf } as unknown as IdentityApiService, { recordWithClient } as unknown as AuditService,
    { run } as unknown as ClinicalRepository);
  return { service, transaction, authorizeSelf, recordWithClient, query, run };
}

describe('Owning EHR patient and emergency read boundary', () => {
  it('reauthorizes self with Identity and constrains all SQL to that canonical patient', async () => {
    const { service, authorizeSelf, query, recordWithClient } = setup();
    await expect(service.self(request)).resolves.toEqual({ encounters: [], notes: [], importedRecords: [], importedHealthProfile: null, limit: 50 });
    expect(authorizeSelf).toHaveBeenCalledWith(request);
    for (const [sql, params] of query.mock.calls) {
      expect(params).toEqual(['patient-id']);
      expect(sql).toMatch(/limit (50|1)\b/);
    }
    expect(query.mock.calls[0]?.[0]).toContain("status='completed'");
    expect(query.mock.calls[1]?.[0]).toContain("n.status in ('signed','amended')");
    expect(recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorType: 'patient', outcome: 'success' }));
  });
  it('denies altered patient mapping before opening an EHR transaction', async () => {
    const { service, authorizeSelf, transaction } = setup();
    authorizeSelf.mockResolvedValue({ ...actor, patientId: 'other-patient' });
    await expect(service.self(request)).rejects.toThrow('Patient authorization changed');
    expect(transaction).not.toHaveBeenCalled();
  });
  it('fails closed before PHI serialization on Identity or durable audit failure', async () => {
    const { service, recordWithClient } = setup();
    recordWithClient.mockRejectedValue(new Error('audit failed'));
    await expect(service.self(request)).rejects.toThrow('audit failed');
  });
  it('requires a current break-glass authorization through the existing clinical repository', async () => {
    const { service, run } = setup();
    const context = { purposeOfUse: 'emergency', facilityId: 'facility' } as DataAccessContext;
    await service.emergency('patient-id', context);
    expect(run).toHaveBeenCalledWith(context, 'patient-id', 'read_records', expect.objectContaining({ breakGlassOnly: true }), expect.any(Function));
  });
  it('uses fresh patient/facility consent for imported staff history', async () => {
    const {service,run} = setup();
    const context = {purposeOfUse:'direct-care',facilityId:'facility'} as DataAccessContext;
    await service.imported('patient-id',context);
    expect(run).toHaveBeenCalledWith(context,'patient-id','read_records',
      expect.objectContaining({action:'ehr.imported.records.read'}),expect.any(Function));
  });
  it('returns preserved versions and pending attachment metadata only after audit', async () => {
    const {service,query,recordWithClient} = setup();
    const imported = {id:'record',origin:'patient-provided',versions:[{record:'Synthetic note'}],files:[{accessStatus:'pending-safety-verification'}]};
    query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[imported]});
    const result = await service.self(request);
    expect(result.importedRecords).toEqual([imported]);
    expect(recordWithClient).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({details:expect.objectContaining({importedRecordCount:1})}));
    const sql = query.mock.calls[2][0];
    expect(sql).not.toContain('storage_path');
    expect(sql).not.toContain('author_account_id');
    expect(sql).toContain('v.patient_id=r.patient_id');
  });
  it('answers exactly today\'s keys, and never reads the records patients add, while the setting is off', async () => {
    const { service, query } = setup();
    const value = await service.self(request);
    expect(Object.keys(value).sort()).toEqual(['encounters', 'importedHealthProfile', 'importedRecords', 'limit', 'notes']);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('patient_entries'))).toBe(false);
  });
  it('adds the patient\'s own active entries, newest first, and counts them in the audit, while the setting is on', async () => {
    mockEntriesEnabled = true;
    const { service, query, recordWithClient } = setup();
    const stored = (n: number) => ({ id: `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`, kind: 'medicine',
      title: `Synthetic medicine ${n}`, facility_name: null, occurred_on: '2026-10-01', notes: 'Twice a day',
      created_at: new Date('2026-10-01T08:00:00.000Z') });
    query.mockImplementation(async (sql: string) => ({ rows: sql.includes('from ehr.patient_entries')
      ? Array.from({ length: 51 }, (_, i) => stored(i)) : [] }));
    const value = await service.self(request) as Record<string, unknown>;
    expect(value).toMatchObject({ encounters: [], notes: [], importedRecords: [], importedHealthProfile: null, limit: 50,
      patientEntriesMore: true });
    expect(value.patientEntries).toHaveLength(50);
    expect((value.patientEntries as unknown[])[0]).toEqual({ id: stored(0).id, source: 'patient', kind: 'medicine',
      title: 'Synthetic medicine 0', facilityName: null, occurredOn: '2026-10-01', notes: 'Twice a day',
      createdAt: '2026-10-01T08:00:00.000Z', documents: [] });
    const entriesQuery = query.mock.calls.find(([sql]) => String(sql).includes('from ehr.patient_entries'))!;
    expect(entriesQuery[1]).toEqual(['patient-id']);
    expect(entriesQuery[0]).toContain("status = 'active'");
    expect(recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ehr.patient.self.records.read', details: expect.objectContaining({ patientEntryCount: 50 }) }));
  });
  it('never adds them to the emergency read or the imported history read', async () => {
    mockEntriesEnabled = true;
    const { service, query } = setup();
    const emergency = await service.emergency('patient-id', { purposeOfUse: 'emergency', facilityId: 'facility' } as DataAccessContext);
    expect(emergency).not.toHaveProperty('patientEntries');
    const imported = await service.imported('patient-id', { purposeOfUse: 'direct-care', facilityId: 'facility' } as DataAccessContext);
    expect(imported).not.toHaveProperty('patientEntries');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('patient_entries'))).toBe(false);
  });
});


describe('Emergency read grant revalidation', () => {
  it.each([{ allowed: false, breakGlass: false }, { allowed: true, breakGlass: false }])(
    'denies before EHR reads unless a current emergency grant is confirmed (%j)', async (decision) => {
      const withTransaction = jest.fn();
      const record = jest.fn().mockResolvedValue(undefined);
      const repository = new ClinicalRepository({ withTransaction } as unknown as DatabaseService,
        { record } as unknown as AuditService,
        { authorize: jest.fn().mockResolvedValue(decision) } as unknown as IdentityApiService);
      const context = { purposeOfUse: 'emergency', facilityId: 'facility', membershipId: 'membership',
        correlationId: 'emergency-revalidation-test', actor: { subject: 'doctor', accountId: 'account' } } as DataAccessContext;
      await expect(repository.run(context, 'patient-id', 'read_records', {
        action: 'ehr.emergency.records.read', resourceType: 'patient-record-summary', breakGlassOnly: true,
      }, jest.fn())).rejects.toThrow('Active consent and facility membership are required');
      expect(withTransaction).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', patientId: 'patient-id' }));
    },
  );
});
