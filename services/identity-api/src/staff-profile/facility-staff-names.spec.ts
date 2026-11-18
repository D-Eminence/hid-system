jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { PoolClient } from 'pg';
import {
  ACCOUNT_ONLY_ALLOWED, AUDIT_ACTION, FACILITY_OPTIONAL, PATIENT_ALLOWED, PUBLIC_ROUTE, REQUIRED_PERMISSIONS,
} from '../common/decorators';
import type { ActorContext, DataAccessContext, FacilityAssignment, HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { FacilityStaffNamesController } from './facility-staff-names.controller';
import { FacilityStaffNamesQueryDto } from './facility-staff-names.dto';
import { FACILITY_STAFF_NAMES_LIMIT, FACILITY_STAFF_NAMES_SQL, FacilityStaffNamesService } from './facility-staff-names.service';

const FACILITY = '30000000-0000-4000-8000-000000000001';
const SECOND_FACILITY = '30000000-0000-4000-8000-000000000002';
const OTHER_FACILITY = '30000000-0000-4000-8000-000000000009';
const ACCOUNT = '20000000-0000-4000-8000-000000000001';

function facility(id: string, membershipId: string, roles: string[], isPrimary: boolean): FacilityAssignment {
  return { id, membershipId, organizationId: '10000000-0000-4000-8000-000000000001', name: `Fictional Clinic ${id.slice(-1)}`,
    roles, permissions: ['ehr.encounter.read'], isPrimary };
}

const actor: ActorContext = {
  kind: 'staff', id: ACCOUNT, subject: 'staff:fictional-ada', accountId: ACCOUNT, displayName: 'Ada Fictional',
  email: 'ada@example.test', roles: ['doctor'], permissions: ['ehr.encounter.read'], facilityIds: [FACILITY, SECOND_FACILITY],
  facilities: [facility(FACILITY, '40000000-0000-4000-8000-000000000001', ['doctor'], true),
    facility(SECOND_FACILITY, '40000000-0000-4000-8000-000000000002', ['nurse', 'lab'], false)],
  authenticationMethod: 'local', products: ['ehr', 'migrate'],
};

function route(controller: { prototype: object }, name: string) {
  const handler = (controller.prototype as Record<string, unknown>)[name] as object;
  const meta = (key: symbol) => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller);
  return { base: Reflect.getMetadata(PATH_METADATA, controller), path: Reflect.getMetadata(PATH_METADATA, handler),
    method: Reflect.getMetadata(METHOD_METADATA, handler), audit: meta(AUDIT_ACTION), facilityOptional: meta(FACILITY_OPTIONAL),
    patientAllowed: meta(PATIENT_ALLOWED), accountOnly: meta(ACCOUNT_ONLY_ALLOWED), isPublic: meta(PUBLIC_ROUTE),
    permissions: meta(REQUIRED_PERMISSIONS) };
}

describe('GET identity/facility-staff-names (SX-9)', () => {
  const context = { correlationId: 'names-correlation', actor: { ...actor, facility: actor.facilities[0] }, facilityId: FACILITY,
    membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'healthcare-operations' } satisfies DataAccessContext;

  function setup(rows: Record<string, unknown>[]) {
    const query = jest.fn().mockResolvedValue({ rows });
    const withTransaction = jest.fn(async (_context: DataAccessContext, operation: (client: PoolClient) => Promise<unknown>) =>
      operation({ query } as unknown as PoolClient));
    return { query, withTransaction,
      service: new FacilityStaffNamesService({ withTransaction } as unknown as DatabaseService) };
  }

  function validate(query: Record<string, unknown>) {
    return validateSync(plainToInstance(FacilityStaffNamesQueryDto, query), { whitelist: true, forbidNonWhitelisted: true,
      forbidUnknownValues: true });
  }

  it('needs a facility (the header) and no permission beyond membership; audited', () => {
    expect(route(FacilityStaffNamesController, 'list')).toEqual({ base: 'identity', path: 'facility-staff-names',
      method: RequestMethod.GET, audit: 'identity.facility-staff-names.read', facilityOptional: undefined,
      patientAllowed: undefined, accountOnly: undefined, isPublic: undefined, permissions: undefined });
  });

  it('reads only the request\'s facility, read only, names and nothing else', async () => {
    const s = setup([{ membership_id: '40000000-0000-4000-8000-000000000002', name: 'Bola Fictional', current: true },
      { membership_id: '40000000-0000-4000-8000-000000000003', name: null, current: false }]);
    const answer = await s.service.list(context, undefined);
    expect(s.withTransaction).toHaveBeenCalledWith(context, expect.any(Function), { readOnly: true });
    expect(s.query).toHaveBeenCalledWith(FACILITY_STAFF_NAMES_SQL, [FACILITY, null, FACILITY_STAFF_NAMES_LIMIT + 1]);
    expect(FACILITY_STAFF_NAMES_SQL).toMatch(/where membership\.facility_id = \$1::uuid/);
    expect(FACILITY_STAFF_NAMES_SQL).not.toMatch(/email|license_number|password|patient/);
    expect(answer).toEqual({ facilityId: FACILITY, complete: true, staff: [
      { membershipId: '40000000-0000-4000-8000-000000000002', name: 'Bola Fictional', current: true },
      { membershipId: '40000000-0000-4000-8000-000000000003', name: null, current: false },
    ] });
  });

  it('another facility is never read: the guard binds the facility and the controller passes only that', async () => {
    const list = jest.fn().mockResolvedValue({});
    const controller = new FacilityStaffNamesController({ list } as unknown as FacilityStaffNamesService);
    const request = { actor: { ...actor, facility: actor.facilities[1] }, facilityId: SECOND_FACILITY, correlationId: 'c-2',
      header: () => undefined } as unknown as HidRequest;
    await controller.list({ membershipIds: '40000000-0000-4000-8000-00000000000A,40000000-0000-4000-8000-000000000002' }, request);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ facilityId: SECOND_FACILITY,
      purposeOfUse: 'healthcare-operations' }), ['40000000-0000-4000-8000-00000000000A', '40000000-0000-4000-8000-000000000002']);
    expect(validate({ facilityId: OTHER_FACILITY })).not.toEqual([]);
  });

  it('filters by up to 100 membership ids, lower-cased once each', async () => {
    const s = setup([]);
    await s.service.list(context, ['40000000-0000-4000-8000-00000000000A', '40000000-0000-4000-8000-00000000000a']);
    expect(s.query.mock.calls[0]![1]).toEqual([FACILITY, ['40000000-0000-4000-8000-00000000000a'], FACILITY_STAFF_NAMES_LIMIT + 1]);
    const hundred = Array.from({ length: 100 }, (_, index) => `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    expect(validate({ membershipIds: hundred.join(',') })).toEqual([]);
    expect(validate({ membershipIds: [...hundred, '40000000-0000-4000-8000-999999999999'].join(',') })).not.toEqual([]);
    for (const bad of ['', 'not-a-uuid', `${hundred[0]},`, `${hundred[0]};${hundred[1]}`, 'HID-ABC123']) {
      expect(validate({ membershipIds: bad })).not.toEqual([]);
    }
    expect(validate({ healthId: 'HID-ABC123' })).not.toEqual([]);
  });

  it('says when the list was cut at 500 names', async () => {
    const rows = Array.from({ length: FACILITY_STAFF_NAMES_LIMIT + 1 }, (_, index) =>
      ({ membership_id: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name: `Fictional ${index}`, current: true }));
    const answer = await setup(rows).service.list(context, undefined);
    expect(answer.staff).toHaveLength(FACILITY_STAFF_NAMES_LIMIT);
    expect(answer.complete).toBe(false);
  });
});
