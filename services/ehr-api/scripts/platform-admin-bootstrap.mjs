// The one-time platform Super Admin bootstrap (admin:bootstrap), as a module
// so its input rules and its transaction can be tested without a database.
//
// No administrator can grant another Super Admin alone: after 0070 a grant
// needs the decision of a second, MFA-enrolled Super Admin who is neither the
// requester nor the target, and after 0096 a clinician application is
// approved only by a Super Admin other than the one who attested it. So the
// bootstrap seeds the initial governance set, two or three distinct accounts
// (PLATFORM_ADMIN_ACCOUNT_IDS), in one audited transaction, and refuses once
// any Super Admin is active, so it can never add an administrator to a live
// set. The one-account form (PLATFORM_ADMIN_ACCOUNT_ID) stays for development
// and is refused when NODE_ENV is production, as the migration task runs in
// every AWS environment: one Super Admin alone could never add a second or
// approve a clinician application, and the state could not be repaired
// without direct SQL.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Reads and validates the bootstrap's environment. */
export function bootstrapInput(environment) {
  const single = environment.PLATFORM_ADMIN_ACCOUNT_ID?.trim();
  const set = environment.PLATFORM_ADMIN_ACCOUNT_IDS?.trim();
  const reason = environment.PLATFORM_ADMIN_BOOTSTRAP_REASON?.trim();
  if (single && set) {
    throw new Error('Set PLATFORM_ADMIN_ACCOUNT_IDS or PLATFORM_ADMIN_ACCOUNT_ID, not both');
  }
  let accountIds;
  if (set) {
    const entries = set.split(',').map((entry) => entry.trim());
    if (entries.some((entry) => !UUID_V4.test(entry))) {
      throw new Error('PLATFORM_ADMIN_ACCOUNT_IDS must list exact version-4 account UUIDs separated by commas');
    }
    accountIds = entries.map((entry) => entry.toLowerCase());
    if (accountIds.length < 2 || accountIds.length > 3 || new Set(accountIds).size !== accountIds.length) {
      throw new Error('PLATFORM_ADMIN_ACCOUNT_IDS must name two or three distinct accounts');
    }
  } else if (single) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('In production name two or three accounts in PLATFORM_ADMIN_ACCOUNT_IDS; '
        + 'PLATFORM_ADMIN_ACCOUNT_ID is for development only: one Super Admin alone can never add a second '
        + 'or approve a clinician application');
    }
    if (!UUID_V4.test(single)) throw new Error('PLATFORM_ADMIN_ACCOUNT_ID must be one exact version-4 account UUID');
    accountIds = [single.toLowerCase()];
  } else {
    throw new Error('PLATFORM_ADMIN_ACCOUNT_IDS (two or three account UUIDs) or PLATFORM_ADMIN_ACCOUNT_ID is required');
  }
  if (!reason || reason.length < 8 || reason.length > 500) {
    throw new Error('PLATFORM_ADMIN_BOOTSTRAP_REASON must contain 8 to 500 characters');
  }
  return { accountIds, reason };
}

/**
 * Grants platform_super_admin to every account, all or none, in one
 * transaction on a connected client. Refuses, and grants nothing, before
 * migration 0027, while any platform Super Admin (or legacy platform admin)
 * is active, or when an account is not active or has no password: platform
 * sign-in (0069) is password and TOTP, enrolled at the first sign-in.
 */
export async function bootstrapPlatformAdmins(client, { accountIds, reason }) {
  await client.query('begin');
  try {
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '30s'");
    await client.query("select pg_advisory_xact_lock(hashtextextended('hid-platform-admin-bootstrap', 0))");

    const migrated = await client.query(
      `select 1 from migration.schema_migrations
       where version = '0027_super_admin_foundation.sql'`,
    );
    if (migrated.rowCount !== 1) throw new Error('Migration 0027 must be applied before bootstrap');

    const existing = await client.query(
      `select count(distinct account.id)::integer as count
       from auth.accounts account
       join auth.account_roles assignment on assignment.account_id = account.id
       where assignment.scope_type = 'platform' and assignment.revoked_at is null
         and assignment.role_code in ('platform_super_admin', 'platform_admin')
         and account.status = 'active'
         and (account.disabled_until is null or account.disabled_until <= clock_timestamp())`,
    );
    if (Number(existing.rows[0]?.count ?? 0) !== 0) {
      throw new Error('Bootstrap refused: an active platform Super Admin already exists');
    }

    const eligible = await client.query(
      `select account.id
       from auth.accounts account
       where account.id = any($1::uuid[]) and account.status = 'active'
         and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
         and account.password_hash is not null
       order by account.id
       for update`,
      [accountIds],
    );
    const found = new Set(eligible.rows.map((row) => String(row.id).toLowerCase()));
    const ineligible = accountIds.filter((id) => !found.has(id));
    if (ineligible.length > 0) {
      throw new Error(`Bootstrap refused: account ${ineligible.join(', ')} is not active or has no password credential`);
    }

    for (const accountId of accountIds) {
      await client.query(
        `insert into auth.account_roles (
           id, account_id, role_code, scope_type, granted_by, grant_reason
         ) values (gen_random_uuid(), $1, 'platform_super_admin', 'platform', null, $2)`,
        [accountId, reason],
      );
      await client.query(
        `update auth.accounts
         set row_version = row_version + 1, updated_at = clock_timestamp()
         where id = $1`,
        [accountId],
      );
      await client.query(
        `insert into audit.events (
           correlation_id, actor_type, action, outcome, resource_type, resource_id,
           purpose_of_use, reason, provenance, source_system, details
         ) values (
           'platform-admin-bootstrap', 'system', 'admin.platform-role.bootstrap', 'success',
           'authentication-account', $1, 'healthcare-operations', $2, 'system',
           'platform-admin-bootstrap', jsonb_build_object('roleCode', 'platform_super_admin',
             'bootstrapAccounts', to_jsonb($3::text[]))
         )`,
        [accountId, reason, accountIds],
      );
    }
    await client.query('commit');
    return accountIds;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}
