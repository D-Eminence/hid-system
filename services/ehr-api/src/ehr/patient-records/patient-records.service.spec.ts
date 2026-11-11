import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import { ClinicalRepository } from '../shared/clinical.repository';
import { PatientRecordsService } from './patient-records.service';

const actor = { kind: 'patient', patientId: 'patient-id', accountId: 'account-id', subject: 'subject', sessionId: 'session-id' };
const request = { actor, correlationId: 'patient-record-test', header: () => undefined } as unknown as HidRequest;
function setup() {
  const authorization = { ...actor, expiresAt: new Date(Date.now() + 30_000).toISOString(), allowed: true };
  const authorizeSelf = jest.fn().mockResolvedValue(authorization);
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const transaction = jest.fn(async (_auth: unknown, _correlation: string, work: (c: PoolClient) => Promise<unknown>) => work({ query } as unknown as PoolClient));
  const recordWithClient = jest.fn().mockResolvedValue(undefined);
  const run = jest.fn().mockResolvedValue({ encounters: [], notes: [], limit: 50 });
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

describe('The emergency read answers the allergies (0117)', () => {
  const facility = 'facility-here';
  const createdAt = new Date('2026-03-03T10:00:00Z');
  function run(answers: [RegExp, unknown[]][]) {
    const calls: { sql: string; values: unknown[] }[] = [];
    const query = jest.fn(async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: answers.find(([pattern]) => pattern.test(sql))?.[1] ?? [] };
    });
    let outcome: { value: Record<string, unknown>; details?: Record<string, unknown> } | undefined;
    const clinical = { run: jest.fn(async (_c, _p, _a, _e, work) => {
      outcome = await work({ query } as unknown as PoolClient);
      return outcome!.value;
    }) };
    const service = new PatientRecordsService({} as DatabaseService, {} as IdentityApiService, {} as AuditService,
      clinical as unknown as ClinicalRepository);
    const context = { purposeOfUse: 'emergency', facilityId: facility } as DataAccessContext;
    return { service, context, calls, clinical, outcome: () => outcome! };
  }

  it('answers the active recorded allergies and the patient text, labelled by source, with counts in the audit', async () => {
    const { service, context, calls, clinical, outcome } = run([
      [/from ehr\.recorded_allergies/, [
        { id: 'a1', substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'severe', facilityId: 'elsewhere', createdAt },
        { id: 'a2', substance: 'Latex', reaction: null, severity: 'unknown', facilityId: facility, createdAt }]],
      [/patient_reported_health_profiles/, [{ allergies: 'sulfa drugs', updated_at: createdAt }]],
    ]);
    const value = await service.emergency('patient-id', context) as Record<string, unknown>;
    expect(clinical.run).toHaveBeenCalledWith(context, 'patient-id', 'read_records',
      expect.objectContaining({ action: 'ehr.emergency.records.read', breakGlassOnly: true }), expect.any(Function));
    expect(value.allergies).toEqual({
      recorded: [
        { source: 'recorded', id: 'a1', substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'severe',
          recordedHere: false, recordedOn: createdAt },
        { source: 'recorded', id: 'a2', substance: 'Latex', reaction: null, severity: 'unknown', recordedHere: true,
          recordedOn: createdAt }],
      patientReported: { source: 'patient_reported', allergies: 'sulfa drugs', updatedAt: createdAt },
    });
    // Active only, any facility (the allergies follow the patient), most serious first.
    const read = calls.find((call) => /from ehr\.recorded_allergies/.test(call.sql))!;
    expect(read.sql).toContain("status = 'active'");
    expect(read.sql).not.toMatch(/facility_id\s*=/);
    expect(read.sql).toContain("array['severe', 'unknown', 'moderate', 'mild']");
    expect(read.values).toEqual(['patient-id']);
    expect(outcome().details).toEqual({ recordedAllergyCount: 2, patientReportedAllergies: true });
    expect(JSON.stringify(outcome().details)).not.toMatch(/Penicillin|sulfa/);
  });

  it('answers empty allergies and a null patient text when there are none', async () => {
    const { service, context, outcome } = run([]);
    const value = await service.emergency('patient-id', context) as Record<string, unknown>;
    expect(value.allergies).toEqual({ recorded: [],
      patientReported: { source: 'patient_reported', allergies: null, updatedAt: null } });
    expect(outcome().details).toEqual({ recordedAllergyCount: 0, patientReportedAllergies: false });
  });
});
