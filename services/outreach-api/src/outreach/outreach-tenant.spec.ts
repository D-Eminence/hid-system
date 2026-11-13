import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { DataAccessContext } from '../common/request-context';
import { CreateRegistrationCaseDto, normalizeOutreachPhone } from './dto/create-registration-case.dto';
import { OutreachService } from './outreach.service';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOutreachTenant, OUTREACH_TENANT_RULE_CODES, outreachRuleProblem } from './outreach-tenant';

// Fictional test data only.
const ids = {
  facility: '223e4567-e89b-42d3-a456-426614174001',
  account: '223e4567-e89b-42d3-a456-426614174002',
  membership: '223e4567-e89b-42d3-a456-426614174003',
  case: '223e4567-e89b-42d3-a456-426614174004',
  patient: '223e4567-e89b-42d3-a456-426614174005',
  command: '223e4567-e89b-42d3-a456-426614174006',
  campaign: '223e4567-e89b-42d3-a456-426614174008',
};

function contextWithRoles(roles: string[]): DataAccessContext {
  return {
    correlationId: 'correlation-tenant-1', facilityId: ids.facility, membershipId: ids.membership,
    purposeOfUse: 'direct-care', actor: {
      id: 'staff:volunteer', subject: 'staff:volunteer', accountId: ids.account, authenticationMethod: 'local',
      roles, permissions: ['outreach.registration.write'], facilityIds: [ids.facility], facilities: [],
      facility: { id: ids.facility, membershipId: ids.membership, organizationId: ids.facility,
        name: 'Synthetic Community Volunteers', roles, permissions: ['outreach.registration.write'], isPrimary: true },
    },
  };
}
const tenant = contextWithRoles(['outreach_volunteer']);
const hospital = contextWithRoles(['nurse']);
const consent = { textVersion: 'outreach-notice-2026-11-01', language: 'yo' as const, method: 'verbal_read_aloud' as const };
const input = { localCommandId: ids.command, temporaryPatientId: 'tmp_223e4567-e89b-42d3-a456-426614174007',
  fullName: 'Ada Fictional', sex: 'female' as const, ageYears: 32, campaignId: ids.campaign };
const row = { id: ids.case, facility_id: ids.facility, campaign_id: ids.campaign, local_command_id: ids.command,
  temporary_patient_id: input.temporaryPatientId, status: 'identity_resolution_pending' as const,
  full_name: input.fullName, sex: input.sex, age_years: 32, phone: '+2348012345678', operational_notes: null,
  resolved_patient_id: null, resolution_kind: null, row_version: '1', created_at: new Date(), updated_at: new Date() };
const activeCampaign = { status: 'active', services: ['registration'], starts_at: new Date(Date.now() - 60_000),
  ends_at: new Date(Date.now() + 60_000) };

describe('Outreach group rules (open sign-up on outreach.)', () => {
  const audit = { recordWithClient: jest.fn() };
  const identity = { authorizeExistingPatient: jest.fn() };
  beforeEach(() => jest.clearAllMocks());

  it('reads an outreach group from its membership roles only', () => {
    expect(isOutreachTenant(tenant)).toBe(true);
    expect(isOutreachTenant(contextWithRoles(['outreach_organiser']))).toBe(true);
    expect(isOutreachTenant(hospital)).toBe(false);
  });

  it.each([
    [{ ...input, campaignId: undefined, consent }, 'OUTREACH_CAMPAIGN_REQUIRED'],
    [{ ...input }, 'OUTREACH_CONSENT_REQUIRED'],
    [{ ...input, ageYears: 15, consent }, 'OUTREACH_CONSENT_GUARDIAN_REQUIRED'],
    [{ ...input, consent, operationalNotes: 'x'.repeat(1001) }, 'OUTREACH_NOTES_TOO_LONG'],
  ])('refuses an outreach group registration before writing anything (%#: %s)', async (body, code) => {
    const database = { withTransaction: jest.fn() };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .create(body as never, 'tenant-key-0001', tenant)).rejects.toMatchObject({ status: 422, code });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('writes the consent row in the same transaction and returns the duplicate hint', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [activeCampaign] })
      .mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ found: true }] });
    const database = { withTransaction: jest.fn(async (_context, operation, options) => {
      expect(options).toEqual({ isolationLevel: 'SERIALIZABLE' });
      return operation({ query });
    }) };
    const minor = { ...input, ageYears: 12, consent: { ...consent, method: 'guardian' as const, guardianName: 'Bisi Fictional' } };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .create(minor, 'tenant-key-0002', tenant)).resolves.toMatchObject({ id: ids.case, possibleDuplicate: true });
    expect(database.withTransaction).toHaveBeenCalledTimes(1);
    const consentCall = query.mock.calls.find(([sql]) => String(sql).includes('outreach.registration_consents'));
    // 0115's columns: registration_case_id, the facility, and the capturer as the request's own account.
    expect(String(consentCall?.[0])).toMatch(/registration_case_id,facility_id,consent_text_version,language,method,guardian_name,\s*captured_by_account_id,captured_by_membership_id/);
    expect(String(consentCall?.[0])).toContain('platform.current_account_id()');
    expect(consentCall?.[1]).toEqual([ids.case, ids.facility, consent.textVersion, 'yo', 'guardian', 'Bisi Fictional',
      ids.membership]);
    const hint = query.mock.calls.at(-1);
    expect(String(hint?.[0])).toContain('other.campaign_id=$1');
    expect(hint?.[1]).toEqual([ids.campaign, ids.facility, ids.case, '+2348012345678', 'Ada Fictional', 32]);
  });

  it('keeps a hospital registration without consent working as before', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ...row, campaign_id: null }] })
      .mockResolvedValue({ rows: [] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    const { campaignId: _campaign, ...withoutCampaign } = input;
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .create(withoutCampaign, 'hospital-key-0001', hospital)).resolves.toMatchObject({ id: ids.case });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('registration_consents'))).toBe(false);
  });

  it('maps the database rules to plain problems', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [activeCampaign] })
      .mockRejectedValueOnce(Object.assign(new Error('OUTREACH_CONSENT_REQUIRED'), { code: '23514' }));
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .create({ ...input, consent }, 'tenant-key-0003', tenant)).rejects.toMatchObject({ status: 422, code: 'OUTREACH_CONSENT_REQUIRED' });
    // Owner decision Q38: no check before a campaign goes live, so no refusal waits for one.
    expect(outreachRuleProblem({ code: 'P0001', message: 'OUTREACH_ORGANISER_AWAITING_REVIEW' })).toBeUndefined();
    expect(outreachRuleProblem({ code: '42501', message: 'OUTREACH_ORGANISER_SUSPENDED' }))
      .toMatchObject({ status: 423, code: 'OUTREACH_ORGANISER_SUSPENDED' });
    expect(outreachRuleProblem({ code: '42501', message: 'OUTREACH_TENANT_NO_HEALTH_ID_LINK' }))
      .toMatchObject({ status: 403, code: 'OUTREACH_TENANT_NO_HEALTH_ID_LINK' });
    expect(outreachRuleProblem({ code: '23505', message: 'duplicate key' })).toBeUndefined();
  });

  it('lets a new outreach group set its campaign Active at once (owner decision Q38: no check first)', async () => {
    const now = new Date();
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: ids.campaign, status: 'draft', row_version: 1,
      starts_at: new Date(Date.now() - 60_000) }] }).mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{ id: ids.campaign, facility_id: tenant.facilityId, name: 'Synthetic market day',
        services: ['registration'], status: 'active', starts_at: now, ends_at: null, row_version: 2, created_at: now,
        updated_at: now }] })
      .mockResolvedValue({ rows: [] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .updateCampaignStatus(ids.campaign, { status: 'active', reason: 'Starting the event' } as never, 1,
        contextWithRoles(['outreach_organiser'])))
      .resolves.toMatchObject({ status: 'active', rowVersion: 2 });
    expect(query.mock.calls.some(([sql]) => /organiser_status|review/i.test(String(sql)))).toBe(false);
  });

  it('answers 423 OUTREACH_ORGANISER_SUSPENDED when a paused group sets a campaign Active', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: ids.campaign, status: 'draft', row_version: 1,
      starts_at: new Date(Date.now() - 60_000) }] }).mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockRejectedValueOnce(Object.assign(new Error('OUTREACH_ORGANISER_SUSPENDED'), { code: '42501' }));
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .updateCampaignStatus(ids.campaign, { status: 'active', reason: 'Starting the event' } as never, 1,
        contextWithRoles(['outreach_organiser'])))
      .rejects.toMatchObject({ status: 423, code: 'OUTREACH_ORGANISER_SUSPENDED' });
  });

  it('refuses linking to a Health ID at an outreach group before asking Identity', async () => {
    const database = { withTransaction: jest.fn() };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .linkExisting(ids.case, { canonicalPatientId: ids.patient, expectedVersion: 1, reason: 'Matched at the desk' },
        'tenant-key-0004', tenant)).rejects.toMatchObject({ status: 403, code: 'OUTREACH_TENANT_NO_HEALTH_ID_LINK' });
    expect(identity.authorizeExistingPatient).not.toHaveBeenCalled();
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('reports the organiser status on the governance endpoint, failing soft', async () => {
    const service = (state: string | null | Error) => new OutreachService({ withTransaction: jest.fn(async (_c, operation, options) => {
      expect(options).toEqual({ readOnly: true });
      return operation({ query: jest.fn(async (sql: string) => {
        if (state instanceof Error) throw state;
        expect(sql).toBe('select outreach.organiser_status() as organiser_status');
        return { rows: [{ organiser_status: state }] };
      }) });
    }) } as never, audit as never, identity as never);
    // Health ID never verifies a group: any state but suspended reads 'unverified' (owner decision Q38).
    for (const state of ['active', 'pending', 'reviewed']) {
      await expect(service(state).campaignGovernance(tenant)).resolves.toEqual({ rule: 'campaign_admins', organiserStatus: 'unverified' });
    }
    await expect(service(null).campaignGovernance(tenant)).resolves.toEqual({ rule: 'campaign_admins', organiserStatus: 'unknown' });
    await expect(service('suspended').campaignGovernance(tenant)).resolves.toEqual({ rule: 'campaign_admins', organiserStatus: 'suspended' });
    await expect(service(new Error('function does not exist')).campaignGovernance(tenant))
      .resolves.toEqual({ rule: 'campaign_admins', organiserStatus: 'unknown' });
    const untouched = { withTransaction: jest.fn() };
    await expect(new OutreachService(untouched as never, audit as never, identity as never).campaignGovernance(hospital))
      .resolves.toEqual({ rule: 'campaign_admins', organiserStatus: 'not_outreach_group' });
    expect(untouched.withTransaction).not.toHaveBeenCalled();
  });
});

describe('Registration DTO: consent and E.164 phones', () => {
  const base = { localCommandId: ids.command, temporaryPatientId: input.temporaryPatientId,
    fullName: 'Ada Fictional', sex: 'female', ageYears: 32 };

  it.each([
    ['08012345678', '+2348012345678'],
    ['0801 234 5678', '+2348012345678'],
    ['+234 0801 234 5678', '+2348012345678'],
    ['2348012345678', '+2348012345678'],
    ['+44 7700 900123', '+447700900123'],
  ])('normalises %s to %s', async (raw, expected) => {
    const dto = plainToInstance(CreateRegistrationCaseDto, { ...base, phone: raw });
    expect(await validate(dto)).toEqual([]);
    expect(dto.phone).toBe(expected);
  });

  it('refuses a phone that is not a number and treats an empty one as absent', async () => {
    expect((await validate(plainToInstance(CreateRegistrationCaseDto, { ...base, phone: 'call me' })))
      .some((error) => error.property === 'phone')).toBe(true);
    expect(normalizeOutreachPhone('  ')).toBeUndefined();
  });

  it('validates the consent object', async () => {
    expect(await validate(plainToInstance(CreateRegistrationCaseDto, { ...base, consent }))).toEqual([]);
    const bad = plainToInstance(CreateRegistrationCaseDto, { ...base, consent: { ...consent, language: 'fr', method: 'nod' } });
    const errors = await validate(bad);
    expect(errors.find((error) => error.property === 'consent')?.children?.map((child) => child.property).sort())
      .toEqual(['language', 'method']);
  });
});

describe('The refusal codes match migration 0115', () => {
  // 0115's raise messages for the rules outreach-api answers (the db branch,
  // services/ehr-api/database/migrations/0115_outreach_organisers.sql). When
  // the migration is in this tree, the list is read from it too.
  const RAISED_BY_0115 = ['OUTREACH_CAMPAIGN_REQUIRED', 'OUTREACH_CONSENT_CASE_INVALID',
    'OUTREACH_CONSENT_GUARDIAN_REQUIRED', 'OUTREACH_CONSENT_REQUIRED', 'OUTREACH_NOTES_TOO_LONG',
    'OUTREACH_ORGANISER_SUSPENDED', 'OUTREACH_TENANT_NO_HEALTH_ID_LINK'];

  it('matches only codes 0115 raises, and every rule of an outreach group\'s data', () => {
    expect([...OUTREACH_TENANT_RULE_CODES].sort()).toEqual([...RAISED_BY_0115].sort());
    for (const code of OUTREACH_TENANT_RULE_CODES) {
      expect(outreachRuleProblem({ code: 'P0001', message: code })).toBeDefined();
    }
  });

  const migration = join(__dirname, '../../../ehr-api/database/migrations/0115_outreach_organisers.sql');
  (existsSync(migration) ? it : it.skip)('every code matched is raised by the migration in this tree', () => {
    const raised = new Set([...readFileSync(migration, 'utf8').matchAll(/message\s*=\s*'([A-Z_]+)'/g)].map((m) => m[1]));
    for (const code of OUTREACH_TENANT_RULE_CODES) expect(raised.has(code)).toBe(true);
    expect(raised.has('OUTREACH_ORGANISER_AWAITING_REVIEW')).toBe(false);
  });
});
