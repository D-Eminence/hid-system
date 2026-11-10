import { plainToInstance } from 'class-transformer';
import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import { LinkExistingPatientDto } from './dto/link-existing-patient.dto';
import { OutreachService } from './outreach.service';

// OutreachService with the 0115 switch (OUTREACH_VISITS_ENABLED) off and on.
const ids = {
  facility: '123e4567-e89b-42d3-a456-426614174001',
  account: '123e4567-e89b-42d3-a456-426614174002',
  membership: '123e4567-e89b-42d3-a456-426614174003',
  case: '123e4567-e89b-42d3-a456-426614174004',
  patient: '123e4567-e89b-42d3-a456-426614174005',
  campaign: '123e4567-e89b-42d3-a456-426614174008',
  other: '123e4567-e89b-42d3-a456-426614174009',
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
const row = { id: ids.case, facility_id: ids.facility, campaign_id: ids.campaign, local_command_id: ids.other,
  temporary_patient_id: 'tmp_123e4567-e89b-42d3-a456-426614174007', status: 'identity_resolution_pending' as const,
  full_name: 'Ada Person', sex: 'female' as const, age_years: 32, phone: null,
  operational_notes: null, resolved_patient_id: null, resolution_kind: null,
  row_version: '1', created_at: new Date(), updated_at: new Date() };
const reason = 'Reviewed exact Identity match';

function build(query: jest.Mock, visitsEnabled: boolean | undefined) {
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown,
    _options?: unknown) => operation({ query })) };
  const audit = { recordWithClient: jest.fn() };
  const identity = { authorizeExistingPatient: jest.fn(), lookupByHealthId: jest.fn() };
  const features = visitsEnabled === undefined ? undefined : { visitsEnabled };
  return { database, audit, identity,
    service: new OutreachService(database as never, audit as never, identity as never, features as never) };
}

describe('link-existing digest', () => {
  it('keeps today\'s digest for a canonicalPatientId request although the DTO now declares healthId', async () => {
    const dto = plainToInstance(LinkExistingPatientDto, { canonicalPatientId: ids.patient, expectedVersion: 1, reason });
    expect(Object.keys(dto)).toContain('healthId');
    // Exactly what 0105's image digested: { id, ...input } with the three fields it had.
    const before = requestDigest('outreach.registration-case.link-existing',
      { id: ids.case, canonicalPatientId: ids.patient, expectedVersion: 1, reason });
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ request_sha256: before, registration_case_id: ids.case }] })
      .mockResolvedValueOnce({ rows: [row] });
    for (const enabled of [false, true]) {
      query.mockReset().mockResolvedValueOnce({ rows: [{ request_sha256: before, registration_case_id: ids.case }] })
        .mockResolvedValue({ rows: [row] });
      await expect(build(query, enabled).service.linkExisting(ids.case, dto, 'link-key-12345678', context))
        .resolves.toMatchObject({ id: ids.case });
    }
  });
});

describe('OUTREACH_VISITS_ENABLED off', () => {
  it('refuses healthId on link-existing as an unknown field and asks Identity nothing', async () => {
    const { service, identity, database } = build(jest.fn(), false);
    await expect(service.linkExisting(ids.case, { healthId: 'HID-7KQ2M9XA', expectedVersion: 1, reason },
      'link-key-12345678', context)).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED',
      errors: [{ field: 'healthId', messages: ['property healthId should not exist'] }] });
    expect(identity.lookupByHealthId).not.toHaveBeenCalled();
    expect(identity.authorizeExistingPatient).not.toHaveBeenCalled();
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it.each([false, undefined])('answers today\'s case shape with no extra query (switch %s)', async (enabled) => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [row] });
    const [value] = await build(query, enabled).service.list(context);
    expect(query).toHaveBeenCalledTimes(1);
    expect(Object.keys(value!)).not.toEqual(expect.arrayContaining(['createdBy']));
    expect(value).not.toHaveProperty('visitCount');
    expect(value).not.toHaveProperty('campaignName');
  });
});

describe('OUTREACH_VISITS_ENABLED on', () => {
  it('adds createdBy, campaignName, nextFollowUpOn and visitCount in one batch', async () => {
    const plain = { ...row, id: ids.other, campaign_id: null };
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [row, plain] })
      .mockResolvedValueOnce({ rows: [{ registration_case_id: ids.case, display_name: 'Staff A Fictional' }] })
      .mockResolvedValueOnce({ rows: [{ id: ids.campaign, name: 'Ajegunle health week' }] })
      .mockResolvedValueOnce({ rows: [{ registration_case_id: ids.case, visit_count: 2, next_follow_up_on: '2026-11-20' }] });
    const values = await build(query, true).service.list(context);
    expect(values[0]).toMatchObject({ createdBy: { name: 'Staff A Fictional' }, campaignName: 'Ajegunle health week',
      nextFollowUpOn: '2026-11-20', visitCount: 2 });
    expect(values[1]).toMatchObject({ createdBy: null, campaignName: null, nextFollowUpOn: null, visitCount: 0 });
    expect(query.mock.calls[1]).toEqual(['select registration_case_id,display_name from outreach.case_registrar_names($1::uuid[])',
      [[ids.case, ids.other]]]);
    expect(query.mock.calls[2][1]).toEqual([ids.facility, [ids.campaign]]);
  });

  const pending = { id: ids.case, status: 'identity_resolution_pending', resolved_patient_id: null, row_version: '1' };
  const healthDigest = requestDigest('outreach.registration-case.link-existing',
    { id: ids.case, healthId: 'HID-7KQ2M9XA', expectedVersion: 1, reason });
  const linkByHealthId = (service: OutreachService, expectedVersion = 1) => service.linkExisting(ids.case,
    { healthId: 'HID-7KQ2M9XA', expectedVersion, reason }, 'link-key-12345678', context);

  it('links by Health ID: counts the check before Identity resolves it again, then the write check', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [pending] })
      .mockResolvedValueOnce({ rows: [{ used: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValue({ rows: [{ ...row, status: 'identity_resolved', resolved_patient_id: ids.patient, row_version: '2' }] });
    const { service, identity, database } = build(query, true);
    identity.lookupByHealthId.mockResolvedValueOnce({ patientId: ids.patient, fullName: 'x', dateOfBirth: null,
      healthIdLast4: 'M9XA' });
    await linkByHealthId(service);
    expect(identity.lookupByHealthId).toHaveBeenCalledWith('HID-7KQ2M9XA', context);
    expect(identity.authorizeExistingPatient).toHaveBeenCalledWith(ids.patient, context);
    // The first transaction is SERIALIZABLE and writes the attempt before Identity is called.
    expect((database.withTransaction.mock.calls[0] as unknown[])[2]).toEqual({ isolationLevel: 'SERIALIZABLE' });
    expect(String(query.mock.calls[0]![0])).toContain('from outreach.command_idempotency');
    expect(String(query.mock.calls[3]![0])).toContain('insert into outreach.link_preview_attempts');
    expect(query.mock.invocationCallOrder[3]!).toBeLessThan(identity.lookupByHealthId.mock.invocationCallOrder[0]!);
    const idempotencyInsert = query.mock.calls.find(([sql]) => String(sql).includes('insert into outreach.command_idempotency'));
    expect(idempotencyInsert![1][4]).toBe(healthDigest);
    expect(JSON.stringify(query.mock.calls)).not.toContain('HID-7KQ2M9XA');
  });

  it('counts a Health ID Identity refuses against the hourly budget (the row is written first)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [pending] })
      .mockResolvedValueOnce({ rows: [{ used: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    const { service, identity } = build(query, true);
    const { DomainProblem } = await import('../common/problem');
    identity.lookupByHealthId.mockRejectedValueOnce(new DomainProblem(403, 'OUTREACH_PATIENT_ACCESS_REQUIRED', 'Ask'));
    await expect(linkByHealthId(service)).rejects.toMatchObject({ status: 403, code: 'OUTREACH_PATIENT_ACCESS_REQUIRED' });
    expect(query).toHaveBeenCalledTimes(4);
    expect(String(query.mock.calls[3]![0])).toContain('insert into outreach.link_preview_attempts');
    expect(identity.authorizeExistingPatient).not.toHaveBeenCalled();
  });

  it('refuses a Health ID link over the hourly budget before Identity is asked', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [pending] })
      .mockResolvedValueOnce({ rows: [{ used: 20 }] });
    const { service, identity } = build(query, true);
    await expect(linkByHealthId(service)).rejects.toMatchObject({ status: 429, code: 'OUTREACH_HEALTH_ID_LIMIT' });
    expect(query).toHaveBeenCalledTimes(3);
    expect(identity.lookupByHealthId).not.toHaveBeenCalled();
  });

  it('refuses a Health ID link on a resolved case (409) or at an old version (412) before Identity is asked', async () => {
    const resolved = jest.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...pending, status: 'identity_resolved', resolved_patient_id: ids.patient }] });
    const first = build(resolved, true);
    await expect(linkByHealthId(first.service)).rejects.toMatchObject({ status: 409,
      code: 'OUTREACH_REGISTRATION_ALREADY_RESOLVED' });
    expect(resolved).toHaveBeenCalledTimes(2);
    expect(first.identity.lookupByHealthId).not.toHaveBeenCalled();
    const stale = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ...pending, row_version: '3' }] });
    const second = build(stale, true);
    await expect(linkByHealthId(second.service)).rejects.toMatchObject({ status: 412, code: 'VERSION_CONFLICT' });
    expect(stale).toHaveBeenCalledTimes(2);
    expect(second.identity.lookupByHealthId).not.toHaveBeenCalled();
  });

  it('replays a Health ID link already made without asking Identity or counting it', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ request_sha256: healthDigest, registration_case_id: ids.case }] })
      .mockResolvedValue({ rows: [{ ...row, status: 'identity_resolved', resolved_patient_id: ids.patient, row_version: '2' }] });
    const { service, identity } = build(query, true);
    await expect(linkByHealthId(service)).resolves.toMatchObject({ id: ids.case, resolvedPatientId: ids.patient });
    expect(identity.lookupByHealthId).not.toHaveBeenCalled();
    expect(identity.authorizeExistingPatient).not.toHaveBeenCalled();
    expect(JSON.stringify(query.mock.calls)).not.toContain('link_preview_attempts');
  });

  it('names campaign members through member_display_names, null when not shared', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({ rows: [
        { id: 'm1', campaignId: ids.campaign, membershipId: ids.membership, role: 'admin', createdAt: new Date() },
        { id: 'm2', campaignId: ids.campaign, membershipId: ids.other, role: 'enumerator', createdAt: new Date() }] })
      .mockResolvedValueOnce({ rows: [{ membership_id: ids.membership, display_name: 'Staff A Fictional' }] });
    const members = await build(query, true).service.listCampaignMembers(ids.campaign, context);
    expect(members.map((member) => member.displayName)).toEqual(['Staff A Fictional', null]);
    expect(query.mock.calls[2]![1]).toEqual([[ids.membership, ids.other]]);
    const off = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockResolvedValueOnce({ rows: [
      { id: 'm1', campaignId: ids.campaign, membershipId: ids.membership, role: 'admin', createdAt: new Date() }] });
    const plain = await build(off, false).service.listCampaignMembers(ids.campaign, context);
    expect(plain[0]).not.toHaveProperty('displayName');
    expect(off).toHaveBeenCalledTimes(2);
  });
});
