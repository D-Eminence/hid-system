jest.mock('../config/environment', () => ({ getEnvironment: () => ({ DATABASE_URL: 'postgresql://unused',
  DATABASE_SSL: false, DATABASE_POOL_MAX: 1 }) }));
jest.mock('pg', () => ({ Pool: jest.fn(() => ({ connect: jest.fn() })) }));
import { UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';
import type { ActorContext, PlatformAdminContext } from '../common/request-context';
import { DatabaseService } from './database.service';

describe('Explicit platform database transaction', () => {
  const actor: ActorContext = { id: 'admin-subject', subject: 'admin-subject', accountId: 'admin-account',
    roles: [], permissions: [], facilities: [], facilityIds: [], platformPermissions: ['platform.admin.access'],
    authenticationMethod: 'local' };
  const context: PlatformAdminContext = { actor, correlationId: 'admin-context-test', purposeOfUse: 'healthcare-operations' };
  function setup() {
    const query = jest.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    const release = jest.fn();
    const connect = jest.fn(async () => ({ query, release }));
    jest.mocked(Pool).mockImplementation(() => ({ connect, on: jest.fn() } as unknown as Pool));
    return { service: new DatabaseService(), query, release, connect };
  }
  it('binds real actor and purpose with blank facility and membership instead of fabricated IDs', async () => {
    const { service, query, release } = setup();
    await expect(service.withPlatformTransaction(context, async () => 'ok')).resolves.toBe('ok');
    const binding = query.mock.calls.find(([sql]) => String(sql).includes('app.actor_subject'));
    expect(binding?.[1]).toEqual(['admin-subject', '', 'admin-context-test', '', 'healthcare-operations']);
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });
  it.each([
    { actor: { ...actor, platformPermissions: [] } },
    { actor: { ...actor, kind: 'patient' as const } },
    { purposeOfUse: 'direct-care' as const },
  ])('denies an unapproved or clinical platform context before connecting', async invalid => {
    const { service, connect } = setup();
    await expect(service.withPlatformTransaction({ ...context, ...invalid }, async () => 'unexpected'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('A staff member\'s own-account transaction (SX-7)', () => {
  const staff: ActorContext = { kind: 'staff', id: 'staff-subject', subject: 'staff-subject', accountId: 'staff-account',
    roles: [], permissions: [], facilities: [], facilityIds: [], authenticationMethod: 'local' };
  function setup() {
    const query = jest.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    const release = jest.fn();
    const connect = jest.fn(async () => ({ query, release }));
    jest.mocked(Pool).mockImplementation(() => ({ connect, on: jest.fn() } as unknown as Pool));
    return { service: new DatabaseService(), query, release, connect };
  }
  const binding = (query: jest.Mock) => query.mock.calls.find(([sql]) => String(sql).includes('app.actor_subject'))?.[1];

  it('binds the actor with no facility, membership or purpose when the request named no facility', async () => {
    const { service, query } = setup();
    await expect(service.withStaffAccountTransaction({ actor: staff, correlationId: 'staff-own-context' },
      async () => 'ok', { readOnly: true })).resolves.toBe('ok');
    expect(binding(query)).toEqual(['staff-subject', '', 'staff-own-context', '', '']);
    expect(query.mock.calls.map(([sql]) => String(sql))).toContain('SET TRANSACTION READ ONLY');
  });

  it('binds the facility and membership the request resolved', async () => {
    const { service, query } = setup();
    await service.withStaffAccountTransaction({ actor: staff, correlationId: 'staff-own-context', facilityId: 'facility-1',
      membershipId: 'membership-1' }, async () => undefined);
    expect(binding(query)).toEqual(['staff-subject', 'facility-1', 'staff-own-context', 'membership-1', '']);
  });

  it('refuses a patient before connecting', async () => {
    const { service, connect } = setup();
    await expect(service.withStaffAccountTransaction({ actor: { ...staff, kind: 'patient' }, correlationId: 'x-context' },
      async () => 'unexpected')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(connect).not.toHaveBeenCalled();
  });
});
