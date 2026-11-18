import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { LabAccessionsService } from './lab-accessions.service';
import { LabExecutionsService } from './lab-executions.service';
import { LabWorkItemsService } from './lab-work-items.service';
import { LabOrderRouteAccess } from './order-route-access';
import { LabOrderRouteCards } from './order-route-cards';
import { LabOwnWork } from './own-work-access';
import { OWN_WORK_PATIENT_CARDS_OFF } from './own-work-patient-cards';

/*
 * Every Lab command on this facility's own work item or its chain (0133,
 * contract ORD-2: "lab: read, accession, specimen, execution, result") goes
 * on the own-work basis for the facility's lab staff without a personal
 * grant: the order-route check (C11) answers `none`, lab.own_work_access_for
 * answers the own work item, Identity is never asked (it would refuse here),
 * and the command's audit row carries `basis: 'own-work'`. Without a row from
 * lab.own_work_access_for the same command falls back to Identity and is
 * refused as before.
 */

const facilityId = '10000000-0000-4000-8000-000000000001';
const patientId = '50000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000001';
const otherAccount = '20000000-0000-4000-8000-000000000002';
const workItemId = '60000000-0000-4000-8000-000000000001';
const accessionId = '70000000-0000-4000-8000-000000000001';
const specimenId = '80000000-0000-4000-8000-000000000001';
const executionId = '90000000-0000-4000-8000-000000000001';
const resultId = 'a0000000-0000-4000-8000-000000000001';
const testId = 'b0000000-0000-4000-8000-000000000001';
const ehrOrderId = 'c0000000-0000-4000-8000-000000000001';
const permissions = ['lab.work-item.read', 'lab.accession.create', 'lab.accession.read', 'lab.specimen.collect',
  'lab.specimen.receive', 'lab.specimen.reject', 'lab.execution.start', 'lab.execution.read', 'lab.execution.complete',
  'lab.result.enter', 'lab.result.correct', 'lab.result.verify', 'lab.result.release', 'lab.result.released.read',
  'lab.order-route.receive'];
const scientist = { correlationId: 'own-lab-commands-correlation', facilityId,
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care', actor: { id: 'actor',
    subject: 'staff:lab', accountId, roles: ['lab'], permissions, facilityIds: [facilityId], facilities: [],
    authenticationMethod: 'local' } } satisfies DataAccessContext;

const OWN_ACCESS = /from lab\.own_work_access_for\(\$1, \$2::uuid, \$3\)/;
const at = '2026-11-18T10:00:00Z';
const key = 'own-lab-command-key-0001';

const workItem = { id: workItemId, patient_id: patientId, facility_id: facilityId, ordering_facility_id: facilityId,
  source_ehr_order_id: ehrOrderId, source_ehr_order_version: '1', source_encounter_id: ehrOrderId, status: 'accepted',
  priority: 'routine', accepted_by: otherAccount, accepted_at: new Date(at), row_version: '1', created_at: new Date(at),
  test_code_system: 'http://loinc.org', test_code: '718-7', test_name: 'Haemoglobin', order_route_id: null };
const accession = { id: accessionId, accession_number: 'LAB-0001', work_item_id: workItemId, patient_id: patientId,
  facility_id: facilityId, status: 'accessioned', priority: 'routine', row_version: '1', created_at: new Date(at),
  request_sha256: 'x' };
const specimen = (status: string, version: string) => ({ id: specimenId, specimen_identifier: 'SPEC-0001',
  requirement_id: testId, accession_id: accessionId, patient_id: patientId, facility_id: facilityId, specimen_type: 'blood',
  container_type: null, status, collected_at: null, received_at: null, rejected_at: null, rejection_reason: null,
  row_version: version });
const execution = (status: 'in_progress' | 'completed', version: string) => ({ id: executionId, accession_id: accessionId,
  specimen_id: specimenId, requested_test_id: testId, patient_id: patientId, facility_id: facilityId, status,
  method: null, started_at: new Date(at), completed_at: status === 'completed' ? new Date(at) : null, row_version: version,
  idempotency_key: 'k', request_sha256: 'x', completed_idempotency_key: null, completed_request_sha256: null,
  test_name: 'Haemoglobin', test_code: '718-7', test_code_system: 'http://loinc.org' });
const revision = { id: 'd0000000-0000-4000-8000-000000000001', result_id: resultId, execution_id: executionId,
  patient_id: patientId, facility_id: facilityId, version: '1', result_type: 'numeric', numeric_value: '13.1',
  text_value: null, unit: 'g/dL', reference_range: '12-16', abnormal_flag: 'normal', entry_source: 'manual',
  verification_status: 'unverified', entered_at: new Date(at), correction_reason: null, request_sha256: 'x',
  entered_by: otherAccount, verified_at: null, released_at: null, invalidated_at: null };

/** Each command's rows, as the database would answer them for an own work item; `own` is D9's answer. */
function harness(options: { own?: boolean; executionStatus?: 'in_progress' | 'completed' } = {}) {
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  const answer = (sql: string): unknown[] => {
    if (sql.includes('lab.order_route_access_for')) return [{ outcome: 'none', route_id: null, work_item_id: workItemId }];
    if (OWN_ACCESS.test(sql)) return options.own === false ? [] : [{ work_item_id: workItemId }];
    if (/from lab\.work_items/.test(sql)) return [workItem];
    if (/from lab\.accessions\s+where work_item_id=\$1/.test(sql)) return [];
    if (/from lab\.accessions where id=\$1/.test(sql)) return [accession];
    if (/insert into lab\.accessions/.test(sql)) return [accession];
    if (/insert into lab\.specimens\(/.test(sql)) return [specimen('required', '1')];
    if (/from lab\.specimens s join lab\.accessions a/.test(sql)) return [{ id: specimenId, accession_id: accessionId,
      patient_id: patientId, facility_id: facilityId, status: 'received', row_version: '3', work_item_id: workItemId }];
    if (/from lab\.specimens\s+where id=\$1 and accession_id=\$2 for update/.test(sql)) return [specimen('required', '1')];
    if (/update lab\.specimens set/.test(sql)) return [specimen('collected', '2')];
    if (/select patient_id::text from lab\.specimens where id=\$1/.test(sql)) return [{ patient_id: patientId }];
    if (/from lab\.specimens where accession_id=\$1/.test(sql)) return [specimen('required', '1')];
    if (/from lab\.test_executions e join lab\.work_item_requested_tests t[\s\S]*where e\.specimen_id=\$1 or/.test(sql)) return [];
    if (/from lab\.test_executions e join lab\.work_item_requested_tests t[\s\S]*where e\.specimen_id=\$1 and/.test(sql)) {
      return [execution('completed', '2')];
    }
    if (/from lab\.test_executions e join lab\.work_item_requested_tests t[\s\S]*where e\.id=\$1/.test(sql)) {
      return [execution(options.executionStatus ?? 'completed', options.executionStatus === 'in_progress' ? '1' : '2')];
    }
    if (/select id::text from lab\.work_item_requested_tests where work_item_id=\$1/.test(sql)) return [{ id: testId }];
    if (/insert into lab\.test_executions/.test(sql)) return [execution('in_progress', '1')];
    if (/update lab\.test_executions/.test(sql)) return [{ id: executionId }];
    if (/select id::text from lab\.results where execution_id=\$1/.test(sql)) return [];
    if (/insert into lab\.results\(/.test(sql)) return [{ id: resultId }];
    if (/update lab\.results set current_version/.test(sql)) return [{ current_version: '2' }];
    if (/insert into lab\.result_revisions/.test(sql)) return [revision];
    if (/from lab\.results where id=\$1 for update/.test(sql)) return [{ id: resultId, execution_id: executionId,
      patient_id: patientId, facility_id: facilityId, current_version: '1' }];
    if (/select entered_by::text from lab\.result_revisions/.test(sql)) return [{ entered_by: otherAccount }];
    if (/from lab\.result_verifications where result_id=\$1 and result_version=\$2/.test(sql)) {
      return [{ id: 'e0000000-0000-4000-8000-000000000001' }];
    }
    if (/select patient_id::text from lab\.results where id=\$1/.test(sql)) return [{ patient_id: patientId }];
    if (/from lab\.results where id=\$1/.test(sql)) return [{ id: resultId, execution_id: executionId,
      status: 'entered', current_version: '1' }];
    if (/from lab\.result_revisions rr left join/.test(sql)) return [revision];
    if (/select r\.id::text from lab\.results r join lab\.test_executions/.test(sql)) return [{ id: resultId }];
    return [];
  };
  const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    statements.push({ sql, values });
    return { rows: answer(sql) };
  }) };
  const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) =>
    fn(client as unknown as PoolClient), query: jest.fn().mockRejectedValue(new Error('no pool here')) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: false, breakGlass: false }) } as unknown as
    IdentityService & { authorize: jest.Mock };
  const audits: { action: string; details?: Record<string, unknown> }[] = [];
  const audit = { recordWithClient: jest.fn(async (_c: unknown, event: { action: string; details?: Record<string, unknown> }) => {
    audits.push(event);
  }) } as unknown as AuditService;
  const routeAccess = new LabOrderRouteAccess(identity, new LabOwnWork(true));
  const workItems = new LabWorkItemsService(database, identity, audit, routeAccess, new LabOrderRouteCards(database),
    OWN_WORK_PATIENT_CARDS_OFF, new LabOwnWork(true));
  const accessions = new LabAccessionsService(database, audit, routeAccess);
  const executions = new LabExecutionsService(database, audit, routeAccess);
  const asked = () => statements.filter((statement) => OWN_ACCESS.test(statement.sql)).map((statement) => statement.values);
  return { workItems, accessions, executions, identity, audits, asked };
}

type Harness = ReturnType<typeof harness>;
/** Each command, the resource and action it asks D9 about, its audit action (none: it records none, as before). */
const COMMANDS: [string, 'work_item' | 'accession' | 'specimen' | 'execution' | 'result', string,
  'read_records' | 'write_records', string | null, 'in_progress' | 'completed', (h: Harness) => Promise<unknown>][] = [
  ['read the work item', 'work_item', workItemId, 'read_records', 'lab.work-item.read', 'completed',
    (h) => h.workItems.get(scientist, workItemId)],
  ['accession it', 'work_item', workItemId, 'write_records', 'lab.accession.create', 'completed',
    (h) => h.accessions.create(scientist, workItemId, { requirements: [{ specimenType: 'blood' }], reason: 'Accessioned' }, key)],
  ['read the accession', 'accession', accessionId, 'read_records', 'lab.accession.read', 'completed',
    (h) => h.accessions.get(scientist, accessionId)],
  ['list the accession\'s specimens', 'accession', accessionId, 'read_records', 'lab.accession.read', 'completed',
    (h) => h.accessions.listSpecimens(scientist, accessionId)],
  ['collect a specimen', 'specimen', specimenId, 'write_records', 'lab.specimen.collect', 'completed',
    (h) => h.accessions.collect(scientist, accessionId, specimenId, { expectedVersion: 1, collectedAt: at }, key)],
  ['receive a specimen', 'specimen', specimenId, 'write_records', 'lab.specimen.receive', 'completed',
    (h) => h.accessions.receive(scientist, accessionId, specimenId, { expectedVersion: 1, receivedAt: at }, key)],
  ['reject a specimen', 'specimen', specimenId, 'write_records', 'lab.specimen.reject', 'completed',
    (h) => h.accessions.reject(scientist, accessionId, specimenId, { expectedVersion: 1, reason: 'Haemolysed sample' }, key)],
  ['start an execution', 'specimen', specimenId, 'write_records', 'lab.execution.start', 'completed',
    (h) => h.executions.start(scientist, specimenId, { expectedSpecimenVersion: 3, startedAt: at, reason: 'Started' }, key)],
  ['list a specimen\'s executions', 'specimen', specimenId, 'read_records', null, 'completed',
    (h) => h.executions.listForSpecimen(scientist, specimenId)],
  ['read an execution', 'execution', executionId, 'read_records', null, 'completed',
    (h) => h.executions.get(scientist, executionId)],
  ['complete an execution', 'execution', executionId, 'write_records', 'lab.execution.complete', 'in_progress',
    (h) => h.executions.complete(scientist, executionId, { expectedVersion: 1, completedAt: at }, key)],
  ['enter a result', 'execution', executionId, 'write_records', 'lab.result.enter', 'completed',
    (h) => h.executions.enterResult(scientist, executionId, { expectedExecutionVersion: 2, resultType: 'numeric',
      numericValue: 13.1, unit: 'g/dL' }, key)],
  ['correct a result', 'execution', executionId, 'write_records', 'lab.result.correct', 'completed',
    (h) => h.executions.correctResult(scientist, executionId, resultId, { expectedExecutionVersion: 2,
      resultType: 'numeric', numericValue: 12.9, unit: 'g/dL', expectedResultVersion: 1, reason: 'Recalibrated' }, key)],
  ['verify a result', 'result', resultId, 'write_records', 'lab.result.verify', 'completed',
    (h) => h.executions.verifyResult(scientist, resultId, { expectedResultVersion: 1, occurredAt: at, reason: 'Checked' }, key)],
  ['release a result', 'result', resultId, 'write_records', 'lab.result.release', 'completed',
    (h) => h.executions.releaseResult(scientist, resultId, { expectedResultVersion: 1, occurredAt: at, reason: 'Released' }, key)],
  ['read a result\'s history', 'result', resultId, 'read_records', 'lab.result.history.read', 'completed',
    (h) => h.executions.getResultHistory(scientist, resultId)],
  ['read the released results of an EHR order', 'work_item', workItemId, 'read_records', 'lab.result.released.read',
    'completed', (h) => h.executions.listReleasedForEhrOrder(scientist, ehrOrderId)],
];

describe('every Lab command on an own work item goes on the own-work basis (0133)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it.each(COMMANDS)('%s: asks D9 about its %s, never Identity, and audits basis own-work',
    async (_name, resource, resourceId, action, audited, executionStatus, call) => {
      const h = harness({ executionStatus });
      await expect(call(h)).resolves.toBeDefined();
      expect(h.asked()).toEqual([[resource, resourceId, action]]);
      expect(h.identity.authorize).not.toHaveBeenCalled();
      if (audited) {
        expect(h.audits.map((event) => event.action)).toEqual([audited]);
        expect(h.audits[0]?.details).toMatchObject({ basis: 'own-work' });
      } else {
        expect(h.audits).toEqual([]);
      }
    });

  it.each(COMMANDS)('%s: without D9\'s row asks Identity as before, and is refused', async (...[, , , action, , status, call]) => {
    const h = harness({ own: false, executionStatus: status });
    await expect(call(h)).rejects.toMatchObject({ status: 403 });
    expect(h.identity.authorize).toHaveBeenCalledWith(patientId, action, 'direct-care', scientist);
    expect(h.audits).toEqual([]);
  });
});
