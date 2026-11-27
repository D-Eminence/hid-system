jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_ACTION, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import { PATIENT_MERGE_FUNCTIONS, PATIENT_MERGE_ID8B_FUNCTIONS, PATIENT_MERGE_STARTUP_SQL } from './patient-merges';
import { PatientMergesController } from './patient-merges.controller';
import {
  CANCEL_PATIENT_MERGE_SQL, decodePatientMergeCursor, encodePatientMergeCursor, LIST_PATIENT_MERGES_SQL, PATIENT_MERGE_ACTIONS, patientMergeAnswer,
  type PatientMergeItem, patientMergeProblem, READ_PATIENT_MERGE_SQL, refusalIds, REFUSE_PATIENT_MERGE_SQL,
  REQUEST_PATIENT_MERGE_SQL,
} from './patient-merges.service';

// ID-8a (0207): the pieces of the patient-merges module that need no HTTP
// stack. The database's own decisions are the suites'
// (services/ehr-api/test/database/patient-merge-requests.integration.sql and
// patient-merge-requests-migration.integration.sql).

const MIGRATION = readFileSync(join(__dirname, '../../../ehr-api/database/migrations/0207_patient_merge_requests.sql'), 'utf8');
const databaseError = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...extra });

function mergeItem(overrides: Partial<PatientMergeItem> = {}): PatientMergeItem {
  return {
    mergeId: '70000000-0000-4000-8000-000000000001', status: 'requested', version: 1,
    requestedAt: '2026-11-27T10:00:00.123456+00:00', reason: 'Identified by family at the bedside today',
    requestedByMe: true, decidedAt: null, decisionReason: null, cancelledAt: null, mergedAt: null, undoUntil: null,
    sourceStillAllowed: true,
    source: { patientId: '50000000-0000-4000-8000-000000000001', fullName: 'Unknown patient U-0007', sex: 'male',
      dateOfBirth: '1991-07-01', dateOfBirthEstimated: true, healthIdLast4: 'QX7P', ninStatus: 'not_verified',
      recordKind: 'unknown' },
    target: { fullName: 'Musa Bello', sex: 'male', dateOfBirth: '1990-03-14', healthIdLast4: 'AB12', ninStatus: 'verified',
      recordKind: 'standard' },
    targetPatientId: '50000000-0000-4000-8000-000000000009',
    moves: { visits: 2, notes: 3, vitals: 5, diagnoses: 1, prescriptions: 2, labRequests: 1, documents: 0, allergies: 0 },
    ...overrides,
  };
}

describe('ID-8a (0207): the routes', () => {
  function route(name: string) {
    const handler = (PatientMergesController.prototype as unknown as Record<string, object>)[name]!;
    return { base: Reflect.getMetadata(PATH_METADATA, PatientMergesController), path: Reflect.getMetadata(PATH_METADATA, handler),
      method: Reflect.getMetadata(METHOD_METADATA, handler), permissions: Reflect.getMetadata(REQUIRED_PERMISSIONS, handler),
      audit: Reflect.getMetadata(AUDIT_ACTION, handler) };
  }

  it('serves the contract\'s seven routes; the list and the read take their permission from the database', () => {
    expect(route('request')).toEqual({ base: 'identity/patient-merges', path: '/', method: RequestMethod.POST,
      permissions: ['identity.registration.write'], audit: 'identity.patient-merge.request.request' });
    expect(route('list')).toEqual({ base: 'identity/patient-merges', path: '/', method: RequestMethod.GET,
      permissions: undefined, audit: 'identity.patient-merge.list.request' });
    expect(route('read')).toEqual({ base: 'identity/patient-merges', path: ':mergeId', method: RequestMethod.GET,
      permissions: undefined, audit: 'identity.patient-merge.read.request' });
    expect(route('refuse')).toEqual({ base: 'identity/patient-merges', path: ':mergeId/refuse', method: RequestMethod.POST,
      permissions: ['identity.registration.approve'], audit: 'identity.patient-merge.refuse.request' });
    expect(route('cancel')).toEqual({ base: 'identity/patient-merges', path: ':mergeId/cancel', method: RequestMethod.POST,
      permissions: ['identity.registration.write'], audit: 'identity.patient-merge.cancel.request' });
    expect(route('approve')).toEqual({ base: 'identity/patient-merges', path: ':mergeId/approve', method: RequestMethod.POST,
      permissions: ['identity.registration.approve'], audit: 'identity.patient-merge.approve.request' });
    expect(route('undo')).toEqual({ base: 'identity/patient-merges', path: ':mergeId/undo', method: RequestMethod.POST,
      permissions: ['identity.registration.approve'], audit: 'identity.patient-merge.undo.request' });
  });

  it('names the contract\'s audit actions', () => {
    expect(PATIENT_MERGE_ACTIONS).toEqual({ request: 'identity.patient-merge.request', list: 'identity.patient-merge.list',
      listShown: 'identity.patient-merge.list.shown', read: 'identity.patient-merge.read',
      refuse: 'identity.patient-merge.refuse', cancel: 'identity.patient-merge.cancel',
      approve: 'identity.patient-merge.approve', undo: 'identity.patient-merge.undo' });
  });
});

describe('ID-8a (0207): the statements against the migration', () => {
  it('calls each of 0207\'s five entry points with its arguments, and checks EXECUTE on each at start-up', () => {
    const calls: [string, string, number][] = [
      [REQUEST_PATIENT_MERGE_SQL, 'identity.request_patient_merge', 5],
      [LIST_PATIENT_MERGES_SQL, 'identity.list_patient_merges', 5],
      [READ_PATIENT_MERGE_SQL, 'identity.read_patient_merge', 1],
      [REFUSE_PATIENT_MERGE_SQL, 'identity.refuse_patient_merge', 5],
      [CANCEL_PATIENT_MERGE_SQL, 'identity.cancel_patient_merge', 4],
    ];
    for (const [sql, name, count] of calls) {
      expect(sql).toContain(`${name}(`);
      expect(sql.match(/\$\d+/g)).toHaveLength(count);
      const signature = PATIENT_MERGE_FUNCTIONS.find((candidate) => candidate.startsWith(`${name}(`))!;
      expect(signature.slice(signature.indexOf('(') + 1, -1).split(',')).toHaveLength(count);
      expect(MIGRATION).toContain(`'${signature}'`);
      expect(PATIENT_MERGE_STARTUP_SQL).toContain(`to_regprocedure('${signature}')`);
    }
  });

  it('grants those five to the Identity runtime in the migration, and names no ID-8b command yet', () => {
    expect(MIGRATION).toContain("execute format('grant execute on function %s to hid_identity_runtime', v_signature);");
    expect(MIGRATION).not.toMatch(/create function identity\.(approve|undo)_patient_merge/);
    expect(PATIENT_MERGE_ID8B_FUNCTIONS).toEqual({ approve: 'approve_patient_merge', undo: 'undo_patient_merge' });
  });

  it('reads the same refusal codes the migration raises', () => {
    for (const code of ['MERGE_DENIED', 'MERGE_INVALID', 'IDEMPOTENCY_KEY_REUSED', 'PATIENT_NOT_FOUND',
      'MERGE_SOURCE_NOT_ALLOWED', 'MERGE_ALREADY_OPEN', 'MERGE_SEARCH_FIRST', 'MERGE_SAME_RECORD',
      'MERGE_TARGET_NOT_ALLOWED', 'MERGE_NOT_FOUND', 'MERGE_SECOND_PERSON_REQUIRED', 'MERGE_ALREADY_DECIDED',
      'VERSION_CONFLICT']) {
      expect(MIGRATION).toContain(`'${code}'`);
    }
    expect(MIGRATION).toContain('patient_merges_one_open_per_source_ux');
  });
});

describe('ID-8a (0207): the answer', () => {
  it('answers the contract\'s shape and never the target\'s patient id', () => {
    const answer = patientMergeAnswer(mergeItem());
    expect(answer).toEqual({
      mergeId: '70000000-0000-4000-8000-000000000001', status: 'requested', version: 1,
      requestedAt: '2026-11-27T10:00:00.123Z', reason: 'Identified by family at the bedside today', requestedByMe: true,
      sourceStillAllowed: true, decidedAt: null, decisionReason: null, cancelledAt: null,
      source: { patientId: '50000000-0000-4000-8000-000000000001', fullName: 'Unknown patient U-0007', sex: 'male',
        dateOfBirth: '1991-07-01', dateOfBirthEstimated: true, healthIdLast4: 'QX7P', ninStatus: 'not_verified',
        recordKind: 'unknown' },
      target: { fullName: 'Musa Bello', sex: 'male', dateOfBirth: '1990-03-14', healthIdLast4: 'AB12', ninStatus: 'verified',
        recordKind: 'standard' },
      moves: { visits: 2, notes: 3, vitals: 5, diagnoses: 1, prescriptions: 2, labRequests: 1, documents: 0, allergies: 0 },
    });
    expect(JSON.stringify(answer)).not.toContain('50000000-0000-4000-8000-000000000009');
    expect(answer).not.toHaveProperty('undoUntil');
  });

  it('answers undoUntil only once merged (ID-8b), and sourceStillAllowed only while requested', () => {
    const merged = patientMergeAnswer(mergeItem({ status: 'merged', mergedAt: '2026-11-28T10:00:00+00:00',
      undoUntil: '2026-12-28T10:00:00+00:00', sourceStillAllowed: null }));
    expect(merged).toMatchObject({ mergedAt: '2026-11-28T10:00:00.000Z', undoUntil: '2026-12-28T10:00:00.000Z',
      sourceStillAllowed: null });
    expect(patientMergeAnswer(mergeItem({ status: 'refused', sourceStillAllowed: null })).sourceStillAllowed).toBeNull();
    expect(patientMergeAnswer(mergeItem({ sourceStillAllowed: false })).sourceStillAllowed).toBe(false);
    // The status decides, whatever the item carries.
    for (const status of ['refused', 'cancelled', 'merged', 'undone'] as const) {
      expect(patientMergeAnswer(mergeItem({ status, sourceStillAllowed: true })).sourceStillAllowed).toBeNull();
    }
  });

  it('pages by the request time to the microsecond and the merge id', () => {
    const cursor = encodePatientMergeCursor('2026-11-27T10:00:00.123456+00:00', '70000000-0000-4000-8000-000000000001');
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
      .toEqual({ c: '2026-11-27T10:00:00.123456+00:00', m: '70000000-0000-4000-8000-000000000001' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{16,200}$/);
    expect(decodePatientMergeCursor(cursor)).toEqual({ requestedAt: '2026-11-27T10:00:00.123456+00:00',
      mergeId: '70000000-0000-4000-8000-000000000001' });
    expect(decodePatientMergeCursor(encodePatientMergeCursor('2026-11-27T10:00:00Z', '70000000-0000-4000-8000-000000000001')))
      .toEqual({ requestedAt: '2026-11-27T10:00:00Z', mergeId: '70000000-0000-4000-8000-000000000001' });
    expect(decodePatientMergeCursor(undefined)).toBeNull();
  });

  it('refuses a cursor PostgreSQL would not take as (timestamptz, uuid): 400, never the database', () => {
    const id = '70000000-0000-4000-8000-000000000001';
    for (const [c, m] of [['2026', id], ['27 November 2026', id], ['2026-11-27 10:00:00+00', id], ['2026-11-27T10:00:00', id],
      ['2026-11-27T10:00:00.1234567+00:00', id], ['2026-02-29T10:00:00+00:00', id], ['2026-04-31T10:00:00+00:00', id],
      ['2026-11-27T10:00:00+16:00', id], ['2026-11-27T10:00:00+00:00', '-'.repeat(36)],
      ['2026-11-27T10:00:00+00:00', `${id.slice(0, 35)}z`], ['2026-11-27T10:00:00+00:00', 7]] as const) {
      const cursor = Buffer.from(JSON.stringify({ c, m }), 'utf8').toString('base64url');
      expect(() => decodePatientMergeCursor(cursor)).toThrow(DomainProblem);
    }
    expect(decodePatientMergeCursor(encodePatientMergeCursor('2028-02-29T10:00:00+01:00', id))?.requestedAt)
      .toBe('2028-02-29T10:00:00+01:00');
  });
});

describe('ID-8a (0207): the refusals', () => {
  it.each([
    ['42501', 'MERGE_DENIED', 403, 'PERMISSION_DENIED'],
    ['22023', 'MERGE_INVALID', 400, 'VALIDATION_FAILED'],
    ['23505', 'IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['P0001', 'PATIENT_NOT_FOUND', 404, 'PATIENT_NOT_FOUND'],
    ['P0001', 'MERGE_SOURCE_NOT_ALLOWED', 409, 'MERGE_SOURCE_NOT_ALLOWED'],
    ['P0001', 'MERGE_ALREADY_OPEN', 409, 'MERGE_ALREADY_OPEN'],
    ['42501', 'MERGE_SEARCH_FIRST', 403, 'MERGE_SEARCH_FIRST'],
    ['P0001', 'MERGE_SAME_RECORD', 409, 'MERGE_SAME_RECORD'],
    ['P0001', 'MERGE_TARGET_NOT_ALLOWED', 409, 'MERGE_TARGET_NOT_ALLOWED'],
    ['P0001', 'MERGE_NOT_FOUND', 404, 'MERGE_NOT_FOUND'],
    ['42501', 'MERGE_SECOND_PERSON_REQUIRED', 403, 'MERGE_SECOND_PERSON_REQUIRED'],
    ['P0001', 'MERGE_ALREADY_DECIDED', 409, 'MERGE_ALREADY_DECIDED'],
    ['40001', 'VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
  ])('%s %s is %i %s', (code, message, status, problemCode) => {
    const problem = patientMergeProblem(databaseError(code, message));
    expect(problem).toBeInstanceOf(DomainProblem);
    expect([(problem as DomainProblem).getStatus(), (problem as DomainProblem).code]).toEqual([status, problemCode]);
  });

  it('answers the contract\'s words', () => {
    const words = (code: string, message: string) => ((patientMergeProblem(databaseError(code, message)) as DomainProblem)
      .getResponse());
    expect(words('42501', 'MERGE_SECOND_PERSON_REQUIRED')).toBe('Another approver must approve this. You asked for this merge.');
    expect(words('42501', 'MERGE_SEARCH_FIRST'))
      .toBe('Search for the right record first, then ask to merge. A search result can be used for 10 minutes.');
    expect(words('P0001', 'MERGE_NOT_FOUND')).toBe('No merge request of this facility matches.');
    expect(words('P0001', 'MERGE_SOURCE_NOT_ALLOWED'))
      .toBe('Only an unknown or NIN Not Verified record that nobody signs in to can be merged into another.');
    expect(words('40001', 'VERSION_CONFLICT')).toBe('Someone else changed this merge request. Reload it and try again.');
  });

  it('answers the one-open-request index in a race MERGE_ALREADY_OPEN; anything else from the database 503', () => {
    const race = patientMergeProblem(databaseError('23505', 'duplicate key value violates unique constraint',
      { constraint: 'patient_merges_one_open_per_source_ux' })) as DomainProblem;
    expect([race.getStatus(), race.code]).toEqual([409, 'MERGE_ALREADY_OPEN']);
    for (const error of [databaseError('42883', 'function identity.request_patient_merge does not exist'),
      databaseError('42P01', 'relation does not exist'), databaseError('40001', 'could not serialize access'),
      databaseError('23505', 'duplicate key value', { constraint: 'patient_merges_pkey' }),
      databaseError('P0001', 'SOMETHING_ELSE')]) {
      const problem = patientMergeProblem(error) as DomainProblem;
      expect([problem.getStatus(), problem.code]).toEqual([503, 'MERGE_UNAVAILABLE']);
    }
    const plain = new Error('not a database error');
    expect(patientMergeProblem(plain)).toBe(plain);
  });

  it('reads the ids from a refusal\'s DETAIL only when they are uuids', () => {
    expect(refusalIds(databaseError('P0001', 'MERGE_ALREADY_DECIDED', { detail: JSON.stringify({
      mergeId: '70000000-0000-4000-8000-000000000001', sourcePatientId: '50000000-0000-4000-8000-000000000001',
      targetPatientId: '50000000-0000-4000-8000-000000000009' }) }))).toEqual({
      mergeId: '70000000-0000-4000-8000-000000000001', sourcePatientId: '50000000-0000-4000-8000-000000000001',
      targetPatientId: '50000000-0000-4000-8000-000000000009' });
    expect(refusalIds(databaseError('P0001', 'PATIENT_NOT_FOUND', { detail: '{}' }))).toEqual({});
    expect(refusalIds(databaseError('P0001', 'X', { detail: 'not json' }))).toEqual({});
    expect(refusalIds(databaseError('P0001', 'X', { detail: JSON.stringify({ mergeId: 'Musa Bello' }) }))).toEqual({});
    expect(refusalIds(new Error('plain'))).toEqual({});
  });
});
