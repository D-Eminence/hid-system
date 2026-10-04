import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import { ClinicalRepository } from '../shared/clinical.repository';
import { PatientRecordsController } from './patient-records.controller';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
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
    await expect(service.self(request)).resolves.toEqual({ encounters: [], notes: [], limit: 50 });
    expect(authorizeSelf).toHaveBeenCalledWith(request);
    for (const [sql, params] of query.mock.calls) {
      expect(params).toEqual(['patient-id']);
      expect(sql).toMatch(/limit 50/);
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

  it('reads a single completed encounter with exact patient and facility bounds and finalized entries', async () => {
    const { service, run, query } = setup();
    const context = { purposeOfUse: 'emergency', facilityId: 'facility-id' } as DataAccessContext;
    const client = { query } as unknown as PoolClient;
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] });
    for (let index = 0; index < 6; index += 1) query.mockResolvedValueOnce({ rows: [] });
    run.mockImplementation(async (_context, _patientId, _access, _event, operation, scopedLookup) => {
      expect(await scopedLookup(client)).toBe(true);
      return (await operation(client)).value;
    });
    await expect(service.emergencyEncounter('patient-id', 'encounter-id', context))
      .resolves.toMatchObject({ limitPerSection: 25, notes: [], diagnoses: [] });
    expect(run).toHaveBeenCalledWith(context, 'patient-id', 'read_records',
      expect.objectContaining({ action: 'ehr.emergency.encounter.read', breakGlassOnly: true }),
      expect.any(Function), expect.any(Function));
    for (const [sql, params] of query.mock.calls) {
      expect(params).toEqual(['encounter-id', 'patient-id', 'facility-id']);
      expect(sql).toContain('patient_id=$2');
      expect(sql).toContain('facility_id=$3');
    }
    expect(query.mock.calls[0]?.[0]).toContain("status='completed'");
    expect(query.mock.calls[2]?.[0]).toContain("n.status in ('signed','amended')");
    expect(query.mock.calls[5]?.[0]).toContain("status in ('active','on_hold','completed')");
    expect(query.mock.calls[6]?.[0]).toContain("status in ('active','completed')");
  });

  it('requires the emergency role and every clinical read permission on both emergency routes', () => {
    const summary = Reflect.getMetadata(REQUIRED_PERMISSIONS, PatientRecordsController.prototype.emergency) as string[];
    const detail = Reflect.getMetadata(REQUIRED_PERMISSIONS, PatientRecordsController.prototype.emergencyEncounter) as string[];
    expect(summary).toContain('identity.break-glass.write');
    expect(detail).toEqual(expect.arrayContaining([
      'identity.break-glass.write', 'ehr.encounter.read', 'ehr.note.read', 'ehr.vital.read',
      'ehr.diagnosis.read', 'ehr.prescription.read', 'ehr.lab-request.read',
    ]));
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

  it('does not run a detailed read when the exact emergency grant is revoked or expired', async () => {
    const withTransaction = jest.fn();
    const record = jest.fn().mockResolvedValue(undefined);
    const repository = new ClinicalRepository({ withTransaction } as unknown as DatabaseService,
      { record } as unknown as AuditService,
      { authorize: jest.fn().mockResolvedValue({ allowed: false, breakGlass: false }) } as unknown as IdentityApiService);
    const context = { purposeOfUse: 'emergency', facilityId: 'facility', membershipId: 'membership',
      correlationId: 'emergency-expiry-test', actor: { subject: 'doctor', accountId: 'account' } } as DataAccessContext;
    await expect(repository.run(context, 'patient-id', 'read_records', {
      action: 'ehr.emergency.encounter.read', resourceType: 'emergency-encounter-chart',
      resourceId: 'encounter-id', breakGlassOnly: true,
    }, jest.fn(), jest.fn())).rejects.toThrow('Active consent and facility membership are required');
    expect(withTransaction).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', resourceId: 'encounter-id' }));
  });
});
