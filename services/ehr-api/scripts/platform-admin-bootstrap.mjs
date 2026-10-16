// The one-time platform Super Admin bootstrap (admin:bootstrap), as a module
// so its input rules and its transaction can be tested without a database.
//
// No administrator can grant another Super Admin alone: after 0070 a grant
// needs the decision of a second, MFA-enrolled Super Admin who is neither the
// requester nor the target, and after 0096 a clinician application is
// approved only by a Super Admin other than the one who attested it. So the
// bootstrap seeds the initial governance set, two or three people, in one
// audited transaction, and refuses while any Super Admin exists, whatever its
// status, so it can never add an administrator beside a set already seeded.
//
// It takes exactly one of three inputs:
// - PLATFORM_ADMIN_EMAILS (owner decision 2026-10-16, SUPERADMIN-ACCOUNTS:
//   "By email, own password"): two or three email addresses. A new database
//   has no account, so the bootstrap creates a platform-only account for each
//   address, with no password and no staff or patient record, pending_reset,
//   and grants each Super Admin. Each person then sets their own password with
//   the admin password reset (an emailed code; 0086 lets the platform recovery
//   reach an administrator still setting a password) and enrols an
//   authenticator at the first platform sign-in. Nobody else ever knows the
//   password. PLATFORM_ADMIN_REPLACE_PENDING=1 replaces such a set (a mistyped
//   address) while nobody has used any of its accounts.
// - PLATFORM_ADMIN_ACCOUNT_IDS: two or three existing accounts, each active
//   with an email address and a password.
// - PLATFORM_ADMIN_ACCOUNT_ID: one existing account, for development only. It
//   is refused when NODE_ENV is production, as the migration task runs in
//   every AWS environment: one Super Admin alone could never add a second or
//   approve a clinician application, and the state could not be repaired
//   without direct SQL.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// A conservative single address, after normalization: a dot-atom local part
// of at most 64 characters, and a domain of DNS labels ending in a letters-only
// top-level label. Every such address also passes 0087's staff email rule,
// the recovery start's identifier rule and platform sign-in's IsEmail, and
// none carries a display name, quotes, brackets, an IP literal or a space.
const EMAIL = /^(?=[^@]{1,64}@)[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const FORMS = ['PLATFORM_ADMIN_ACCOUNT_IDS', 'PLATFORM_ADMIN_EMAILS', 'PLATFORM_ADMIN_ACCOUNT_ID'];

/** Staff email normalization, as 0087 (lower(btrim(email))) and Identity (trim, toLowerCase) apply it. */
function normalizeEmail(value) {
  return value.trim().toLowerCase();
}

/**
 * Reads and validates the bootstrap's environment, before any connection.
 * An error names the variable and never echoes an address or other value.
 */
export function bootstrapInput(environment) {
  const values = Object.fromEntries(FORMS.map((name) => [name, environment[name]?.trim()]));
  const given = FORMS.filter((name) => values[name]);
  if (given.length === 2) throw new Error(`Set ${given[0]} or ${given[1]}, not both`);
  if (given.length === 3) {
    throw new Error('Set only one of PLATFORM_ADMIN_ACCOUNT_IDS, PLATFORM_ADMIN_EMAILS and PLATFORM_ADMIN_ACCOUNT_ID');
  }
  const replace = environment.PLATFORM_ADMIN_REPLACE_PENDING?.trim() ?? '';
  if (replace !== '' && replace !== '1') throw new Error('PLATFORM_ADMIN_REPLACE_PENDING must be 1 or unset');
  if (replace === '1' && given[0] !== 'PLATFORM_ADMIN_EMAILS') {
    throw new Error('PLATFORM_ADMIN_REPLACE_PENDING applies only with PLATFORM_ADMIN_EMAILS');
  }
  const reason = environment.PLATFORM_ADMIN_BOOTSTRAP_REASON?.trim();
  let input;
  if (values.PLATFORM_ADMIN_EMAILS) {
    const entries = values.PLATFORM_ADMIN_EMAILS.split(/\s*,\s*|\s+/);
    if (entries.some((entry) => entry === '')) {
      throw new Error('PLATFORM_ADMIN_EMAILS must list two or three email addresses separated by commas or spaces');
    }
    const emails = entries.map(normalizeEmail);
    const malformed = emails.findIndex((email) => email.length > 254 || !EMAIL.test(email));
    if (malformed >= 0) {
      throw new Error(`PLATFORM_ADMIN_EMAILS entry ${malformed + 1} is not a single plain email address `
        + '(no display name, at most 254 characters)');
    }
    if (emails.length < 2 || emails.length > 3) {
      throw new Error('PLATFORM_ADMIN_EMAILS must list two or three email addresses separated by commas or spaces');
    }
    if (new Set(emails).size !== emails.length) {
      throw new Error('PLATFORM_ADMIN_EMAILS must name two or three distinct addresses');
    }
    input = { emails, reason, replacePending: replace === '1' };
  } else if (values.PLATFORM_ADMIN_ACCOUNT_IDS) {
    const entries = values.PLATFORM_ADMIN_ACCOUNT_IDS.split(',').map((entry) => entry.trim());
    if (entries.some((entry) => !UUID_V4.test(entry))) {
      throw new Error('PLATFORM_ADMIN_ACCOUNT_IDS must list exact version-4 account UUIDs separated by commas');
    }
    const accountIds = entries.map((entry) => entry.toLowerCase());
    if (accountIds.length < 2 || accountIds.length > 3 || new Set(accountIds).size !== accountIds.length) {
      throw new Error('PLATFORM_ADMIN_ACCOUNT_IDS must name two or three distinct accounts');
    }
    input = { accountIds, reason };
  } else if (values.PLATFORM_ADMIN_ACCOUNT_ID) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('In production name two or three accounts in PLATFORM_ADMIN_ACCOUNT_IDS; '
        + 'PLATFORM_ADMIN_ACCOUNT_ID is for development only: one Super Admin alone can never add a second '
        + 'or approve a clinician application');
    }
    if (!UUID_V4.test(values.PLATFORM_ADMIN_ACCOUNT_ID)) {
      throw new Error('PLATFORM_ADMIN_ACCOUNT_ID must be one exact version-4 account UUID');
    }
    input = { accountIds: [values.PLATFORM_ADMIN_ACCOUNT_ID.toLowerCase()], reason };
  } else {
    throw new Error('PLATFORM_ADMIN_EMAILS (two or three email addresses), PLATFORM_ADMIN_ACCOUNT_IDS (two or three '
      + 'account UUIDs) or PLATFORM_ADMIN_ACCOUNT_ID is required');
  }
  if (!reason || reason.length < 8 || reason.length > 500) {
    throw new Error('PLATFORM_ADMIN_BOOTSTRAP_REASON must contain 8 to 500 characters');
  }
  return input;
}

const EXISTING_SUPER_ADMIN_REFUSAL = 'Bootstrap refused: a platform Super Admin already exists, in any status but deleted';

/**
 * Every non-deleted account that holds an unrevoked platform Super Admin (or
 * legacy platform admin) assignment, whatever its status: an account the
 * email form seeded stays pending_reset until its owner sets a password, and
 * a disabled or locked one is still part of the set.
 */
const EXISTING_SUPER_ADMINS = `select count(distinct account.id)::integer as count
   from auth.accounts account
   join auth.account_roles assignment on assignment.account_id = account.id
   where assignment.scope_type = 'platform' and assignment.revoked_at is null
     and assignment.role_code in ('platform_super_admin', 'platform_admin')
     and account.status <> 'deleted'`;

/** Opens the bootstrap transaction: timeouts, the advisory lock and the 0027 check. */
async function beginBootstrap(client) {
  await client.query('begin');
  await client.query("set local lock_timeout = '5s'");
  await client.query("set local statement_timeout = '30s'");
  await client.query("select pg_advisory_xact_lock(hashtextextended('hid-platform-admin-bootstrap', 0))");
  const migrated = await client.query(
    `select 1 from migration.schema_migrations
     where version = '0027_super_admin_foundation.sql'`,
  );
  if (migrated.rowCount !== 1) throw new Error('Migration 0027 must be applied before bootstrap');
}

async function existingSuperAdmins(client) {
  return Number((await client.query(EXISTING_SUPER_ADMINS)).rows[0]?.count ?? 0);
}

/** Grants platform_super_admin and writes its audit event, as both forms do. */
async function grantSuperAdmin(client, accountId, reason, details) {
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
  await client.query(details.sql, details.params);
}

/**
 * Grants platform_super_admin to every existing account, all or none, in one
 * transaction on a connected client. Refuses, and grants nothing, before
 * migration 0027, while any account holds a platform Super Admin (or legacy
 * platform admin) assignment, or when an account is not active or has no
 * email address or no password: platform sign-in (0069) is email, password
 * and TOTP, enrolled at the first sign-in, and finds the account by its email
 * alone, so a phone-only account seeded here could never sign in, yet would
 * count as a Super Admin and stop every later run.
 */
export async function bootstrapPlatformAdmins(client, { accountIds, reason }) {
  try {
    await beginBootstrap(client);
    if (await existingSuperAdmins(client) !== 0) throw new Error(EXISTING_SUPER_ADMIN_REFUSAL);

    const eligible = await client.query(
      `select account.id
       from auth.accounts account
       where account.id = any($1::uuid[]) and account.status = 'active'
         and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
         and account.password_hash is not null
         and account.email is not null and btrim(account.email) <> ''
       order by account.id
       for update`,
      [accountIds],
    );
    const found = new Set(eligible.rows.map((row) => String(row.id).toLowerCase()));
    const ineligible = accountIds.filter((id) => !found.has(id));
    if (ineligible.length > 0) {
      throw new Error(`Bootstrap refused: account ${ineligible.join(', ')} is not active or has no email address and `
        + 'password credential; platform sign-in is by email and password');
    }

    for (const accountId of accountIds) {
      await grantSuperAdmin(client, accountId, reason, {
        sql: `insert into audit.events (
           correlation_id, actor_type, action, outcome, resource_type, resource_id,
           purpose_of_use, reason, provenance, source_system, details
         ) values (
           'platform-admin-bootstrap', 'system', 'admin.platform-role.bootstrap', 'success',
           'authentication-account', $1, 'healthcare-operations', $2, 'system',
           'platform-admin-bootstrap', jsonb_build_object('roleCode', 'platform_super_admin',
             'bootstrapAccounts', to_jsonb($3::text[]))
         )`,
        params: [accountId, reason, accountIds],
      });
    }
    await client.query('commit');
    return accountIds;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

/**
 * The email form (owner decision 2026-10-16). In one transaction on a
 * connected client, after the advisory lock: refuses while any Super Admin
 * exists (unless replacing, below) or while an address belongs to any
 * non-deleted account or a staff record; then creates, for each address in
 * order, a platform-only account (subject 'platform:<id>', the normalized
 * address, no display name, pending_reset, source 'hid', no password, email
 * not marked verified), grants it platform_super_admin as the account ID form
 * does, and writes one audit event per account that marks the method and
 * carries no address.
 *
 * With `replacePending` (PLATFORM_ADMIN_REPLACE_PENDING=1), and only when
 * every account holding a Super Admin assignment is one this email form
 * created that nobody has used (pending_reset, no password, session,
 * authenticator, external sign-in, staff or patient record), it first revokes
 * all of those accounts' assignments and marks the accounts deleted, audited,
 * so a mistyped address can be corrected. Rows are locked first, so a
 * recovery completing at the same time either finishes before (and the
 * replacement is refused) or finds the account deleted.
 *
 * Returns the new account IDs, in the order of the addresses, and the
 * replaced ones.
 */
export async function bootstrapPlatformAdminsByEmail(client, { emails, reason, replacePending }) {
  try {
    await beginBootstrap(client);
    const recovery = await client.query(
      `select 1 from migration.schema_migrations
       where version = '0086_recovery_and_patient_search_hardening.sql'`,
    );
    if (recovery.rowCount !== 1) {
      throw new Error('Migration 0086 must be applied before the email bootstrap: the admin password reset needs it');
    }

    const holders = await existingSuperAdmins(client);
    let replacedAccountIds = [];
    if (replacePending) {
      if (holders === 0) throw new Error('Bootstrap refused: PLATFORM_ADMIN_REPLACE_PENDING=1 but no Super Admin exists to replace');
      const candidates = await client.query(
        `select account.id::text as id,
           (account.status = 'pending_reset'
             and account.password_hash is null and account.password_algorithm is null and account.password_changed_at is null
             and account.subject = 'platform:' || account.id::text
             and not exists (select 1 from auth.sessions session_row where session_row.account_id = account.id)
             and not exists (select 1 from auth.mfa_factors factor where factor.account_id = account.id)
             and not exists (select 1 from auth.external_identities external_row where external_row.account_id = account.id)
             and not exists (select 1 from identity.staff staff_row where staff_row.account_id = account.id)
             and not exists (select 1 from identity.patients patient_row where patient_row.account_id = account.id)
             and exists (select 1 from audit.events event
                          where event.action = 'admin.platform-role.bootstrap' and event.outcome = 'success'
                            and event.actor_type = 'system' and event.source_system = 'platform-admin-bootstrap'
                            and event.resource_type = 'authentication-account' and event.resource_id = account.id::text
                            and event.details->>'method' = 'email' and event.details->>'accountCreated' = 'true')
           ) as replaceable
         from auth.accounts account
         where account.status <> 'deleted'
           and exists (select 1 from auth.account_roles assignment
                        where assignment.account_id = account.id and assignment.scope_type = 'platform'
                          and assignment.revoked_at is null
                          and assignment.role_code in ('platform_super_admin', 'platform_admin'))
         order by account.id
         for update of account`,
      );
      // Locked rows the count did not see are not proven either.
      const unsafe = candidates.rows.filter((row) => row.replaceable !== true).length
        + Math.max(0, holders - candidates.rows.length);
      if (unsafe > 0) {
        throw new Error('Bootstrap refused: PLATFORM_ADMIN_REPLACE_PENDING=1 replaces only Super Admins the email '
          + 'bootstrap created that nobody has used yet (pending_reset, no password, session, authenticator, staff or '
          + `patient record); ${unsafe} of ${Math.max(holders, candidates.rows.length)} is not`);
      }
      replacedAccountIds = candidates.rows.map((row) => row.id);
      // revoked_by: the bootstrap has no administrator, so, as 0027 recorded
      // revocations without one, the granting principal or else the account.
      await client.query(
        `update auth.account_roles assignment
            set revoked_at = clock_timestamp(), revoked_by = coalesce(assignment.granted_by, assignment.account_id),
                revocation_reason = $2, row_version = assignment.row_version + 1
          where assignment.account_id = any($1::uuid[]) and assignment.revoked_at is null
          returning assignment.account_id::text`,
        [replacedAccountIds, reason],
      );
      const deleted = await client.query(
        `update auth.accounts set status = 'deleted', token_version = token_version + 1,
            row_version = row_version + 1, updated_at = clock_timestamp()
          where id = any($1::uuid[]) and status = 'pending_reset' and password_hash is null`,
        [replacedAccountIds],
      );
      if (deleted.rowCount !== replacedAccountIds.length) {
        throw new Error('Bootstrap refused: a Super Admin to replace changed during the run');
      }
    } else if (holders !== 0) {
      throw new Error(`${EXISTING_SUPER_ADMIN_REFUSAL}. To replace Super Admins this email bootstrap created that `
        + 'nobody has used yet (a mistyped address), run it again with PLATFORM_ADMIN_REPLACE_PENDING=1');
    }

    const inUse = await client.query(
      `select lower(account.email) as email_in_use from auth.accounts account
        where lower(account.email) = any($1::text[]) and account.status <> 'deleted'
       union
       select lower(staff_row.email) from identity.staff staff_row where lower(staff_row.email) = any($1::text[])`,
      [emails],
    );
    const used = new Set(inUse.rows.map((row) => row.email_in_use));
    const positions = emails.flatMap((email, index) => (used.has(email) ? [index + 1] : []));
    if (positions.length === 1) {
      throw new Error(`Bootstrap refused: PLATFORM_ADMIN_EMAILS entry ${positions[0]} already belongs to an account; `
        + 'name existing accounts in PLATFORM_ADMIN_ACCOUNT_IDS');
    }
    if (positions.length > 1) {
      throw new Error(`Bootstrap refused: PLATFORM_ADMIN_EMAILS entries ${positions.join(', ')} already belong to an `
        + 'account; name existing accounts in PLATFORM_ADMIN_ACCOUNT_IDS');
    }

    const accountIds = [];
    for (const email of emails) {
      const created = await client.query(
        `insert into auth.accounts (id, subject, email, display_name, status, source_system)
         select generated.id, 'platform:' || generated.id::text, $1, null, 'pending_reset', 'hid'
         from (select gen_random_uuid() as id) generated
         returning id::text`,
        [email],
      );
      accountIds.push(created.rows[0].id);
    }
    for (const accountId of accountIds) {
      await grantSuperAdmin(client, accountId, reason, {
        sql: `insert into audit.events (
           correlation_id, actor_type, action, outcome, resource_type, resource_id,
           purpose_of_use, reason, provenance, source_system, details
         ) values (
           'platform-admin-bootstrap', 'system', 'admin.platform-role.bootstrap', 'success',
           'authentication-account', $1, 'healthcare-operations', $2, 'system',
           'platform-admin-bootstrap', jsonb_build_object('roleCode', 'platform_super_admin',
             'bootstrapAccounts', to_jsonb($3::text[]), 'method', 'email', 'accountCreated', true,
             'replacedAccounts', to_jsonb($4::text[]))
         )`,
        params: [accountId, reason, accountIds, replacedAccountIds],
      });
    }
    for (const accountId of replacedAccountIds) {
      await client.query(
        `insert into audit.events (
           correlation_id, actor_type, action, outcome, resource_type, resource_id,
           purpose_of_use, reason, provenance, source_system, details
         ) values (
           'platform-admin-bootstrap', 'system', 'admin.platform-role.bootstrap.replaced', 'success',
           'authentication-account', $1, 'healthcare-operations', $2, 'system',
           'platform-admin-bootstrap', jsonb_build_object('roleCode', 'platform_super_admin', 'method', 'email',
             'accountStatus', 'deleted', 'replacedBy', to_jsonb($3::text[]),
             'revokedAssignments', (select count(*)::integer from auth.account_roles assignment
               where assignment.account_id::text = $1 and assignment.revoked_at >= transaction_timestamp()))
         )`,
        [accountId, reason, accountIds],
      );
    }
    await client.query('commit');
    return { accountIds, replacedAccountIds };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}
