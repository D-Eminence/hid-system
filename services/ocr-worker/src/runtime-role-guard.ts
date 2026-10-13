// Launch (DB-LOGIN-VERIFY): in production a service refuses to start over a
// database connection that would skip row-level security, the main control
// between facilities and patients. A superuser or BYPASSRLS role skips every
// policy, and a role with the privileges of a table's owner skips the
// policies of every table that does not force them (the Identity patient and
// consent tables among them). Each runtime credential must be its own
// non-owner LOGIN in one aggregate role; `npm run db:verify-logins` in
// services/ehr-api checks the rest. This file is identical in every service
// that connects to the database.

/** Schemas whose objects belong to the migration administrator or a technical owner. */
export const APPLICATION_SCHEMAS = Object.freeze([
  'platform', 'auth', 'identity', 'ehr', 'audit', 'ocr', 'lab', 'pharmacy', 'outreach',
  'integration', 'notification', 'migration',
]);

/** Both the authenticated role and the current role, so a role set by the URL cannot hide either. */
export const RUNTIME_ROLE_QUERY = `select bool_or(role_row.rolsuper) as superuser,
       bool_or(role_row.rolbypassrls) as bypass_rls,
       bool_or(exists (
         select 1 from pg_namespace namespace_row
          where namespace_row.nspname = any ($1::text[])
            and pg_has_role(role_row.oid, namespace_row.nspowner, 'USAGE')
       ) or exists (
         select 1 from pg_class relation
           join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
          where namespace_row.nspname = any ($1::text[])
            and pg_has_role(role_row.oid, relation.relowner, 'USAGE')
       ) or exists (
         select 1 from pg_proc proc
           join pg_namespace namespace_row on namespace_row.oid = proc.pronamespace
          where namespace_row.nspname = any ($1::text[])
            and pg_has_role(role_row.oid, proc.proowner, 'USAGE')
       )) as owner_privileges
  from pg_roles role_row
 where role_row.rolname in (current_user, session_user)`;

export interface RuntimeRoleRow {
  superuser: boolean | null;
  bypass_rls: boolean | null;
  owner_privileges: boolean | null;
}

export interface RuntimeRoleQueryable {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

export class UnsafeDatabaseRoleError extends Error {
  override readonly name = 'UnsafeDatabaseRoleError';
}

/** Throws unless the connected role is not a superuser, does not bypass RLS and owns nothing. */
export async function assertRuntimeDatabaseRole(database: RuntimeRoleQueryable): Promise<void> {
  const { rows } = await database.query(RUNTIME_ROLE_QUERY, [[...APPLICATION_SCHEMAS]]);
  const row = rows[0] as Partial<RuntimeRoleRow> | undefined;
  if (!row || typeof row.superuser !== 'boolean' || typeof row.bypass_rls !== 'boolean'
      || typeof row.owner_privileges !== 'boolean') {
    throw new UnsafeDatabaseRoleError('Refusing to start: the database role could not be verified');
  }
  const reasons = [
    row.superuser ? 'is a superuser' : null,
    row.bypass_rls ? 'bypasses row-level security' : null,
    row.owner_privileges ? 'has the privileges of an application schema object owner' : null,
  ].filter((reason): reason is string => reason !== null);
  if (reasons.length > 0) {
    throw new UnsafeDatabaseRoleError(`Refusing to start: the database role ${reasons.join(', ')}`);
  }
}
