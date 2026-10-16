import { ServiceUnavailableException } from '@nestjs/common';
import type { AuditEventInput } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { ClinicalRepository } from './clinical.repository';

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const resourceId = '123e4567-e89b-42d3-a456-426614174005';
const organizationId = '123e4567-e89b-42d3-a456-426614174006';

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  authorization: 'Bearer user', actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local',
    roles: ['nurse'], permissions: ['ehr.note.write'], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId, organizationId, name: 'Clinic', roles: ['nurse'],
      permissions: ['ehr.note.write'], isPrimary: true } } } as unknown as DataAccessContext;

const event = { action: 'ehr.note.create', resourceType: 'clinical-note', resourceId,
  details: { noteType: 'progress' } };

/**
 * A repository over fakes: Identity allows unless told otherwise, the
 * transaction runs the operation and rolls back what it wrote when it throws
 * (as DatabaseService.withTransaction does), and AuditService keeps what it was
 * asked to record outside a transaction (`recorded`) and inside one
 * (`inTransaction`, cleared by the rollback).
 */
function repositoryWith({ allowed = true, auditFails = false } = {}) {
  const recorded: AuditEventInput[] = [];
  let pending: AuditEventInput[] = [];
  const committed: AuditEventInput[] = [];
  const audit = {
    record: jest.fn(async (input: AuditEventInput) => {
      if (auditFails) throw new ServiceUnavailableException('Audit persistence is unavailable; request was denied');
      recorded.push(input);
    }),
    recordWithClient: jest.fn(async (_client: unknown, input: AuditEventInput) => { pending.push(input); }),
  };
  const database = {
    withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => Promise<unknown>) => {
      pending = [];
      try {
        const result = await operation({ query: jest.fn(async () => ({ rows: [] })) });
        committed.push(...pending);
        return result;
      } finally { pending = []; }
    }),
  };
  const identity = { authorize: jest.fn(async () => ({ allowed, breakGlass: false })) };
  const repository = new ClinicalRepository(database as never, audit as never, identity as never);
  return { repository, audit, recorded, committed, database };
}

const failWith = (error: unknown) => async () => { throw error; };
const databaseError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('ClinicalRepository audits a clinical command refused inside its transaction (A17-EHR-AUDIT)', () => {
  it.each([
    ['409 ENCOUNTER_NOT_OPEN', new DomainProblem(409, 'ENCOUNTER_NOT_OPEN', 'The encounter is cancelled'), 409, 'ENCOUNTER_NOT_OPEN'],
    ['412 VERSION_CONFLICT', new DomainProblem(412, 'VERSION_CONFLICT', 'Changed since loaded'), 412, 'VERSION_CONFLICT'],
    ['a row-level security refusal (42501)', databaseError('42501', 'new row violates row-level security policy'), 403,
      'ACCESS_DENIED'],
    ['0084\'s guard (55000 ENCOUNTER_NOT_OPEN)', databaseError('55000', 'ENCOUNTER_NOT_OPEN'), 409, 'ENCOUNTER_NOT_OPEN'],
  ])('records %s as a denied semantic event after the rollback, with its status and code only', async (_label, error, status, code) => {
    const { repository, recorded, committed } = repositoryWith();
    await expect(repository.run(context, patientId, 'write_records', event, failWith(error)))
      .rejects.toMatchObject({ status, code });
    expect(committed).toEqual([]);
    expect(recorded).toEqual([{
      correlationId: context.correlationId, actorType: 'staff', actorSubject: 'staff:test', actorAccountId: accountId,
      actorMembershipId: membershipId, organizationId, facilityId, patientId, action: 'ehr.note.create',
      resourceType: 'clinical-note', resourceId, outcome: 'denied', purposeOfUse: 'direct-care',
      details: { status, code },
    }]);
  });

  it.each([
    ['400 INVALID_CLINICAL_DATA', databaseError('23514', 'check violation'), 400, 'INVALID_CLINICAL_DATA'],
    ['404 ENCOUNTER_NOT_FOUND', new DomainProblem(404, 'ENCOUNTER_NOT_FOUND', 'Encounter was not found'), 404,
      'ENCOUNTER_NOT_FOUND'],
  ])('records %s as a failed semantic event', async (_label, error, status, code) => {
    const { repository, recorded } = repositoryWith();
    await expect(repository.run(context, patientId, 'write_records', event, failWith(error)))
      .rejects.toMatchObject({ status, code });
    expect(recorded).toEqual([expect.objectContaining({ action: 'ehr.note.create', outcome: 'failure',
      details: { status, code } })]);
  });

  it('adds the refusal\'s own audit details, such as the permissions a retraction lacked', async () => {
    const refusal = Object.assign(new DomainProblem(403, 'ENCOUNTER_RETRACTION_NOT_PERMITTED', 'Not permitted'),
      { auditDetails: { missingPermissions: ['ehr.diagnosis.write'] } });
    const { repository, recorded } = repositoryWith();
    await expect(repository.run(context, patientId, 'write_records', event, failWith(refusal))).rejects.toBe(refusal);
    expect(recorded).toEqual([expect.objectContaining({ outcome: 'denied',
      details: { status: 403, code: 'ENCOUNTER_RETRACTION_NOT_PERMITTED', missingPermissions: ['ehr.diagnosis.write'] } })]);
  });

  it('records the Identity refusal once, as before', async () => {
    const { repository, recorded } = repositoryWith({ allowed: false });
    await expect(repository.run(context, patientId, 'write_records', event, failWith(new Error('not reached'))))
      .rejects.toMatchObject({ status: 403, code: 'CONSENT_REQUIRED' });
    expect(recorded).toEqual([expect.objectContaining({ outcome: 'denied',
      details: { noteType: 'progress', reason: 'identity_authorization' } })]);
  });

  it('records a missing resource once, inside its transaction, as before', async () => {
    const { repository, recorded, committed } = repositoryWith();
    await expect(repository.run(context, patientId, 'read_records', event, failWith(new Error('not reached')),
      async () => false)).rejects.toMatchObject({ status: 404, code: 'CLINICAL_RESOURCE_NOT_FOUND' });
    expect(recorded).toEqual([]);
    expect(committed).toEqual([expect.objectContaining({ outcome: 'failure',
      details: { noteType: 'progress', reason: 'not_found' } })]);
  });

  it('records nothing more for a server fault: the HTTP failure row covers it', async () => {
    const { repository, recorded } = repositoryWith();
    const fault = new Error('Connection terminated unexpectedly');
    await expect(repository.run(context, patientId, 'write_records', event, failWith(fault))).rejects.toBe(fault);
    expect(recorded).toEqual([]);
  });

  it('fails closed with 503 when the refusal cannot be audited', async () => {
    const { repository } = repositoryWith({ auditFails: true });
    await expect(repository.run(context, patientId, 'write_records', event,
      failWith(new DomainProblem(409, 'ENCOUNTER_NOT_OPEN', 'The encounter is cancelled'))))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('ClinicalRepository translates the 0090 guards', () => {
  it.each([
    [databaseError('55000', 'PRESCRIPTION_FINAL'), 409, 'PRESCRIPTION_NOT_AMENDABLE'],
    [databaseError('55000', 'INVALID_PRESCRIPTION_TRANSITION'), 409, 'INVALID_PRESCRIPTION_TRANSITION'],
    [databaseError('55000', 'LAB_REQUEST_FINAL'), 409, 'LAB_REQUEST_NOT_AMENDABLE'],
    [databaseError('55000', 'INVALID_LAB_REQUEST_TRANSITION'), 409, 'INVALID_LAB_REQUEST_TRANSITION'],
    [databaseError('55000', 'VITAL_ENTERED_IN_ERROR'), 409, 'VITAL_NOT_AMENDABLE'],
    [databaseError('42501', 'ENCOUNTER_RETRACTION_NOT_PERMITTED'), 403, 'ENCOUNTER_RETRACTION_NOT_PERMITTED'],
  ])('answers %s as %i %s', async (error, status, code) => {
    const { repository } = repositoryWith();
    await expect(repository.run(context, patientId, 'write_records', event, failWith(error)))
      .rejects.toMatchObject({ status, code });
  });
});

describe('ClinicalRepository excludes break-glass from a read that may never use it (imported history, ADR-066)', () => {
  function breakGlassRepository(breakGlass: boolean) {
    const built = repositoryWith();
    const identity = { authorize: jest.fn(async () => ({ allowed: true, breakGlass })) };
    const repository = new ClinicalRepository(built.database as never, built.audit as never, identity as never);
    return { ...built, repository, identity };
  }
  const imported = { action: 'ehr.imported-history.read', resourceType: 'imported-medical-history',
    excludeBreakGlass: { code: 'BREAK_GLASS_EXCLUDED' } };

  it('refuses a break-glass authorization with 403 and the event\'s code, audited denied, before any transaction', async () => {
    const { repository, recorded, database } = breakGlassRepository(true);
    const operation = jest.fn(async () => ({ value: 'disclosed' }));
    await expect(repository.run(context, patientId, 'read_records', imported, operation))
      .rejects.toMatchObject({ status: 403, code: 'BREAK_GLASS_EXCLUDED' });
    expect(operation).not.toHaveBeenCalled();
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(recorded).toEqual([expect.objectContaining({ action: 'ehr.imported-history.read',
      resourceType: 'imported-medical-history', outcome: 'denied', patientId,
      details: { reason: 'break_glass_excluded' } })]);
    expect(recorded).toHaveLength(1);
  });

  it('answers the code a later caller names', async () => {
    const { repository } = breakGlassRepository(true);
    await expect(repository.run(context, patientId, 'read_records',
      { ...imported, excludeBreakGlass: { code: 'RECORD_CHAT_BREAK_GLASS_NOT_SUPPORTED' } },
      async () => ({ value: 'disclosed' }))).rejects.toMatchObject({ status: 403, code: 'RECORD_CHAT_BREAK_GLASS_NOT_SUPPORTED' });
  });

  it('runs the read for a standard consent authorization', async () => {
    const { repository, committed } = breakGlassRepository(false);
    await expect(repository.run(context, patientId, 'read_records', imported, async () => ({ value: 'read' })))
      .resolves.toBe('read');
    expect(committed).toEqual([expect.objectContaining({ action: 'ehr.imported-history.read', outcome: 'success' })]);
  });

  it('refuses an event that both requires and excludes break-glass before asking Identity', async () => {
    const { repository, identity } = breakGlassRepository(true);
    await expect(repository.run(context, patientId, 'read_records', { ...imported, breakGlassOnly: true },
      async () => ({ value: 'read' }))).rejects.toThrow(/breakGlassOnly and excludeBreakGlass/);
    expect(identity.authorize).not.toHaveBeenCalled();
  });
});
