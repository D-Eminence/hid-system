#!/usr/bin/env node
// N5 (0087): the legacy promotion's membership uniqueness check, run against
// the real schema of the owned disposable synthetic rehearsal, in a copy that
// is dropped afterwards. promote-legacy-identity.mjs runs this check before it
// writes anything: a staged membership that would bind one staff identity
// twice at one facility is refused, whether the other binding is another
// staged row or an active, unheld membership the target already holds. An
// exact re-promotion of a membership the target holds is not a duplicate, and
// neither is a target membership that is inactive, held or at another
// facility. All values are synthetic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { membershipUniquenessConflict } from './membership-duplicates.mjs';

const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
const isolated = `hid_rehearsal_membership_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const maintenance = new pg.Client({ host: socket, user: process.env.PGUSER, database: 'postgres' });
await maintenance.connect();
await maintenance.query(`create database ${isolated} template ${process.env.PGDATABASE}`);
const client = new pg.Client({ host: socket, user: process.env.PGUSER, database: isolated });
try {
  await client.connect();
  const organization = randomUUID();
  const facility = randomUUID();
  const otherFacility = randomUUID();
  await client.query("insert into identity.organizations (id, name, slug) values ($1, 'Membership Check Organization', $2)",
    [organization, `membership-check-${organization.slice(0, 8)}`]);
  await client.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
    values ($1, $3, 'Membership Check F', $4, 'Africa/Lagos', true, 'verified'),
           ($2, $3, 'Membership Check G', $5, 'Africa/Lagos', true, 'verified')`,
  [facility, otherFacility, organization, `MEMBER-F-${facility.slice(0, 6)}`, `MEMBER-G-${otherFacility.slice(0, 6)}`]);

  // Target staff identities, each with one membership the target already holds.
  async function staffWith(label, membership) {
    const account = randomUUID(); const staff = randomUUID(); const id = randomUUID();
    await client.query(`insert into auth.accounts (id, subject, email, status) values ($1, $2, $3, 'active')`,
      [account, `synthetic:membership-check:${label}`, `membership-check-${label}-${account.slice(0, 8)}@example.invalid`]);
    await client.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
      values ($1, $2, $3, $4, 'verified', 'doctor')`,
    [staff, account, `Membership Check ${label}`, `membership-check-staff-${label}-${staff.slice(0, 8)}@example.invalid`]);
    await client.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id,
        facility_id, membership_role, app_role, is_primary, active, migration_hold_reason, source_system)
      values ($1, $2, $3, $4, $5, 'doctor', 'doctor', true, $6, $7, 'legacy_identity')`,
    [id, staff, account, organization, membership.facility ?? facility, membership.active ?? true, membership.hold ?? null]);
    return { account, staff, membership: id };
  }
  const active = await staffWith('active', {});
  const inactive = await staffWith('inactive', { active: false });
  const held = await staffWith('held', { hold: 'synthetic legacy hold' });
  const elsewhere = await staffWith('elsewhere', { facility: otherFacility });

  // A staged legacy membership row as staging records it.
  const staged = (staff, payload = {}) => {
    const id = payload.id ?? randomUUID();
    return { source_pk: id, payload_sha256: 'b'.repeat(64), payload: { id, staff_account_id: staff,
      organization_id: organization, facility_id: facility, membership_role: 'doctor', app_role: 'doctor',
      is_primary: false, active: true, ...payload } };
  };
  const conflictOf = rows => membershipUniquenessConflict(client, rows);

  // Beside an active, unheld target membership: refused before any write.
  const beside = staged(active.staff);
  const refused = await conflictOf([staged(inactive.staff), beside]);
  assert.deepEqual(refused && { sourcePk: refused.row.source_pk, conflictType: refused.conflictType, details: refused.details },
    { sourcePk: beside.source_pk, conflictType: 'target_content_mismatch',
      details: { field: 'membership', reason: 'duplicate_active_facility_membership', operatorPlan: 'I4',
        targetMembershipId: active.membership } });
  // Promoted anyway, that row would break the N5 index.
  await client.query('begin');
  await assert.rejects(client.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id,
      organization_id, facility_id, membership_role, app_role, is_primary, active)
    values ($1, $2, $3, $4, $5, 'doctor', 'doctor', false, true)`,
  [beside.source_pk, active.staff, active.account, organization, facility]),
  error => error.code === '23505' && error.constraint === 'staff_memberships_one_active_per_facility_uq');
  await client.query('rollback');

  // Not duplicates: an exact re-promotion of the membership the target holds,
  // and new bindings beside an inactive, a held or another facility's membership.
  const notDuplicates = {
    exact_repromotion: [staged(active.staff, { id: active.membership })],
    beside_inactive: [staged(inactive.staff)],
    beside_held: [staged(held.staff)],
    beside_other_facility: [staged(elsewhere.staff)],
    staged_inactive: [staged(active.staff, { active: false })],
    staged_platform_admin_hold: [staged(active.staff, { app_role: 'platform_admin' })],
    staged_without_facility: [staged(active.staff, { facility_id: null })],
  };
  for (const [name, rows] of Object.entries(notDuplicates)) {
    assert.equal(await conflictOf(rows), null, `${name} must not be refused`);
  }

  // Two staged bindings of one staff identity at one facility: refused as a
  // source conflict, whatever the target holds.
  const first = staged(inactive.staff, { id: '00000000-0000-4000-8000-00000000000a' });
  const second = staged(inactive.staff, { id: '00000000-0000-4000-8000-00000000000b' });
  const doubled = await conflictOf([second, first]);
  assert.deepEqual(doubled && { sourcePk: doubled.row.source_pk, conflictType: doubled.conflictType, details: doubled.details },
    { sourcePk: second.source_pk, conflictType: 'invalid_source_value',
      details: { field: 'membership', reason: 'duplicate_active_facility_membership',
        sourcePks: [first.source_pk, second.source_pk], operatorPlan: 'I4' } });

  process.stdout.write(`${JSON.stringify({ status: 'passed', database: 'disposable copy of hid_rehearsal',
    refused: { beside_active_target_membership: 'target_content_mismatch', staged_twice: 'invalid_source_value',
      would_violate: 'staff_memberships_one_active_per_facility_uq' },
    accepted: Object.keys(notDuplicates) })}\n`);
} finally {
  await client.end().catch(() => undefined);
  await maintenance.query(`drop database if exists ${isolated} with (force)`);
  await maintenance.end();
}
