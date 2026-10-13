import {
  APPLICATION_SCHEMAS, RUNTIME_ROLE_QUERY, UnsafeDatabaseRoleError, assertRuntimeDatabaseRole,
} from './runtime-role-guard';
import { DatabaseService } from './database.service';

/** A fake pool that records each query and answers with one role row (or none). */
function fakePool(row?: Record<string, unknown>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let ended = 0;
  return {
    calls,
    ended: () => ended,
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: row === undefined ? [] : [row] };
    },
    end: async () => { ended += 1; },
  };
}
const safe = { superuser: false, bypass_rls: false, owner_privileges: false };

describe('runtime database role guard', () => {
  it('accepts a role that is not a superuser, does not bypass row-level security and owns nothing', async () => {
    const pool = fakePool(safe);
    await expect(assertRuntimeDatabaseRole(pool)).resolves.toBeUndefined();
    expect(pool.calls).toEqual([{ text: RUNTIME_ROLE_QUERY, values: [[...APPLICATION_SCHEMAS]] }]);
  });

  it.each([
    [{ superuser: true }, 'is a superuser'],
    [{ bypass_rls: true }, 'bypasses row-level security'],
    [{ owner_privileges: true }, 'has the privileges of an application schema object owner'],
    [{ superuser: true, bypass_rls: true, owner_privileges: true },
      'is a superuser, bypasses row-level security, has the privileges of an application schema object owner'],
  ])('refuses a role with %j', async (unsafe, reason) => {
    await expect(assertRuntimeDatabaseRole(fakePool({ ...safe, ...unsafe })))
      .rejects.toThrow(new UnsafeDatabaseRoleError(`Refusing to start: the database role ${reason}`));
  });

  it.each([[undefined], [{ ...safe, superuser: null }], [{ superuser: false, bypass_rls: false }]])(
    'refuses when the role cannot be read (%j)', async (row) => {
      await expect(assertRuntimeDatabaseRole(fakePool(row)))
        .rejects.toThrow(new UnsafeDatabaseRoleError('Refusing to start: the database role could not be verified'));
    });

  it('reads both the authenticated and the current role, and owners in every application schema', () => {
    expect(RUNTIME_ROLE_QUERY).toContain('where role_row.rolname in (current_user, session_user)');
    expect(RUNTIME_ROLE_QUERY.match(/pg_has_role\(role_row\.oid, [a-z_.]+, 'USAGE'\)/g)).toEqual([
      "pg_has_role(role_row.oid, namespace_row.nspowner, 'USAGE')",
      "pg_has_role(role_row.oid, relation.relowner, 'USAGE')",
      "pg_has_role(role_row.oid, proc.proowner, 'USAGE')",
    ]);
    expect(APPLICATION_SCHEMAS).toEqual(['platform', 'auth', 'identity', 'ehr', 'audit', 'ocr', 'lab',
      'pharmacy', 'outreach', 'integration', 'notification', 'migration']);
  });
});

describe('DatabaseService start-up role check', () => {
  function service(production: boolean, row?: Record<string, unknown>, workloadPool?: ReturnType<typeof fakePool>) {
    const pool = fakePool(row);
    const database = Object.create(DatabaseService.prototype) as DatabaseService;
    Object.assign(database, { pool, verifyRuntimeRole: production, workloadPool });
    return { database, pool };
  }

  it('refuses to start in production over an unsafe role', async () => {
    const { database, pool } = service(true, { ...safe, bypass_rls: true });
    await expect(database.onModuleInit()).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
    expect(pool.calls).toHaveLength(1);
  });

  it('starts in production over a safe role', async () => {
    const { database, pool } = service(true, safe);
    await expect(database.onModuleInit()).resolves.toBeUndefined();
    expect(pool.calls).toHaveLength(1);
  });

  it('does not query the role outside production', async () => {
    const { database, pool } = service(false);
    await expect(database.onModuleInit()).resolves.toBeUndefined();
    expect(pool.calls).toHaveLength(0);
  });

  it('also refuses an unsafe scanner workload pool', async () => {
    const workloadPool = fakePool({ ...safe, superuser: true });
    const { database, pool } = service(true, safe, workloadPool);
    await expect(database.onModuleInit()).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
    expect(pool.calls).toHaveLength(1);
    expect(workloadPool.calls).toHaveLength(1);
  });
});
