import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { WardStayAccessDto } from './dto/ward-stay-access.dto';
import { WardStayAccessController } from './ward-stay-access.controller';
import { WARD_STAY_DETAIL, WardStayAccessService, translate } from './ward-stay-access.service';

// ADT-1 route 23 (0173, owner decision Q156 A). Fictional identifiers only.
const facilityId = '0c0d0e0f-0000-4000-8000-000000000002';
const patientId = '0c0d0e0f-0000-4000-8000-000000000401';
const admissionId = '0c0d0e0f-0000-4000-8000-000000000501';
const grantId = '0c0d0e0f-0000-4000-8000-000000000701';
const expiresAt = new Date('2026-12-19T10:00:00.000Z');

const context = {
  actor: { kind: 'staff', subject: 'synthetic:ward-nurse', accountId: '0c0d0e0f-0000-4000-8000-000000000101',
    permissions: ['ehr.ward.read'], facility: { facilityId, organizationId: '0c0d0e0f-0000-4000-8000-000000000001',
      roles: ['nurse'] } },
  facilityId, membershipId: '0c0d0e0f-0000-4000-8000-000000000301', correlationId: 'ward-stay-spec-01',
  purposeOfUse: 'direct-care',
} as unknown as DataAccessContext;

function setup(answer: Record<string, unknown> | Error) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const query = jest.fn(async (sql: string, values: unknown[]) => {
    statements.push({ sql, values });
    if (answer instanceof Error) throw answer;
    return { rows: [answer], rowCount: 1 };
  });
  const database = { withTransaction: jest.fn(async (_context: unknown, action: (client: unknown) => unknown) => action({ query })) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new WardStayAccessService(database as never, audit as never), statements, audit };
}

describe('ward-team access for the stay (0173, Q156 A, built and switched off)', () => {
  it('while switched off answers 503 WARD_STAY_ACCESS_NOT_AVAILABLE and audits nothing here', async () => {
    const { service, audit } = setup(Object.assign(new Error('WARD_STAY_ACCESS_NOT_AVAILABLE'), { code: '55000' }));
    const failure = await service.open(context, admissionId).catch((error: unknown) => error) as DomainProblem;
    expect([failure.getStatus(), failure.code]).toEqual([503, 'WARD_STAY_ACCESS_NOT_AVAILABLE']);
    expect(JSON.stringify(failure.getResponse())).toContain(WARD_STAY_DETAIL.notAvailable);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('once switched on, opens with basis ward-stay: write records for direct care', async () => {
    const { service, statements } = setup({ outcome: 'opened', consentGrantId: grantId, patientId, status: 'active',
      expiresAt, existingGrant: false });
    await expect(service.open(context, admissionId)).resolves.toEqual({ consentGrantId: grantId, patientId,
      status: 'active', expiresAt, existingGrant: false,
      authorization: { basis: 'ward-stay', scope: 'write_records', purpose: 'direct-care' } });
    expect(statements[0]!.sql).toContain('identity.open_ward_stay($1::uuid)');
    expect(statements[0]!.values).toEqual([admissionId]);
  });

  it('refuses a member who is not on the ward team with one answer', async () => {
    const { service } = setup({ outcome: 'refused', consentGrantId: null, patientId: null, status: null, expiresAt: null,
      existingGrant: false });
    const failure = await service.open(context, admissionId).catch((error: unknown) => error) as DomainProblem;
    expect([failure.getStatus(), failure.code]).toEqual([403, 'WARD_STAY_ACCESS_REFUSED']);
  });

  it('answers another facility\'s admission with 404', async () => {
    const { service } = setup({ outcome: 'not_found', consentGrantId: null, patientId: null, status: null,
      expiresAt: null, existingGrant: false });
    const failure = await service.open(context, admissionId).catch((error: unknown) => error) as DomainProblem;
    expect([failure.getStatus(), failure.code]).toEqual([404, 'ADMISSION_NOT_FOUND']);
  });

  it.each([
    ['42501', 'WARD_STAY_ACCESS_REFUSED', 403, 'WARD_STAY_ACCESS_REFUSED'],
    ['22023', 'WARD_STAY_DIRECT_CARE_ONLY', 400, 'PURPOSE_OF_USE_REQUIRED'],
    ['42883', 'function identity.open_ward_stay(uuid) does not exist', 503, 'WARD_STAY_ACCESS_NOT_AVAILABLE'],
  ])('answers %s %s as %i %s', (sqlstate, message, status, code) => {
    const problem = translate(Object.assign(new Error(message), { code: sqlstate })) as DomainProblem;
    expect([problem.getStatus(), problem.code]).toEqual([status, code]);
  });

  it('audits a refusal raised before the database answers', async () => {
    const { service, audit } = setup(Object.assign(new Error('WARD_STAY_ACCESS_REFUSED'), { code: '42501' }));
    await service.open(context, admissionId).catch(() => undefined);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.ward-stay.open',
      outcome: 'denied', resourceId: admissionId, details: { code: 'WARD_STAY_ACCESS_REFUSED' } }));
  });

  it('no answer uses the word "permission"', () => {
    for (const text of Object.values(WARD_STAY_DETAIL)) expect(text.toLowerCase()).not.toContain('permission');
  });

  describe('the route', () => {
    it('POST identity/ward-stay-access needs ehr.ward.read and direct care; the admission by UUID only', async () => {
      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS, WardStayAccessController.prototype.openWardStay);
      expect(permissions).toEqual(['ehr.ward.read']);
      const open = jest.fn().mockResolvedValue({ consentGrantId: grantId });
      const routes = new WardStayAccessController({ open } as never);
      const emergency = { header: (name: string) => (name === 'x-purpose-of-use' ? 'emergency' : undefined) } as never;
      expect(() => routes.openWardStay(emergency, { admissionId }))
        .toThrow(expect.objectContaining({ code: 'PURPOSE_OF_USE_REQUIRED' }));
      expect(await validate(plainToInstance(WardStayAccessDto, { admissionId: 'HID-QX7K2M' }))).not.toHaveLength(0);
      expect(await validate(plainToInstance(WardStayAccessDto, { admissionId }))).toHaveLength(0);
    });
  });
});
