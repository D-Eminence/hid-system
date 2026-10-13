import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { DiagnosisClinicalStatus, DiagnosisVerificationStatus } from '../shared/clinical.dto';
import { DiagnosesService, type DiagnosisRow } from './diagnoses.service';

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const encounterId = '123e4567-e89b-42d3-a456-426614174005';
const diagnosisId = '123e4567-e89b-42d3-a456-426614174006';

const context = { correlationId: 'correlation-123456', facilityId, membershipId,
  purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: { id: accountId,
    subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['doctor'],
    permissions: ['ehr.diagnosis.write'], facilityIds: [facilityId], facilities: [] } } as DataAccessContext;

const diagnosis = (verificationStatus: DiagnosisVerificationStatus): DiagnosisRow => ({
  id: diagnosisId, encounterId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
  codeSystem: 'http://hl7.org/fhir/sid/icd-10', code: 'J18.9', display: 'Pneumonia, unspecified',
  clinicalStatus: DiagnosisClinicalStatus.Active, verificationStatus, onsetAt: null, abatementAt: null, notes: null,
  rowVersion: '2', createdAt: new Date('2026-10-01T08:00:00.000Z'), updatedAt: new Date('2026-10-01T08:00:00.000Z'),
});

/** A fake transaction for one stored diagnosis; the row lock returns it, an UPDATE returns it changed. */
function harness(stored: DiagnosisRow) {
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/^\s*update ehr\.diagnoses\b/i.test(sql)) {
      return { rows: [{ ...stored, verificationStatus: params[1] ?? stored.verificationStatus, rowVersion: '3' }] };
    }
    if (/^\s*insert into ehr\.diagnoses\b/i.test(sql)) return { rows: [stored] };
    return { rows: [stored] };
  });
  const repository = {
    run: jest.fn(async (_context: unknown, _patientId: unknown, _access: unknown, _event: unknown,
      operation: (client: unknown) => Promise<{ value: unknown }>) => (await operation({ query })).value),
    // executeCreate(client, context, patientId, key, operation, digest, type, create, load): a first request creates.
    executeCreate: jest.fn(async (...args: unknown[]) => (args[7] as () => Promise<unknown>)()),
    setChangeReason: jest.fn(async () => undefined),
    exists: jest.fn(async () => true),
    encounterExists: jest.fn(async () => true),
    requireOpenEncounter: jest.fn(async () => 'in_progress'),
  };
  return { query, repository, service: new DiagnosesService(repository as never) };
}

const writes = (query: jest.Mock) => query.mock.calls.map(([sql]) => String(sql))
  .filter((sql) => /^\s*(insert|update)\b/i.test(sql));

describe('DiagnosesService: a diagnosis entered in error stays entered in error', () => {
  it.each([
    ['confirm it', { verificationStatus: DiagnosisVerificationStatus.Confirmed }],
    ['mark it provisional', { verificationStatus: DiagnosisVerificationStatus.Provisional }],
    ['resolve it', { clinicalStatus: DiagnosisClinicalStatus.Resolved }],
    ['annotate it', { notes: 'Synthetic later note' }],
    ['set its abatement', { abatementAt: '2026-10-02T08:00:00.000Z' }],
  ])('refuses to %s, with 409 DIAGNOSIS_NOT_AMENDABLE and nothing written', async (_label, change) => {
    const { service, query, repository } = harness(diagnosis(DiagnosisVerificationStatus.EnteredInError));
    await expect(service.update(context, patientId, encounterId, diagnosisId,
      { ...change, expectedRowVersion: 2, changeReason: 'Synthetic attempted correction' } as never))
      .rejects.toMatchObject({ status: 409, code: 'DIAGNOSIS_NOT_AMENDABLE' });
    expect(writes(query)).toEqual([]);
    expect(repository.setChangeReason).not.toHaveBeenCalled();
    // The refusal is taken from the locked row, not from an unlocked read.
    expect(query.mock.calls.some(([sql]) => /from ehr\.diagnoses[\s\S]*for update/i.test(String(sql)))).toBe(true);
  });

  it('still marks a confirmed diagnosis entered in error', async () => {
    const { service, query } = harness(diagnosis(DiagnosisVerificationStatus.Confirmed));
    await expect(service.update(context, patientId, encounterId, diagnosisId, {
      verificationStatus: DiagnosisVerificationStatus.EnteredInError, expectedRowVersion: 2,
      changeReason: 'Recorded on the wrong patient',
    } as never)).resolves.toMatchObject({ verificationStatus: DiagnosisVerificationStatus.EnteredInError });
    expect(writes(query)).toEqual([expect.stringMatching(/^\s*update ehr\.diagnoses\b/i)]);
  });
});

describe('DiagnosesService create on a closed encounter', () => {
  it('checks under the encounter lock that it may take a record, before inserting', async () => {
    const { service, query, repository } = harness(diagnosis(DiagnosisVerificationStatus.Provisional));
    repository.requireOpenEncounter.mockRejectedValueOnce(
      new DomainProblem(409, 'ENCOUNTER_NOT_OPEN', 'The encounter is entered in error'));
    await expect(service.create(context, patientId, encounterId, {
      codeSystem: 'http://hl7.org/fhir/sid/icd-10', code: 'R50.9', display: 'Fever, unspecified',
      clinicalStatus: DiagnosisClinicalStatus.Active, verificationStatus: DiagnosisVerificationStatus.Provisional,
    } as never, 'diagnosis-key-1234')).rejects.toMatchObject({ status: 409, code: 'ENCOUNTER_NOT_OPEN' });
    expect(repository.requireOpenEncounter).toHaveBeenCalledWith(expect.anything(), encounterId, patientId,
      facilityId, 'record');
    expect(writes(query)).toEqual([]);
  });
});
