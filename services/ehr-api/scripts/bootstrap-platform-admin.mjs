#!/usr/bin/env node

import pg from 'pg';
import { databaseOptions } from './database-options.mjs';
import { loadLocalEnvironment } from '../../../scripts/local-environment.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Client } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, '../../..');
if (process.env.NODE_ENV !== 'production') {
  loadLocalEnvironment([
    path.join(repositoryDirectory, '.env.local'),
    path.join(scriptDirectory, '../.env.local'),
  ]);
}

const databaseAdminUrl = process.env.DATABASE_ADMIN_URL;
const accountId = process.env.PLATFORM_ADMIN_ACCOUNT_ID?.trim();
const reason = process.env.PLATFORM_ADMIN_BOOTSTRAP_REASON?.trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  if (!databaseAdminUrl) throw new Error('DATABASE_ADMIN_URL is required');
  if (!accountId || !UUID.test(accountId)) {
    throw new Error('PLATFORM_ADMIN_ACCOUNT_ID must be one exact version-4 account UUID');
  }
  if (!reason || reason.length < 8 || reason.length > 500) {
    throw new Error('PLATFORM_ADMIN_BOOTSTRAP_REASON must contain 8 to 500 characters');
  }

  const client = new Client(databaseOptions(databaseAdminUrl, 'hid-platform-admin-bootstrap'));
  await client.connect();
  try {
    await client.query('begin');
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
       where account.id = $1 and account.status = 'active'
         and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
         and exists (
           select 1 from identity.staff staff
           join identity.staff_facility_memberships membership on membership.staff_id = staff.id
             and membership.account_id = account.id and membership.active
             and membership.migration_hold_reason is null
           join identity.organizations organization on organization.id = membership.organization_id
             and organization.active
           join identity.facilities facility on facility.id = membership.facility_id
             and facility.organization_id = membership.organization_id and facility.active
           where staff.account_id = account.id and staff.active
             and lower(btrim(staff.verification_status)) in ('verified', 'approved', 'active')
         )
       for update`,
      [accountId],
    );
    if (eligible.rowCount !== 1) {
      throw new Error('Bootstrap refused: the account lacks an active verified staff and facility membership tuple');
    }

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
         'platform-admin-bootstrap', jsonb_build_object('roleCode', 'platform_super_admin')
       )`,
      [accountId, reason],
    );
    await client.query('commit');
    process.stdout.write(`Platform Super Admin bootstrap completed for account ${accountId}\n`);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Platform Super Admin bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
