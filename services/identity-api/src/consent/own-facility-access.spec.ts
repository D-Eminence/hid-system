import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { ConsentController } from './consent.controller';
import { ConsentService, OWN_FACILITY_DETAIL } from './consent.service';
import { OpenOwnFacilityDto } from './dto/open-own-facility.dto';
import { REQUIRED_PERMISSIONS } from '../common/decorators';

// 0131 (ID-4, owner Q101 of 18 November 2026). Fictional identifiers only.
const facilityId = '0c0d0e0f-0000-4000-8000-000000000002';
const patientId = '0c0d0e0f-0000-4000-8000-000000000401';
const grantId = '0c0d0e0f-0000-4000-8000-000000000701';
const expiresAt = new Date('2026-11-19T10:00:00.000Z');

const context = {
  actor: { kind: 'staff', subject: 'synthetic:own-doctor', accountId: '0c0d0e0f-0000-4000-8000-000000000101',
    permissions: ['identity.patient.open-own-facility'],
    facility: { facilityId, organizationId: '0c0d0e0f-0000-4000-8000-000000000001', roles: ['doctor'] } },
  facilityId, membershipId: '0c0d0e0f-0000-4000-8000-000000000301', correlationId: 'own-facility-spec-01',
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
  return { service: new ConsentService(database as never, audit as never), statements, audit };
}

describe('opening this facility\'s own patient (0131, ID-4)', () => {
  it('opens with basis own-facility: 24 hours of read and write for direct care', async () => {
    const { service, statements } = setup({ outcome: 'opened', consentGrantId: grantId, patientId, status: 'active',
      expiresAt, existingGrant: false });
    const answer = await service.openOwnFacilityPatient(context, { hid: 'HID-QX7K2M' });
    expect(answer).toEqual({ consentGrantId: grantId, patientId, status: 'active', expiresAt, existingGrant: false,
      authorization: { basis: 'own-facility', scope: 'write_records', purpose: 'direct-care' } });
    expect(statements[0]!.sql).toContain('identity.open_own_facility_patient($1, $2::uuid)');
    expect(statements[0]!.values).toEqual(['HID-QX7K2M', null]);
  });

  it('takes a patient id instead of a Health ID', async () => {
    const { service, statements } = setup({ outcome: 'opened', consentGrantId: grantId, patientId, status: 'active',
      expiresAt, existingGrant: true });
    await expect(service.openOwnFacilityPatient(context, { patientId })).resolves.toMatchObject({ existingGrant: true });
    expect(statements[0]!.values).toEqual([null, patientId]);
  });

  it('answers a Health ID that does not exist with "No such patient" (owner Q100 B)', async () => {
    const { service } = setup({ outcome: 'not_found', consentGrantId: null, patientId: null, status: null,
      expiresAt: null, existingGrant: false });
    const failure = await service.openOwnFacilityPatient(context, { hid: 'HID-QX7K2M' }).catch((error: unknown) => error);
    expect((failure as DomainProblem).getStatus()).toBe(404);
    expect((failure as DomainProblem).code).toBe('PATIENT_NOT_FOUND');
    expect(JSON.stringify((failure as DomainProblem).getResponse())).toContain(OWN_FACILITY_DETAIL.notFound);
  });

  it('refuses a patient who is not this facility\'s with one answer, whatever the reason', async () => {
    const { service } = setup({ outcome: 'refused', consentGrantId: null, patientId: null, status: null,
      expiresAt: null, existingGrant: false });
    const failure = await service.openOwnFacilityPatient(context, { hid: 'HID-QX7K2M' }).catch((error: unknown) => error);
    expect((failure as DomainProblem).getStatus()).toBe(403);
    expect((failure as DomainProblem).code).toBe('OWN_FACILITY_ACCESS_REFUSED');
    expect(OWN_FACILITY_DETAIL.refused).toMatch(/Access PIN or send an access request/);
  });

  it.each([
    ['42501', 'OWN_FACILITY_ACCESS_NOT_PERMITTED', 403, 'OWN_FACILITY_ACCESS_NOT_PERMITTED'],
    ['22023', 'OWN_FACILITY_ACCESS_DIRECT_CARE_ONLY', 400, 'PURPOSE_OF_USE_REQUIRED'],
    ['22023', 'OWN_FACILITY_ACCESS_INVALID', 400, 'PATIENT_IDENTIFIER_REQUIRED'],
    ['42883', 'function identity.open_own_facility_patient does not exist', 503, 'OWN_FACILITY_ACCESS_UNAVAILABLE'],
  ])('answers %s %s as %s %s and audits the refusal', async (sqlstate, message, status, code) => {
    const { service, audit } = setup(Object.assign(new Error(message), { code: sqlstate }));
    const failure = await service.openOwnFacilityPatient(context, { hid: 'HID-QX7K2M' }).catch((error: unknown) => error);
    expect((failure as DomainProblem).getStatus()).toBe(status);
    expect((failure as DomainProblem).code).toBe(code);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.patient.open-own-facility',
      outcome: 'denied', facilityId, details: { code, identifiedBy: 'health_id' } }));
  });

  it('never says "unverified"', () => {
    expect(JSON.stringify(OWN_FACILITY_DETAIL)).not.toMatch(/unverified/i);
  });

  describe('the route', () => {
    it('needs identity.patient.open-own-facility', () => {
      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS, ConsentController.prototype.openOwnFacilityPatient);
      expect(permissions).toEqual(['identity.patient.open-own-facility']);
    });

    it('takes exactly one identifier', async () => {
      const routes = new ConsentController({ openOwnFacilityPatient: jest.fn() } as never);
      const request = { header: (name: string) => (name === 'x-purpose-of-use' ? 'direct-care' : undefined) } as never;
      expect(() => routes.openOwnFacilityPatient(request, { hid: 'HID-QX7K2M', patientId }))
        .toThrow(expect.objectContaining({ code: 'PATIENT_IDENTIFIER_REQUIRED' }));
      expect((await validate(plainToInstance(OpenOwnFacilityDto, { hid: 'hid-qx7k2m' })))).toEqual([]);
      expect((await validate(plainToInstance(OpenOwnFacilityDto, { patientId })))).toEqual([]);
      expect((await validate(plainToInstance(OpenOwnFacilityDto, {}))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(OpenOwnFacilityDto, { hid: 'HID-0000' }))).length).toBeGreaterThan(0);
    });
  });
});
