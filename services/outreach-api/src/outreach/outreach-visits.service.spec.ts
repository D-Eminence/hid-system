import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { OutreachVisitsService } from './outreach-visits.service';

const ids = {
  facility: '123e4567-e89b-42d3-a456-426614174001',
  account: '123e4567-e89b-42d3-a456-426614174002',
  membership: '123e4567-e89b-42d3-a456-426614174003',
  case: '123e4567-e89b-42d3-a456-426614174004',
  patient: '123e4567-e89b-42d3-a456-426614174005',
  visit: '123e4567-e89b-42d3-a456-426614174006',
};
const context: DataAccessContext = {
  correlationId: 'correlation-12345678', facilityId: ids.facility, membershipId: ids.membership,
  purposeOfUse: 'direct-care', userCookie: 'hid_session=opaque', csrfToken: 'csrf',
  origin: 'http://localhost:3000', actor: {
    id: 'staff:test', subject: 'staff:test', accountId: ids.account, authenticationMethod: 'local',
    roles: ['nurse'], permissions: ['outreach.registration.write'], facilityIds: [ids.facility],
    facilities: [], facility: { id: ids.facility, membershipId: ids.membership,
      organizationId: ids.facility, name: 'Test', roles: ['nurse'],
      permissions: ['outreach.registration.write'], isPrimary: true },
  },
};
const pendingCase = { id: ids.case, status: 'identity_resolution_pending', resolved_patient_id: null, row_version: '1' };
const input = { kind: 'visit' as const, occurredOn: '2026-10-30', followUpOn: '2026-11-20',
  referredTo: null, notes: 'Blood pressure checked.' };
const digest = requestDigest('outreach.registration-case.visit.create', { caseId: ids.case, ...input });
const visitRow = { id: ids.visit, registration_case_id: ids.case, kind: 'visit', occurred_on: '2026-10-30',
  follow_up_on: '2026-11-20', referred_to: null, notes: 'Blood pressure checked.',
  recorded_by_membership_id: ids.membership, request_sha256: digest, created_at: new Date('2026-10-30T10:00:00Z') };

function setup(query: jest.Mock) {
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown, _options?: unknown) => operation({ query })) };
  const audit = { recordWithClient: jest.fn() };
  const identity = { lookupByHealthId: jest.fn(), canLinkPatient: jest.fn() };
  return { database, audit, identity,
    service: new OutreachVisitsService(database as never, audit as never, identity as never) };
}

const refuse = (error: Error) => setup(jest.fn().mockResolvedValueOnce({ rows: [pendingCase] })
  .mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(error)).service;

describe('OutreachVisitsService visits', () => {
  it('records a visit with a digest of its named fields and an ids-only audit row', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [pendingCase] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [visitRow] });
    const { service, audit, database } = setup(query);
    await expect(service.create(ids.case, input, 'visit-key-12345678', context)).resolves.toEqual({ visit: {
      id: ids.visit, registrationCaseId: ids.case, kind: 'visit', occurredOn: '2026-10-30', followUpOn: '2026-11-20',
      referredTo: null, notes: 'Blood pressure checked.', recordedByMembershipId: ids.membership,
      createdAt: '2026-10-30T10:00:00.000Z' } });
    expect(query.mock.calls[0][1]).toEqual([ids.case, ids.facility]);
    expect(query.mock.calls[2][0]).toContain('insert into outreach.registration_case_visits');
    expect(query.mock.calls[2][1]).toEqual([ids.case, ids.facility, 'visit', '2026-10-30', '2026-11-20', null,
      'Blood pressure checked.', ids.account, ids.membership, 'visit-key-12345678', digest]);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context,
      'outreach.registration-case.visit.create', ids.case, undefined);
    expect((database.withTransaction.mock.calls[0] as unknown[])[2]).toEqual({ isolationLevel: 'SERIALIZABLE' });
  });

  it('replays an identical request without a second row or audit', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [pendingCase] }).mockResolvedValueOnce({ rows: [visitRow] });
    const { service, audit } = setup(query);
    await expect(service.create(ids.case, { ...input }, 'visit-key-12345678', context))
      .resolves.toMatchObject({ visit: { id: ids.visit } });
    expect(query).toHaveBeenCalledTimes(2);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('answers 409 IDEMPOTENCY_CONFLICT when the key was used for a different visit', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [pendingCase] }).mockResolvedValueOnce({ rows: [visitRow] });
    await expect(setup(query).service.create(ids.case, { ...input, notes: 'Different notes' }, 'visit-key-12345678', context))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('answers 404 OUTREACH_REGISTRATION_NOT_FOUND for a case the member cannot see', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const { service, audit } = setup(query);
    await expect(service.create(ids.case, input, 'visit-key-12345678', context))
      .rejects.toMatchObject({ status: 404, code: 'OUTREACH_REGISTRATION_NOT_FOUND' });
    await expect(service.list(ids.case, context)).rejects.toMatchObject({ status: 404 });
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('answers the database\'s Lagos date refusal as 400 and a remaining duplicate as 409', async () => {
    const dateRefusal = Object.assign(new Error('date'), { code: '23514' });
    const duplicate = Object.assign(new Error('dup'), { code: '23505' });
    await expect(refuse(dateRefusal).create(ids.case, input, 'visit-key-12345678', context))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED', errors: [{ field: 'occurredOn',
        messages: ['occurredOn must be a date (YYYY-MM-DD) that is not after today in Lagos'] }] });
    await expect(refuse(duplicate).create(ids.case, input, 'visit-key-12345678', context))
      .rejects.toMatchObject({ status: 409, code: 'OUTREACH_VISIT_CONFLICT' });
  });

  it.each([
    ['registration_case_visits_referred_to_check', 'referredTo'],
    ['registration_case_visits_notes_check', 'notes'],
    ['registration_case_visits_follow_up_on_check', 'followUpOn'],
    ['registration_case_visits_occurred_on_check', 'occurredOn'],
    ['registration_case_visits_kind_check', 'kind'],
  ])('answers a database CHECK failure on %s against %s', async (constraint, field) => {
    const error = Object.assign(new Error('check'), { code: '23514', constraint });
    const refusal = await refuse(error).create(ids.case, input, 'visit-key-12345678', context).catch((value) => value);
    expect(refusal).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', errors: [{ field }] });
    if (field !== 'occurredOn') expect(JSON.stringify(refusal.errors)).not.toContain('Lagos');
  });

  it('leaves a CHECK failure on a field the client did not send as a server error', async () => {
    const error = Object.assign(new Error('check'), { code: '23514', constraint: 'registration_case_visits_request_sha256_check' });
    await expect(refuse(error).create(ids.case, input, 'visit-key-12345678', context)).rejects.toBe(error);
  });

  it('lists at most 100 visits newest first and audits the list with ids only', async () => {
    const resolved = { ...pendingCase, status: 'identity_resolved', resolved_patient_id: ids.patient };
    const query = jest.fn().mockResolvedValueOnce({ rows: [resolved] }).mockResolvedValueOnce({ rows: [visitRow] });
    const { service, audit } = setup(query);
    await expect(service.list(ids.case, context)).resolves.toMatchObject({ items: [{ id: ids.visit }] });
    expect(query.mock.calls[1][0]).toMatch(/order by occurred_on desc,created_at desc,id desc limit 100/);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context,
      'outreach.registration-case.visit.list', ids.case, ids.patient);
  });
});

describe('OutreachVisitsService link preview', () => {
  const healthId = 'HID-7KQ2M9XA';

  it('counts the attempt, resolves through Identity, answers canLink and audits ids only', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [pendingCase] }).mockResolvedValueOnce({ rows: [{ used: 3 }] })
      .mockResolvedValueOnce({ rows: [] });
    const { service, identity, audit } = setup(query);
    identity.lookupByHealthId.mockResolvedValueOnce({ patientId: ids.patient, fullName: 'Ada Fictional',
      dateOfBirth: '1990-04-02', healthIdLast4: 'M9XA' });
    identity.canLinkPatient.mockResolvedValueOnce(false);
    await expect(service.linkPreview(ids.case, { healthId }, context)).resolves.toEqual({
      patient: { fullName: 'Ada Fictional', dateOfBirth: '1990-04-02', healthIdLast4: 'M9XA' }, canLink: false });
    expect(query.mock.calls[2][0]).toContain('insert into outreach.link_preview_attempts');
    expect(JSON.stringify(query.mock.calls)).not.toContain(healthId);
    expect(identity.canLinkPatient).toHaveBeenCalledWith(ids.patient, context);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context,
      'outreach.registration-case.link-preview', ids.case, ids.patient);
    expect(JSON.stringify(audit.recordWithClient.mock.calls)).not.toContain('Ada');
  });

  it('refuses the 21st preview in an hour with 429 before Identity is asked', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [pendingCase] }).mockResolvedValueOnce({ rows: [{ used: 20 }] });
    const { service, identity } = setup(query);
    await expect(service.linkPreview(ids.case, { healthId }, context))
      .rejects.toMatchObject({ status: 429, code: 'OUTREACH_HEALTH_ID_LIMIT' });
    expect(identity.lookupByHealthId).not.toHaveBeenCalled();
  });

  it('refuses a resolved case with 409 and asks Identity nothing', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ ...pendingCase, status: 'identity_resolved' }] });
    const { service, identity } = setup(query);
    await expect(service.linkPreview(ids.case, { healthId }, context))
      .rejects.toMatchObject({ status: 409, code: 'OUTREACH_REGISTRATION_ALREADY_RESOLVED' });
    expect(identity.lookupByHealthId).not.toHaveBeenCalled();
  });

  it.each([
    [new DomainProblem(404, 'OUTREACH_HEALTH_ID_NOT_FOUND', 'No one'), 'failure'],
    [new DomainProblem(403, 'OUTREACH_PATIENT_ACCESS_REQUIRED', 'Ask'), 'denied'],
  ])('passes Identity\'s mapped refusal %# on and audits it with the case id only (%s)', async (refusal, outcome) => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [pendingCase] }).mockResolvedValueOnce({ rows: [{ used: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    const { service, identity, audit } = setup(query);
    identity.lookupByHealthId.mockRejectedValueOnce(refusal);
    await expect(service.linkPreview(ids.case, { healthId }, context)).rejects.toBe(refusal);
    expect(identity.canLinkPatient).not.toHaveBeenCalled();
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context,
      'outreach.registration-case.link-preview', ids.case, undefined, outcome);
    expect(JSON.stringify(audit.recordWithClient.mock.calls)).not.toContain(healthId);
  });

  it('writes no Outreach audit row when Identity is unavailable', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [pendingCase] }).mockResolvedValueOnce({ rows: [{ used: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    const { service, identity, audit } = setup(query);
    identity.lookupByHealthId.mockRejectedValueOnce(new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE', 'down'));
    await expect(service.linkPreview(ids.case, { healthId }, context)).rejects.toMatchObject({ status: 503 });
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });
});
