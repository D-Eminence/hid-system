import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { OutreachService } from './outreach.service';

const ids = {
  facility: '123e4567-e89b-42d3-a456-426614174001',
  account: '123e4567-e89b-42d3-a456-426614174002',
  membership: '123e4567-e89b-42d3-a456-426614174003',
  case: '123e4567-e89b-42d3-a456-426614174004',
  patient: '123e4567-e89b-42d3-a456-426614174005',
  command: '123e4567-e89b-42d3-a456-426614174006',
  campaign: '123e4567-e89b-42d3-a456-426614174008',
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
const input = { localCommandId: ids.command,
  temporaryPatientId: 'tmp_123e4567-e89b-42d3-a456-426614174007',
  fullName: 'Ada Person', sex: 'female' as const, ageYears: 32 };
const row = { id: ids.case, facility_id: ids.facility, campaign_id: null, local_command_id: ids.command,
  temporary_patient_id: input.temporaryPatientId, status: 'identity_resolution_pending' as const,
  full_name: input.fullName, sex: input.sex, age_years: 32, phone: null,
  operational_notes: null, resolved_patient_id: null, resolution_kind: null,
  row_version: '1', created_at: new Date(), updated_at: new Date() };

describe('OutreachService', () => {
  const audit = { recordWithClient: jest.fn() };
  const identity = { authorizeExistingPatient: jest.fn() };
  beforeEach(() => jest.clearAllMocks());

  it('atomically creates pending intake, history, idempotency, outbox, and semantic audit', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    const service = new OutreachService(database as never, audit as never, identity as never);
    await expect(service.create(input, 'idempotency-key-1234', context)).resolves.toMatchObject({
      id: ids.case, temporaryPatientId: input.temporaryPatientId, resolvedPatientId: null,
      status: 'identity_resolution_pending',
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('registration_case_events'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('command_idempotency'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('outbox_events'))).toBe(true);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
  });

  it('returns the same case for an identical idempotent replay without duplicate evidence', async () => {
    const digest = requestDigest('outreach.registration-case.create', { ...input,
      fullName: input.fullName, phone: null, operationalNotes: null });
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ request_sha256: digest,
      registration_case_id: ids.case }] }).mockResolvedValueOnce({ rows: [row] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .create(input, 'idempotency-key-1234', context)).resolves.toMatchObject({ id: ids.case });
    expect(query).toHaveBeenCalledTimes(2);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  // The real DatabaseService retry over a fake pool: transaction control is
  // answered by the pool, the service's statements by `query`.
  function retryingDatabase(query: jest.Mock): DatabaseService {
    const database = Object.create(DatabaseService.prototype) as DatabaseService;
    const pool = { connect: async () => ({ release: () => undefined,
      query: async (sql: string, values?: unknown[]) => (/^(BEGIN|COMMIT|ROLLBACK|SET )/.test(sql)
        || sql.includes('set_config(') ? { rows: [] } : query(sql, values)) }) };
    Object.assign(database, { pool, pauseBeforeRetry: async () => undefined });
    return database;
  }
  const duplicate = () => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

  it('replays a registration whose concurrent identical request committed first, not 409 (Phase 4 Stage 9)', async () => {
    const digest = requestDigest('outreach.registration-case.create', { ...input,
      fullName: input.fullName, phone: null, operationalNotes: null });
    // Attempt 1 misses the winner in its snapshot and meets its row at the insert; attempt 2 replays it.
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(duplicate())
      .mockResolvedValueOnce({ rows: [{ request_sha256: digest, registration_case_id: ids.case }] })
      .mockResolvedValueOnce({ rows: [row] });
    await expect(new OutreachService(retryingDatabase(query), audit as never, identity as never)
      .create(input, 'idempotency-key-1234', context)).resolves.toMatchObject({ id: ids.case });
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('answers 409 when the unique violation remains after the retry', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(duplicate())
      .mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(duplicate());
    await expect(new OutreachService(retryingDatabase(query), audit as never, identity as never)
      .create(input, 'idempotency-key-5678', context)).rejects.toMatchObject({ code: 'OUTREACH_REGISTRATION_CONFLICT' });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('binds a registration to an active campaign with exact staff membership', async () => {
    const campaignInput = { ...input, campaignId: ids.campaign };
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
      status: 'active', services: ['registration'], starts_at: new Date(Date.now() - 60_000),
      ends_at: new Date(Date.now() + 60_000),
    }] }).mockResolvedValueOnce({ rows: [{ ...row, campaign_id: ids.campaign }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .create(campaignInput, 'campaign-idempotency-key', context))
      .resolves.toMatchObject({ id: ids.case, campaignId: ids.campaign });
    expect(query.mock.calls[1][0]).toContain('member.membership_id=$3');
    expect(query.mock.calls[1][1]).toEqual([ids.campaign, ids.facility, ids.membership]);
    expect(query.mock.calls[2][1][10]).toBe(ids.campaign);
    expect(query.mock.calls[5][1][6]).toContain(`"campaignId":"${ids.campaign}"`);
  });

  it('denies a campaign registration without exact membership', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .create({ ...input, campaignId: ids.campaign }, 'campaign-idempotency-key', context))
      .rejects.toMatchObject({ status: 403, code: 'OUTREACH_CAMPAIGN_ACCESS_DENIED' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  // The trigger's refusals at the insert (0045, 0110), after the service's own
  // check passed: the same 403 and 409 as that check, not 500.
  const activeCampaign = { rows: [{ status: 'active', services: ['registration'],
    starts_at: new Date(Date.now() - 60_000), ends_at: null }] };
  const triggerRefusal = (code: string, message: string) => Object.assign(new Error(message), { code });

  it('answers 403 when the registration trigger refuses the campaign membership (0110)', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce(activeCampaign)
      .mockRejectedValueOnce(triggerRefusal('42501', 'Exact Outreach campaign membership is required'));
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .create({ ...input, campaignId: ids.campaign }, 'campaign-idempotency-key', context))
      .rejects.toMatchObject({ status: 403, code: 'OUTREACH_CAMPAIGN_ACCESS_DENIED' });
    expect(query).toHaveBeenCalledTimes(3);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('answers 409 when the registration trigger finds the campaign no longer accepting', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce(activeCampaign)
      .mockRejectedValueOnce(triggerRefusal('23514', 'Outreach campaign is not accepting registrations'));
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .create({ ...input, campaignId: ids.campaign }, 'campaign-idempotency-key', context))
      .rejects.toMatchObject({ status: 409, code: 'OUTREACH_CAMPAIGN_NOT_ACCEPTING_REGISTRATIONS' });
  });

  it('leaves any other database refusal of a registration as it is', async () => {
    const other = triggerRefusal('42501', 'Valid Outreach registration context is required');
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce(activeCampaign)
      .mockRejectedValueOnce(other);
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .create({ ...input, campaignId: ids.campaign }, 'campaign-idempotency-key', context))
      .rejects.toBe(other);
  });

  it('denies registration after a campaign closes', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
      status: 'closed', services: ['registration'], starts_at: new Date(Date.now() - 60_000),
      ends_at: null,
    }] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .create({ ...input, campaignId: ids.campaign }, 'campaign-idempotency-key', context))
      .rejects.toMatchObject({ status: 409, code: 'OUTREACH_CAMPAIGN_NOT_ACCEPTING_REGISTRATIONS' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('filters listed cases by exact campaign membership', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [row] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .list(context)).resolves.toMatchObject([{ id: ids.case, campaignId: null }]);
    expect(query.mock.calls[0][0]).toContain('outreach.registration_campaign_member(campaign_id, facility_id)');
  });

  it('requires Identity authorization before opening a patient-link transaction', async () => {
    identity.authorizeExistingPatient.mockRejectedValueOnce(new Error('Identity denied'));
    const database = { withTransaction: jest.fn() };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .linkExisting(ids.case, { canonicalPatientId: ids.patient, expectedVersion: 1,
        reason: 'Reviewed exact Identity match' }, 'link-key-1234', context)).rejects.toThrow('Identity denied');
    expect(database.withTransaction).not.toHaveBeenCalled();
  });
});

// 0111 (ADR-045 option B): a campaign's own admins open, close and staff it. Fictional ids only.
describe('OutreachService campaign admins', () => {
  const audit = { recordWithClient: jest.fn() };
  const identity = { authorizeExistingPatient: jest.fn() };
  const other = '123e4567-e89b-42d3-a456-426614174009';
  const campaignRow = { id: ids.campaign, facility_id: ids.facility, name: 'Campaign', services: ['registration'],
    status: 'planned', starts_at: new Date(Date.now() - 60_000), ends_at: null, row_version: '3',
    created_at: new Date(), updated_at: new Date() };
  const service = (query: jest.Mock) => new OutreachService(
    { withTransaction: jest.fn(async (_context, operation) => operation({ query })) } as never, audit as never, identity as never);
  const statusInput = { status: 'active' as const, reason: 'Team ready to start' };
  beforeEach(() => jest.clearAllMocks());

  it('refuses a non-admin member opening a campaign before the version or the update', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [campaignRow] }).mockResolvedValueOnce({ rows: [{ role: 'enumerator' }] });
    await expect(service(query).updateCampaignStatus(ids.campaign, statusInput, 1, context))
      .rejects.toMatchObject({ status: 403, code: 'OUTREACH_CAMPAIGN_ADMIN_REQUIRED' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual([ids.campaign, ids.facility, ids.membership]);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('refuses a non-member closing a campaign', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [campaignRow] }).mockResolvedValueOnce({ rows: [] });
    await expect(service(query).updateCampaignStatus(ids.campaign, { status: 'closed', reason: 'Campaign finished' }, 3, context))
      .rejects.toMatchObject({ status: 403, code: 'OUTREACH_CAMPAIGN_ADMIN_REQUIRED' });
  });

  it('lets an admin open it, and records the change', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [campaignRow] }).mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{ ...campaignRow, status: 'active', row_version: '4' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(service(query).updateCampaignStatus(ids.campaign, statusInput, 3, context))
      .resolves.toMatchObject({ status: 'active', rowVersion: 4 });
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context, 'outreach.campaign.status-changed', ids.campaign);
  });

  it('answers the database\'s own admin refusal as the same 403', async () => {
    const refusal = Object.assign(new Error('Outreach campaign admin is required'), { code: '42501' });
    const query = jest.fn().mockResolvedValueOnce({ rows: [campaignRow] }).mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockRejectedValueOnce(refusal);
    await expect(service(query).updateCampaignStatus(ids.campaign, statusInput, 3, context))
      .rejects.toMatchObject({ status: 403, code: 'OUTREACH_CAMPAIGN_ADMIN_REQUIRED' });
  });

  it('refuses a non-admin adding a member, before looking the person up', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockResolvedValueOnce({ rows: [{ role: 'health_worker' }] });
    await expect(service(query).addCampaignMember(ids.campaign, { membershipId: other, role: 'enumerator' }, context))
      .rejects.toMatchObject({ status: 403, code: 'OUTREACH_CAMPAIGN_ADMIN_REQUIRED' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('adds only active staff at the facility, and not twice', async () => {
    const notStaff = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(service(notStaff).addCampaignMember(ids.campaign, { membershipId: other, role: 'enumerator' }, context))
      .rejects.toMatchObject({ status: 422, code: 'OUTREACH_STAFF_NOT_AVAILABLE' });
    expect(notStaff.mock.calls[2][0]).toContain('outreach.campaign_staff($1)');
    expect(notStaff.mock.calls[2][1]).toEqual([ids.campaign, other]);
    const already = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{ campaign_role: 'enumerator' }] });
    await expect(service(already).addCampaignMember(ids.campaign, { membershipId: other, role: 'enumerator' }, context))
      .rejects.toMatchObject({ status: 409, code: 'OUTREACH_CAMPAIGN_MEMBER_EXISTS' });
  });

  it('lets an admin add an available person, and records it', async () => {
    const member = { id: 'm1', campaignId: ids.campaign, membershipId: other, role: 'enumerator', createdAt: new Date() };
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{ campaign_role: null }] }).mockResolvedValueOnce({ rows: [member] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(service(query).addCampaignMember(ids.campaign, { membershipId: other, role: 'enumerator' }, context))
      .resolves.toMatchObject({ membershipId: other, role: 'enumerator' });
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context, 'outreach.campaign.member-added', ids.campaign);
  });

  it('answers the member policy\'s refusal as the same 403', async () => {
    const refusal = Object.assign(new Error('new row violates row-level security policy "outreach_campaign_members_admin_create" for table "campaign_members"'), { code: '42501' });
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{ campaign_role: null }] }).mockRejectedValueOnce(refusal);
    await expect(service(query).addCampaignMember(ids.campaign, { membershipId: other, role: 'enumerator' }, context))
      .rejects.toMatchObject({ status: 403, code: 'OUTREACH_CAMPAIGN_ADMIN_REQUIRED' });
  });

  it('lists a campaign\'s people by name with the caller\'s own role', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockResolvedValueOnce({ rows: [
      { membership_id: ids.membership, display_name: 'Ada Admin', campaign_role: 'admin' },
      { membership_id: other, display_name: 'Bayo Candidate', campaign_role: null }] });
    await expect(service(query).listCampaignStaff(ids.campaign, context)).resolves.toEqual({ yourRole: 'admin', people: [
      { membershipId: ids.membership, name: 'Ada Admin', campaignRole: 'admin' },
      { membershipId: other, name: 'Bayo Candidate', campaignRole: null }] });
    const missing = jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(service(missing).listCampaignStaff(ids.campaign, context)).rejects.toMatchObject({ status: 404 });
    const outsider = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockResolvedValueOnce({ rows: [] });
    await expect(service(outsider).listCampaignStaff(ids.campaign, context)).resolves.toEqual({ yourRole: null, people: [] });
  });

  it('refuses a campaign that ends before it starts, before the database', async () => {
    const query = jest.fn();
    await expect(service(query).createCampaign({ name: 'Campaign', services: ['registration'],
      startsAt: '2026-11-20T08:00:00.000Z', endsAt: '2026-11-19T08:00:00.000Z' }, context))
      .rejects.toMatchObject({ status: 400, code: 'OUTREACH_CAMPAIGN_DATES_INVALID' });
    expect(query).not.toHaveBeenCalled();
  });
});
