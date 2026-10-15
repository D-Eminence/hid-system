jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { HIGH_RISK_ACTION, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest, PlatformAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { assuredClient, type AssuranceOptions, platformActor, useTestEnvironment } from '../testing/platform-assurance';
import { AdminController } from './admin.controller';
import type { AdminOperationsService } from './admin-operations.service';
import { AdminService } from './admin.service';
import { AssistedRegistrationDesignationDto } from './dto/admin-command.dto';
import { PLATFORM_ACTION_POLICIES } from './high-risk-policy';
import type { PricingService } from './pricing.service';

/** ADR-063: platform designation of facilities for assisted registration. */
const facilityId = '10000000-0000-4000-8000-000000000002';
const context: PlatformAccessContext = {
  scope: 'platform', correlationId: 'assisted-admin-correlation', facilityId: null, membershipId: null,
  purposeOfUse: 'healthcare-operations', actor: platformActor({ id: 'staff:admin', subject: 'staff:admin' }),
};
const designation = { status: 'active' as const, addressLine: '1 Synthetic Road', town: 'Ikeja', lga: 'Ikeja',
  state: 'Lagos', hours: 'Mon-Fri 08:00-16:00', reason: 'Synthetic designation for the clinic' };

function harness(rows: (sql: string) => Record<string, unknown>[], assurance: AssuranceOptions = {}) {
  const command = jest.fn(async (sql: string) => { const result = rows(sql); return { rows: result, rowCount: result.length }; });
  const client = assuredClient(command as unknown as jest.Mock, assurance);
  const database = { withTransaction: jest.fn(async (_context, operation) => operation(client as unknown as PoolClient)) };
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminService(database as unknown as DatabaseService, audit as unknown as AuditService);
  return { service, command, audit, database };
}

useTestEnvironment();

describe('facility designation for assisted registration (ADR-063)', () => {
  it('is a high-tier platform action: facility management, step-up, reason, If-Match and an idempotency key', () => {
    expect(PLATFORM_ACTION_POLICIES['platform.facility.assisted-registration']).toEqual({ tier: 'high', stepUp: true,
      permissions: ['platform.facility.manage'], reason: true, ifMatch: true, idempotencyKey: true, approval: 'none' });
    const set = AdminController.prototype.setAssistedRegistration;
    expect(Reflect.getMetadata(PATH_METADATA, set)).toBe('facilities/:facilityId/assisted-registration');
    expect(Reflect.getMetadata(METHOD_METADATA, set)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, set)).toEqual(['platform.facility.manage']);
    expect(Reflect.getMetadata(HIGH_RISK_ACTION, set)).toBe('platform.facility.assisted-registration');
    const read = AdminController.prototype.assistedRegistration;
    expect(Reflect.getMetadata(PATH_METADATA, read)).toBe('facilities/:facilityId/assisted-registration');
    expect(Reflect.getMetadata(METHOD_METADATA, read)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, read)).toEqual(['platform.facility.read']);
  });

  it('takes If-Match 0 to designate a facility for the first time, and a positive version after', async () => {
    const admin = { setAssistedRegistration: jest.fn().mockResolvedValue({ facilityId, status: 'active', version: 1,
      replayed: false }) };
    const controller = new AdminController(admin as unknown as AdminService, {} as AdminOperationsService,
      {} as PricingService);
    const request = { actor: context.actor, accessScope: 'platform', correlationId: context.correlationId,
      header: jest.fn(() => undefined) } as unknown as HidRequest;
    for (const [ifMatch, version] of [['0', 0], ['"0"', 0], ['W/"3"', 3], ['3', 3]] as const) {
      await controller.setAssistedRegistration(facilityId, ifMatch, 'assisted-designation-key-01', designation, request);
      expect(admin.setAssistedRegistration).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'platform' }),
        facilityId, version, designation, 'assisted-designation-key-01');
    }
    for (const ifMatch of [undefined, '', '-1', 'abc', '1.5']) {
      const refusal = await controller.setAssistedRegistration(facilityId, ifMatch, 'assisted-designation-key-01',
        designation, request).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ status: 428, code: 'IF_MATCH_REQUIRED' });
    }
  });

  it('validates the designation: a status, the location a patient is shown and a reason', async () => {
    const valid = async (input: Record<string, unknown>) => validate(plainToInstance(AssistedRegistrationDesignationDto,
      input), { whitelist: true, forbidNonWhitelisted: true });
    expect(await valid(designation)).toEqual([]);
    expect(await valid({ status: 'suspended', town: 'Ikeja', lga: 'Ikeja', state: 'Lagos',
      reason: 'Synthetic suspension of the clinic' })).toEqual([]);
    for (const input of [{ ...designation, status: 'pending' }, { ...designation, town: '' },
      { ...designation, lga: 'x'.repeat(121) }, { ...designation, addressLine: 'x'.repeat(201) },
      { ...designation, reason: 'short' }, { ...designation, facilityId }]) {
      expect((await valid(input)).length).toBeGreaterThan(0);
    }
  });

  it('runs the designation command under a fresh step-up and audits it once', async () => {
    const h = harness((sql) => sql.includes('admin_set_facility_assisted_registration')
      ? [{ facility_id: facilityId, status: 'active', row_version: '1', replayed: false }] : []);
    await expect(h.service.setAssistedRegistration(context, facilityId, 0, designation, 'assisted-designation-key-01'))
      .resolves.toEqual({ facilityId, status: 'active', version: 1, replayed: false });
    const call = h.command.mock.calls.find(([sql]) => String(sql).includes('admin_set_facility_assisted_registration'))!;
    expect(call[1]).toEqual([facilityId, 0, 'active', '1 Synthetic Road', 'Ikeja', 'Ikeja', 'Lagos',
      'Mon-Fri 08:00-16:00', 'Synthetic designation for the clinic', 'assisted-designation-key-01',
      expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(h.audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.facility.assisted-registration.active', resourceType: 'facility', resourceId: facilityId,
      outcome: 'success', reason: 'Synthetic designation for the clinic' }));

    const replay = harness(() => [{ facility_id: facilityId, status: 'active', row_version: '1', replayed: true }]);
    await replay.service.setAssistedRegistration(context, facilityId, 0, designation, 'assisted-designation-key-01');
    expect(replay.audit.recordWithClient).not.toHaveBeenCalled();

    const stale = harness(() => [{ facility_id: facilityId, status: 'active', row_version: '1', replayed: false }],
      { stepUpFresh: false });
    const refusal = await stale.service.setAssistedRegistration(context, facilityId, 0, designation,
      'assisted-designation-key-01').catch((error: unknown) => error);
    expect(refusal).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(stale.command.mock.calls.some(([sql]) => String(sql).includes('admin_set_facility_assisted_registration')))
      .toBe(false);
  });

  it.each([
    ['ASSISTED_REGISTRATION_FACILITY_INACTIVE', 409, 'FACILITY_NOT_ACTIVE'],
    ['ADMIN_VERSION_CONFLICT', 409, 'VERSION_CONFLICT'],
    ['ADMIN_NO_STATE_CHANGE', 409, 'ADMIN_STATE_CONFLICT'],
    ['ADMIN_INVALID_ASSISTED_REGISTRATION', 400, 'ADMIN_COMMAND_INVALID'],
    ['ADMIN_FACILITY_NOT_FOUND', 404, 'ADMIN_RESOURCE_NOT_FOUND'],
    ['ADMIN_STEP_UP_REQUIRED', 403, 'STEP_UP_REQUIRED'],
  ] as const)('maps the refusal %s', async (message, status, code) => {
    const h = harness((sql) => { if (sql.includes('admin_set_facility_assisted_registration')) throw new Error(message); return []; });
    const refusal = await h.service.setAssistedRegistration(context, facilityId, 1, designation,
      'assisted-designation-key-01').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DomainProblem);
    expect(refusal).toMatchObject({ status, code });
    expect(h.audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('reads a designation, version 0 when the facility has none, and 404 for an unknown facility', async () => {
    const designated = harness((sql) => sql.includes('from identity.facilities') ? [{ id: facilityId }]
      : sql.includes('admin_facility_assisted_registration') ? [{ facility_id: facilityId, status: 'suspended',
        address_line: null, town: 'Ikeja', lga: 'Ikeja', state: 'Lagos', hours: null,
        reason: 'Synthetic suspension of the clinic', row_version: '4', updated_at: new Date('2026-10-15T08:00:00Z') }] : []);
    await expect(designated.service.assistedRegistration(context, facilityId)).resolves.toEqual({ facilityId,
      designated: true, status: 'suspended', addressLine: null, town: 'Ikeja', lga: 'Ikeja', state: 'Lagos', hours: null,
      reason: 'Synthetic suspension of the clinic', version: 4, updatedAt: '2026-10-15T08:00:00.000Z' });
    const none = harness((sql) => sql.includes('from identity.facilities') ? [{ id: facilityId }] : []);
    await expect(none.service.assistedRegistration(context, facilityId)).resolves.toEqual({ facilityId,
      designated: false, status: null, addressLine: null, town: null, lga: null, state: null, hours: null, reason: null,
      version: 0, updatedAt: null });
    const unknown = harness(() => []);
    await expect(unknown.service.assistedRegistration(context, facilityId))
      .rejects.toMatchObject({ status: 404, code: 'ADMIN_FACILITY_NOT_FOUND' });
  });
});
