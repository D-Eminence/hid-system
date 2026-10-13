import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { bindingMembership, duplicateFacilityMemberships } from './membership-duplicates.mjs';

const staff = '30000000-0000-4000-8000-0000000000a1';
const otherStaff = '30000000-0000-4000-8000-0000000000a2';
const facility = '10000000-0000-4000-8000-0000000000f1';
const otherFacility = '10000000-0000-4000-8000-0000000000f2';

function staged(sourcePk, payload) {
  return { source_pk: sourcePk, payload_sha256: 'a'.repeat(64),
    payload: { id: sourcePk, staff_account_id: staff, facility_id: facility, membership_role: 'doctor',
      app_role: 'doctor', active: true, ...payload } };
}

test('two active memberships of one staff identity at one facility are refused as a group', () => {
  const rows = [staged('m-2', { membership_role: 'org_admin', app_role: 'org_admin' }), staged('m-1')];
  assert.deepEqual(duplicateFacilityMemberships(rows),
    [{ staffId: staff, facilityId: facility, sourcePks: ['m-1', 'm-2'] }]);
});

test('inactive, held and facility-less memberships are history, not bindings', () => {
  const rows = [
    staged('m-1'),
    staged('m-2', { active: false }),
    staged('m-3', { app_role: 'platform_admin' }),
    staged('m-4', { facility_id: null }),
  ];
  assert.deepEqual(duplicateFacilityMemberships(rows), []);
  assert.equal(bindingMembership(rows[0].payload), true);
  assert.equal(bindingMembership(rows[1].payload), false);
  assert.equal(bindingMembership(rows[2].payload), false);
  assert.equal(bindingMembership(rows[3].payload), false);
});

test('one membership per facility, or per staff identity, is accepted', () => {
  const rows = [staged('m-1'), staged('m-2', { facility_id: otherFacility }), staged('m-3', { staff_account_id: otherStaff })];
  assert.deepEqual(duplicateFacilityMemberships(rows), []);
});

test('the promotion checks membership uniqueness before it writes anything', async () => {
  const promotion = await readFile(resolve(import.meta.dirname, 'promote-legacy-identity.mjs'), 'utf8');
  const check = promotion.indexOf('await validateMembershipUniqueness(client);');
  const started = promotion.indexOf('promotionStarted = true;');
  assert.ok(check > 0, 'promote-legacy-identity.mjs must call validateMembershipUniqueness');
  assert.ok(check < started, 'the uniqueness check must run before the first promotion write');
  // The check itself runs against the real schema in verify-membership-duplicates-runtime.mjs.
  assert.match(promotion, /await membershipUniquenessConflict\(client, staged\)/);
});
