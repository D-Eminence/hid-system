import type { PoolClient } from 'pg';
import * as environment from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { facilityRouteOpen, onlineRouteOpen, ownershipRoutes, PARTICIPATING_FACILITY_READ } from './ownership-routes';

// The holder routes (ADR-062, ADR-063), shared by the enrollment service and
// the admin integration status so that both read the same production rule.
describe('ownership routes', () => {
  const participatingRead = 'select exists(select 1 from identity.list_participating_facilities()) as open';

  function withEnvironment(values: Partial<environment.Environment>) {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({
      NODE_ENV: 'test', HID_DEPLOYMENT_ENV: undefined, NIN_HOLDER_SMS_ENABLED: false,
      ASSISTED_REGISTRATION_ENABLED: false, ...values,
    } as unknown as environment.Environment);
  }

  function database(rows: unknown[] | Error = [{ open: true }]) {
    const client = { query: jest.fn(async () => {
      if (rows instanceof Error) throw rows;
      return { rows };
    }) };
    const db = { withSystemTransaction: jest.fn(async (_correlationId: string,
      operation: (client: PoolClient) => unknown) => operation(client as unknown as PoolClient)) };
    return { client, db: db as unknown as Pick<DatabaseService, 'withSystemTransaction'>, withSystem: db.withSystemTransaction };
  }

  afterEach(() => jest.restoreAllMocks());

  it('reads participation with the SQL the enrollment service has always sent', () => {
    expect(PARTICIPATING_FACILITY_READ).toBe(participatingRead);
  });

  it.each([
    ['development', { NODE_ENV: 'development' }, false, true],
    ['staging, even with NODE_ENV production', { NODE_ENV: 'production', HID_DEPLOYMENT_ENV: 'staging' }, false, true],
    ['the production deployment, no facility', { NODE_ENV: 'production', HID_DEPLOYMENT_ENV: 'production' }, false, false],
    ['the production deployment, a facility', { NODE_ENV: 'production', HID_DEPLOYMENT_ENV: 'production' }, true, true],
    ['NODE_ENV production outside staging, no facility', { NODE_ENV: 'production' }, false, false],
    ['NODE_ENV production outside staging, a facility', { NODE_ENV: 'production' }, true, true],
  ])('opens the online route in %s only as the production rule allows', (_name, profile, facilityOpen, expected) => {
    expect(onlineRouteOpen({ NIN_HOLDER_SMS_ENABLED: true, ...profile } as Parameters<typeof onlineRouteOpen>[0],
      facilityOpen)).toBe(expected);
    expect(onlineRouteOpen({ NIN_HOLDER_SMS_ENABLED: false, ...profile } as Parameters<typeof onlineRouteOpen>[0],
      facilityOpen)).toBe(false);
  });

  it('reads no facility while ASSISTED_REGISTRATION_ENABLED is off', async () => {
    withEnvironment({ ASSISTED_REGISTRATION_ENABLED: false });
    const { db, withSystem } = database();
    await expect(facilityRouteOpen(db, 'routes-test')).resolves.toBe(false);
    expect(withSystem).not.toHaveBeenCalled();
  });

  it('reads participation in a system transaction, open only for a true answer', async () => {
    withEnvironment({ ASSISTED_REGISTRATION_ENABLED: true });
    const open = database([{ open: true }]);
    await expect(facilityRouteOpen(open.db, 'routes-test')).resolves.toBe(true);
    expect(open.withSystem).toHaveBeenCalledWith('routes-test', expect.any(Function));
    expect(open.client.query.mock.calls).toEqual([[participatingRead]]);
    await expect(facilityRouteOpen(database([{ open: false }]).db, 'routes-test')).resolves.toBe(false);
    await expect(facilityRouteOpen(database([]).db, 'routes-test')).resolves.toBe(false);
  });

  it('lets a failed read reach the caller, which decides how to fail closed', async () => {
    withEnvironment({ ASSISTED_REGISTRATION_ENABLED: true });
    await expect(facilityRouteOpen(database(new Error('read failed')).db, 'routes-test')).rejects.toThrow('read failed');
  });

  it('closes both routes in production while no facility takes part', async () => {
    withEnvironment({ HID_DEPLOYMENT_ENV: 'production', NIN_HOLDER_SMS_ENABLED: true, ASSISTED_REGISTRATION_ENABLED: true });
    const { db, withSystem } = database([{ open: false }]);
    await expect(ownershipRoutes(db, 'routes-test')).resolves.toEqual({ online: false, facility: false });
    expect(withSystem).toHaveBeenCalledTimes(1);
    await expect(ownershipRoutes(database([{ open: true }]).db, 'routes-test'))
      .resolves.toEqual({ online: true, facility: true });
  });

  it('opens the online route alone outside production, from one read at most', async () => {
    withEnvironment({ NIN_HOLDER_SMS_ENABLED: true });
    const { db, withSystem } = database();
    await expect(ownershipRoutes(db, 'routes-test')).resolves.toEqual({ online: true, facility: false });
    expect(withSystem).not.toHaveBeenCalled();
    withEnvironment({ ASSISTED_REGISTRATION_ENABLED: true });
    const facility = database([{ open: true }]);
    await expect(ownershipRoutes(facility.db, 'routes-test')).resolves.toEqual({ online: false, facility: true });
    expect(facility.withSystem).toHaveBeenCalledTimes(1);
  });
});
