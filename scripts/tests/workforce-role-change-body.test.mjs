// Clinician self sign-up (ADR-064) moves the body of 0087's
// identity.admin_change_workforce_role into the internal
// identity.workforce_change_role, which takes a pinned attestation, and makes
// the 0087 command a one-line delegation with no pin. A copying mistake there
// could weaken the two-person rule, so this holds the copy to the accepted
// 0087 text: the 0087 body with exactly three documented insertions is the new
// body, whitespace aside.
//   (i)   a ninth parameter, pinned_attestation_id uuid;
//   (ii)  in the chosen-attestation query, the reservation (bound to the
//         target account and the facility) and the pin;
//   (iii) the same two predicates in the second-person probe.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '../..');
const migrations = join(repository, 'services/ehr-api/database/migrations');
const read = (pattern) => {
  const names = readdirSync(migrations).filter((name) => pattern.test(name));
  assert.equal(names.length, 1, `exactly one migration matches ${pattern}`);
  return readFileSync(join(migrations, names[0]), 'utf8');
};
const governed = read(/^0087_governed_workforce_provisioning\.sql$/);
const signup = read(/^\d{4}_clinician_self_signup\.sql$/);

/** The definition of `create [or replace] function <name>(`: its header (to `as $$`) and its body. */
function definition(source, name) {
  const start = source.search(new RegExp(`create (?:or replace )?function ${name.replace('.', '\\.')}\\(`));
  assert.notEqual(start, -1, `${name} is defined`);
  const bodyStart = source.indexOf('as $$\n', start);
  const bodyEnd = source.indexOf('\n$$;\n', bodyStart);
  assert(bodyStart > start && bodyEnd > bodyStart, `${name} has a dollar-quoted body`);
  return { header: source.slice(start, bodyStart), body: source.slice(bodyStart + 6, bodyEnd) };
}
const normalized = (text) => text.replace(/\s+/g, ' ').trim();

// The reservation is bound to the grant's own account and facility: a pin
// unlocks an attestation only for its own application there.
const reservation = 'and identity.workforce_attestation_usable(attestation.id, pinned_attestation_id, target.id, '
  + 'facility_row.id) and (pinned_attestation_id is null or attestation.id = pinned_attestation_id)';

test('workforce_change_role is the 0087 grant body with exactly the reservation and the pin added', () => {
  const original = definition(governed, 'identity.admin_change_workforce_role');
  const copy = definition(signup, 'identity.workforce_change_role');
  const chosen = 'and not identity.workforce_works_at(attestation.reviewer_account_id, facility_row.id) '
    + 'order by attestation.valid_until desc';
  const probe = 'and not identity.workforce_works_at(attestation.reviewer_account_id, facility_row.id)) then';
  const body = normalized(original.body);
  assert.equal(body.split(chosen).length, 2, 'the 0087 chosen-attestation query appears once');
  assert.equal(body.split(probe).length, 2, 'the 0087 second-person probe appears once');
  const expected = body
    .replace(chosen, chosen.replace(' order by', ` ${reservation} order by`))
    .replace(probe, probe.replace(')) then', `) ${reservation}) then`));
  assert.equal(normalized(copy.body), expected);
  // (i): the 0087 header with the pin as a ninth parameter, under the new name.
  assert.equal(normalized(copy.header), normalized(original.header)
    .replace('create function identity.admin_change_workforce_role(', 'create function identity.workforce_change_role(')
    .replace('requested_sha256 char(64) ) returns table', 'requested_sha256 char(64), pinned_attestation_id uuid ) returns table'));
});

test('admin_change_workforce_role keeps its signature and only delegates with no pin', () => {
  const original = definition(governed, 'identity.admin_change_workforce_role');
  const wrapper = definition(signup, 'identity.admin_change_workforce_role');
  assert.equal(normalized(wrapper.header), normalized(original.header)
    .replace('create function identity.admin_change_workforce_role(', 'create or replace function identity.admin_change_workforce_role(')
    .replace('#variable_conflict use_column', ''));
  assert.equal(normalized(wrapper.body), normalized(`begin
    return query select * from identity.workforce_change_role(requested_membership_id, requested_facility_id,
      expected_membership_version, requested_role_code, requested_action, requested_reason, requested_idempotency_key,
      requested_sha256, null);
  end`));
});

test('both keep SECURITY DEFINER and the 0087 search path, and only the wrapper is granted', () => {
  for (const { header } of [definition(signup, 'identity.workforce_change_role'),
    definition(signup, 'identity.admin_change_workforce_role')]) {
    assert.match(header, /\nsecurity definer\n/);
    assert.match(header, /\nset search_path = pg_catalog, identity, auth, platform, pg_temp\n/);
  }
  const grants = readFileSync(join(repository, 'services/ehr-api/database/runtime-grants.sql'), 'utf8');
  const granted = [...grants.replace(/--[^\n]*/g, '').matchAll(/grant execute on function ([\s\S]*?) to ([^;]+);/g)]
    .flatMap(([, list]) => [...list.matchAll(/identity\.([a-z_]+)\(/g)].map(([, name]) => name));
  assert(granted.includes('admin_change_workforce_role'), 'the 0087 command stays granted');
  assert(!granted.includes('workforce_change_role'), 'the pinned grant is granted to no runtime');
  assert.match(signup, /revoke all on function identity\.workforce_change_role\(uuid, uuid, bigint, text, text, text, text, character, uuid\)\n  from public;/);
});
