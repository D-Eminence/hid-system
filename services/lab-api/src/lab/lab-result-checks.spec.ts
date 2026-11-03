import { Logger, type ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { LabExecutionsService } from './lab-executions.service';
import { LabOrderRouteAccess } from './order-route-access';

// Checking (verifying) a Lab result, by the person who entered it and by someone else. The database keeps the rule
// that the checker of a result version is not the person who entered it (lab.validate_result_governance, 0021, 0077).
const facilityId = '10000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000001';
const colleagueId = '20000000-0000-4000-8000-000000000002';
const membershipId = '40000000-0000-4000-8000-000000000001';
const patientId = '50000000-0000-4000-8000-000000000001';
const workItemId = '60000000-0000-4000-8000-000000000001';
const executionId = '70000000-0000-4000-8000-000000000001';
const resultId = 'a0000000-0000-4000-8000-000000000001';
const context = { correlationId: 'result-check-correlation', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { id: 'actor', subject: 'staff:lab', accountId, roles: ['lab'], facilityIds: [facilityId], facilities: [],
    permissions: ['lab.execution.read', 'lab.result.enter', 'lab.result.verify', 'lab.result.release'],
    authenticationMethod: 'local' } } satisfies DataAccessContext;
const check = { expectedResultVersion: 1, occurredAt: '2026-11-03T10:00:00Z', reason: 'Checked against the analyser print' };
const key = 'result-check-key-0001';

/** The database's refusal of a check, as node-postgres reports it (0077 words both of its cases alike). */
const refusal = (message = 'Result verifier must be independent and result must be eligible') =>
  Object.assign(new Error(message), { code: '23514', schema: 'lab', table: 'result_verifications' });

/**
 * A fake database holding version 1 of one result, entered by `author`. The check insert fails with `refused` when
 * given, as the database's guard does; otherwise it succeeds.
 */
function harness(author: string, refused?: Error) {
  const statements: string[] = [];
  const client = { query: jest.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes('lab.order_route_access_for')) return { rows: [{ outcome: 'none', route_id: null, work_item_id: workItemId }] };
    if (sql.includes('from lab.results where id=$1 for update')) return { rows: [{ id: resultId, execution_id: executionId,
      patient_id: patientId, facility_id: facilityId, current_version: '1' }] };
    if (/\bfrom lab\.result_revisions\b/.test(sql) && /\bentered_by\b/.test(sql) && !/\brr\b/.test(sql)) {
      return { rows: [{ entered_by: author }] };
    }
    if (sql.includes('insert into lab.result_verifications') && refused) throw refused;
    if (sql.includes('from lab.test_executions e')) return { rows: [{ id: executionId, accession_id: workItemId,
      specimen_id: workItemId, requested_test_id: workItemId, patient_id: patientId, facility_id: facilityId,
      status: 'completed', method: null, started_at: new Date(), completed_at: new Date(), row_version: '2',
      idempotency_key: 'k', request_sha256: 'x', completed_idempotency_key: null, completed_request_sha256: null,
      test_name: 'Haemoglobin', test_code: '718-7', test_code_system: 'http://loinc.org' }] };
    return { rows: [] };
  }) };
  const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) =>
    fn(client as unknown as PoolClient) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) } as unknown as IdentityService;
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
  const service = new LabExecutionsService(database, audit as unknown as AuditService, new LabOrderRouteAccess(identity));
  return { service, statements, audit };
}

/** What the problem filter sends for an error. */
function answer(exception: unknown) {
  const request = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ', method: 'POST',
    route: { path: '/lab/results/:resultId/verify' } } as unknown as HidRequest;
  const response = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis() } as unknown as Response;
  const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(exception, host);
  return (response.json as jest.Mock).mock.calls[0]?.[0] as { status: number; code: string; detail: string };
}

describe('LabExecutionsService.verifyResult by the person who entered the result', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // The database refused the check and Lab answered 500 'The service could not complete the request.', so the
  // website told the person who entered the result to try again, forever (lab-release step 3, handoff A12).
  it('answers the database refusal 409 LAB_RESULT_VERIFIER_NOT_INDEPENDENT in plain words, keeping it as the cause', async () => {
    const refused = refusal();
    const { service, statements, audit } = harness(accountId, refused);
    const problem = await service.verifyResult(context, resultId, check, key).catch((error: unknown) => error);
    expect(problem).toBeInstanceOf(DomainProblem);
    expect(problem).toMatchObject({ status: 409, code: 'LAB_RESULT_VERIFIER_NOT_INDEPENDENT',
      message: 'You entered this result, so someone else at your lab must check it.' });
    expect((problem as DomainProblem).cause).toBe(refused);
    // Nothing after the refused insert: no outbox event, no audit row.
    expect(statements.filter((sql) => /insert into lab\.outbox_events\b/.test(sql))).toEqual([]);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
    const answered = answer(problem);
    expect(answered).toMatchObject({ status: 409, code: 'LAB_RESULT_VERIFIER_NOT_INDEPENDENT',
      detail: 'You entered this result, so someone else at your lab must check it.' });
    for (const text of [refused.message, '23514', 'result_verifications', accountId]) {
      expect(JSON.stringify(answered)).not.toContain(text);
    }
  });

  it('knows the member by account id whatever its case', async () => {
    const { service } = harness(accountId.toUpperCase(), refusal());
    await expect(service.verifyResult(context, resultId, check, key))
      .rejects.toMatchObject({ status: 409, code: 'LAB_RESULT_VERIFIER_NOT_INDEPENDENT' });
  });

  // The database refuses a check of a version marked entered in error in the same words. That is not this member's
  // own entry, so it is not answered as one: it stays the error it was (500), as before.
  it('passes the same refusal on unchanged when someone else entered the version', async () => {
    const refused = refusal();
    const { service } = harness(colleagueId, refused);
    await expect(service.verifyResult(context, resultId, check, key)).rejects.toBe(refused);
    expect(answer(refused)).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });

  it.each([
    ['another 23514 of the check', refusal('Governance command must bind the exact current result version')],
    ['a 42501 of the check', Object.assign(new Error('Verifier must match authenticated database context'), { code: '42501' })],
  ])('passes %s on unchanged, even for the member who entered it', async (_label, refused) => {
    const { service } = harness(accountId, refused);
    await expect(service.verifyResult(context, resultId, check, key)).rejects.toBe(refused);
  });

  it('records a check by someone else, as before', async () => {
    const { service, statements, audit } = harness(colleagueId);
    await expect(service.verifyResult(context, resultId, check, key)).resolves.toBeDefined();
    expect(statements.filter((sql) => sql.includes('insert into lab.result_verifications'))).toHaveLength(1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'lab.result.verify' }));
  });

  it('reads no author for a release', async () => {
    const { service, statements } = harness(accountId);
    await service.releaseResult(context, resultId, check, key).catch(() => undefined);
    expect(statements.filter((sql) => /\bentered_by\b/.test(sql) && !/\brr\b/.test(sql))).toEqual([]);
  });
});
