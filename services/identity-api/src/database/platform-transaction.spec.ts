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
