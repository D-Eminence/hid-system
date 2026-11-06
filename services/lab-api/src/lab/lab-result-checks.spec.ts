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
// Hex letters, so the upper-case spelling the case tests use is a different string.
const accountId = 'abcdef00-0000-4000-8000-00000000000a';
const colleagueId = '20000000-0000-4000-8000-000000000002';
const membershipId = '40000000-0000-4000-8000-000000000001';
const patientId = '50000000-0000-4000-8000-000000000001';
const workItemId = '60000000-0000-4000-8000-000000000001';
const executionId = '70000000-0000-4000-8000-000000000001';
const resultId = 'a0000000-0000-4000-8000-000000000001';
const context = { correlationId: 'result-check-correlation', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { id: 'actor', subject: 'staff:lab', accountId, roles: ['lab'], facilityIds: [facilityId], facilities: [],
    permissions: ['lab.execution.read', 'lab.result.enter', 'lab.result.verify', 'lab.result.release', 'lab.result.released.read'],
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
  const client = { query: jest.fn(async (sql: string, params?: unknown[]) => {
    statements.push(sql);
    if (sql.includes('lab.order_route_access_for')) return { rows: [{ outcome: 'none', route_id: null, work_item_id: workItemId }] };
    if (sql.includes('from lab.results where id=$1 for update')) return { rows: [{ id: resultId, execution_id: executionId,
      patient_id: patientId, facility_id: facilityId, current_version: '1' }] };
    // The author of the exact version being checked, and of no other.
    if (/\bfrom lab\.result_revisions\b/.test(sql) && /\bentered_by\b/.test(sql) && !/\brr\b/.test(sql)) {
      return { rows: JSON.stringify(params) === JSON.stringify([resultId, check.expectedResultVersion]) ? [{ entered_by: author }] : [] };
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
    ['another code in the same words', Object.assign(new Error('Result verifier must be independent and result must be eligible'), { code: '42501' })],
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

/**
 * Lab never said who entered a result version, so the website offered Check to the person who entered it, which the
 * database refuses (lab-release step 3). Each revision now says whether the member asking entered it, worked out from
 * the revision's author and the session; no one's id is answered.
 */
describe('Each result revision says whether the member asking entered it', () => {
  /**
   * A result whose versions were entered by the given accounts (version 1 first); the member reads its full history.
   * Entering, checking and releasing it succeed, and their answers read the same versions back.
   */
  function stored(authors: string[]) {
    const client = { query: jest.fn(async (sql: string) => {
      if (sql.includes('lab.order_route_access_for')) return { rows: [{ outcome: 'none', route_id: null, work_item_id: workItemId }] };
      if (sql.includes('select patient_id::text from lab.specimens')) return { rows: [{ patient_id: patientId }] };
      if (sql.includes('select patient_id::text from lab.results')) return { rows: [{ patient_id: patientId }] };
      if (sql.includes('select id::text from lab.results where execution_id=$1')) return { rows: [{ id: resultId }] };
      // No earlier command with this key.
      if (sql.includes('rr.idempotency_key=$3')) return { rows: [] };
      if (sql.includes('insert into lab.results(')) return { rows: [{ id: resultId }] };
      if (sql.includes('insert into lab.result_revisions(')) return { rows: [{ id: 'b0000000-0000-4000-8000-000000000001', result_id: resultId }] };
      if (sql.includes('from lab.results where id=$1 for update')) return { rows: [{ id: resultId, execution_id: executionId,
        patient_id: patientId, facility_id: facilityId, current_version: String(authors.length) }] };
      if (sql.includes('select id::text from lab.result_verifications')) return { rows: [{ id: 'c0000000-0000-4000-8000-000000000001' }] };
      if (sql.includes('from lab.results where id=$1')) return { rows: [{ id: resultId, execution_id: executionId,
        status: 'entered_unverified', current_version: String(authors.length) }] };
      if (/\bfrom lab\.result_revisions rr\b/.test(sql)) return { rows: authors.map((author, index) => ({
        id: `b0000000-0000-4000-8000-00000000000${index + 1}`, result_id: resultId, execution_id: executionId, patient_id: patientId,
        facility_id: facilityId, version: String(index + 1), result_type: 'numeric', numeric_value: String(12 + index), text_value: null,
        unit: 'g/dL', reference_range: '12.0-16.0', abnormal_flag: 'normal', entry_source: 'manual', verification_status: 'unverified',
        entered_at: new Date('2026-11-03T09:00:00Z'), entered_by: author, correction_reason: index === 0 ? null : 'Transcription error',
        request_sha256: 'a'.repeat(64), verified_at: null, released_at: null, invalidated_at: null })) };
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
    const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    return new LabExecutionsService(database, audit, new LabOrderRouteAccess(identity));
  }

  it('answers enteredByYou on every revision of the history, and no author id', async () => {
    // Version 1 entered by the member; version 2, a correction, by a colleague.
    const history = await stored([accountId, colleagueId]).getResultHistory(context, resultId);
    expect(history.revisions.map((revision) => [revision.version, (revision as { enteredByYou?: unknown }).enteredByYou]))
      .toEqual([[1, true], [2, false]]);
    const body = JSON.stringify(history);
    for (const id of [accountId, colleagueId]) expect(body).not.toContain(id);
    expect(body).not.toMatch(/"entered_?by"/i);
  });

  it('says false for every revision a colleague entered, and knows the member whatever the case of the id', async () => {
    const theirs = await stored([colleagueId]).getResultHistory(context, resultId);
    expect(theirs.revisions.map((revision) => (revision as { enteredByYou?: unknown }).enteredByYou)).toEqual([false]);
    const mine = await stored([accountId.toUpperCase()]).getResultHistory(context, resultId);
    expect(mine.revisions.map((revision) => (revision as { enteredByYou?: unknown }).enteredByYou)).toEqual([true]);
  });

  it('answers it on the result an execution read carries', async () => {
    const execution = await stored([accountId]).get(context, executionId);
    expect(execution.result?.revisions.map((revision) => (revision as { enteredByYou?: unknown }).enteredByYou)).toEqual([true]);
    expect(JSON.stringify(execution)).not.toContain(accountId);
  });

  // The read the website loads a specimen's results from, and so decides whether to offer Check.
  it('answers it on each execution of a specimen', async () => {
    const listed = await stored([accountId, colleagueId]).listForSpecimen(context, '80000000-0000-4000-8000-000000000001');
    expect(listed.items.map((item) => item.result?.revisions.map((revision) => (revision as { enteredByYou?: unknown }).enteredByYou)))
      .toEqual([[true, false]]);
    const body = JSON.stringify(listed);
    for (const id of [accountId, colleagueId]) expect(body).not.toContain(id);
  });

  it('answers it on the result the member just entered', async () => {
    const entered = await stored([accountId]).enterResult(context, executionId,
      { expectedExecutionVersion: 2, resultType: 'numeric', numericValue: 12.4 }, key);
    expect(entered.revisions.map((revision) => (revision as { enteredByYou?: unknown }).enteredByYou)).toEqual([true]);
    expect(JSON.stringify(entered)).not.toContain(accountId);
  });

  it('answers it on a check of a colleague\'s correction', async () => {
    // Version 1 entered by the member; version 2, the correction being checked, by a colleague.
    const checked = await stored([accountId, colleagueId]).verifyResult(context, resultId, { ...check, expectedResultVersion: 2 }, key);
    expect(checked.revisions.map((revision) => (revision as { enteredByYou?: unknown }).enteredByYou)).toEqual([true, false]);
  });

  it('answers it on a release by the member who entered the version', async () => {
    const releasedResult = await stored([accountId]).releaseResult(context, resultId, check, key);
    expect(releasedResult.revisions.map((revision) => (revision as { enteredByYou?: unknown }).enteredByYou)).toEqual([true]);
    expect(JSON.stringify(releasedResult)).not.toContain(accountId);
  });
});
