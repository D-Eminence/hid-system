\set ON_ERROR_STOP on
-- 0093 upgrade (ADR-062), rollback-only. Runs on a database migrated through
-- 0092 and no further (apply-migrations.mjs --through=0092_...); the
-- rehearsal builds one. It seeds enrollments as 0092 left them, at
-- verify_contact (with an open contact code), at set_password (with a
-- consumed contact code) and active, applies 0093 in the same transaction
-- and checks the backfill: every enrollment that is not active is back at
-- verify_holder with its contact cleared and its open codes invalidated
-- ('expired'), and an active one is marked 'none_before_0093' and otherwise
-- unchanged. Fixture bytes and digests only; nothing is kept.
begin;

do $$
begin
  if not exists (select 1 from migration.schema_migrations
      where version = '0092_patient_self_reported_enrollment_profile.sql')
     or exists (select 1 from migration.schema_migrations where version > '0092_patient_self_reported_enrollment_profile.sql') then
    raise exception 'This upgrade suite needs a database migrated through 0092 and no further';
  end if;
end $$;

insert into auth.accounts (id, subject, display_name, status, source_system)
values ('b9440000-0000-4000-8000-000000000003', 'patient:b9440000-0000-4000-8000-000000000003',
  'Upgrade Sample', 'active', 'hid-public-qoreid-enrollment');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, source_system)
values ('b9430000-0000-4000-8000-000000000003', 'b9440000-0000-4000-8000-000000000003', 'HID-UPGRADEA',
  'Upgrade', 'Sample', 'Upgrade Sample', 'active', 'hid-public-qoreid-enrollment');
insert into identity.public_patient_enrollments (
  id, nin_lookup_hmac, nin_last4, nin_ciphertext, profile_ciphertext, profile_sha256, key_version,
  provider_reference, request_hmac, token_hmac, state, contact_channel, contact_hmac, contact_lookup_hmac,
  contact_ciphertext, contact_verified_at, verified_challenge_id, patient_id, account_id, activated_at
) values
  ('b9400000-0000-4000-8000-000000000001', repeat('41',32), '9401', decode(repeat('a1',32),'hex'),
   decode(repeat('b1',32),'hex'), repeat('51',32), 'fixture', 'upgrade-contact-001', repeat('61',32), repeat('71',32),
   'verify_contact', 'email', repeat('81',32), repeat('91',32), decode(repeat('c1',32),'hex'), null, null,
   null, null, null),
  ('b9400000-0000-4000-8000-000000000002', repeat('42',32), '9402', decode(repeat('a2',32),'hex'),
   decode(repeat('b2',32),'hex'), repeat('52',32), 'fixture', 'upgrade-password-002', repeat('62',32), repeat('72',32),
   'set_password', 'phone', repeat('82',32), repeat('92',32), decode(repeat('c2',32),'hex'),
   clock_timestamp() - interval '5 minutes', 'b9410000-0000-4000-8000-000000000002', null, null, null),
  ('b9400000-0000-4000-8000-000000000003', repeat('43',32), '9403', decode(repeat('a3',32),'hex'),
   decode(repeat('b3',32),'hex'), repeat('53',32), 'fixture', 'upgrade-active-003', repeat('63',32), repeat('73',32),
   'active', 'email', repeat('83',32), repeat('93',32), decode(repeat('c3',32),'hex'),
   clock_timestamp() - interval '2 days', 'b9410000-0000-4000-8000-000000000003',
   'b9430000-0000-4000-8000-000000000003', 'b9440000-0000-4000-8000-000000000003',
   clock_timestamp() - interval '2 days');
insert into identity.public_patient_enrollment_otps (id, enrollment_id, recipient_hmac, channel, verifier_hmac,
  verifier_key_version, expires_at, max_attempts, delivery_outcome, verified_at, consumed_at)
values
  ('b9410000-0000-4000-8000-000000000001', 'b9400000-0000-4000-8000-000000000001', repeat('81',32), 'email',
   repeat('ab',32), 'fixture', clock_timestamp() + interval '5 minutes', 5, 'accepted', null, null),
  ('b9410000-0000-4000-8000-000000000002', 'b9400000-0000-4000-8000-000000000002', repeat('82',32), 'phone',
   repeat('ab',32), 'fixture', clock_timestamp() + interval '1 minute', 5, 'accepted',
   clock_timestamp() - interval '5 minutes', clock_timestamp() - interval '5 minutes'),
  ('b9410000-0000-4000-8000-000000000003', 'b9400000-0000-4000-8000-000000000003', repeat('83',32), 'email',
   repeat('ab',32), 'fixture', clock_timestamp() - interval '2 days' + interval '5 minutes', 5, 'accepted',
   clock_timestamp() - interval '2 days', clock_timestamp() - interval '2 days');

create temporary table upgrade_before on commit drop as
  select id, state, contact_channel, contact_hmac, contact_lookup_hmac, contact_ciphertext, contact_verified_at,
         verified_challenge_id, patient_id, account_id, activated_at, row_version
    from identity.public_patient_enrollments;

-- Settle the seeded rows' deferred foreign keys, as their commit would,
-- before the migration alters the table.
set constraints all immediate;

\ir ../../migrations/0093_nin_holder_ownership_proof.sql

do $$
declare
  row_after record;
begin
  -- Not active: back at the holder step with the contact cleared.
  for row_after in select * from identity.public_patient_enrollments
      where id in ('b9400000-0000-4000-8000-000000000001', 'b9400000-0000-4000-8000-000000000002') loop
    if row_after.state <> 'verify_holder' or row_after.contact_channel is not null
       or row_after.contact_hmac is not null or row_after.contact_lookup_hmac is not null
       or row_after.contact_ciphertext is not null or row_after.contact_verified_at is not null
       or row_after.verified_challenge_id is not null or row_after.holder_method is not null
       or row_after.holder_verified_at is not null or row_after.patient_id is not null
       or row_after.row_version <> (select before.row_version + 1 from upgrade_before before where before.id = row_after.id) then
      raise exception 'Enrollment % was not reset to verify_holder with its contact cleared', row_after.id;
    end if;
  end loop;
  -- Its open contact code is invalidated as expired; a consumed one is kept as it was.
  if (select (invalidated_at is not null and invalidation_reason = 'expired' and consumed_at is null and purpose = 'contact')
      from identity.public_patient_enrollment_otps where id = 'b9410000-0000-4000-8000-000000000001') is not true then
    raise exception 'An open contact code of a reset enrollment was not invalidated as expired';
  end if;
  if (select (invalidated_at is null and consumed_at is not null and purpose = 'contact')
      from identity.public_patient_enrollment_otps where id = 'b9410000-0000-4000-8000-000000000002') is not true then
    raise exception 'A consumed contact code was changed by the backfill';
  end if;
  -- Active: marked as created before holder proofs, otherwise unchanged.
  select * into row_after from identity.public_patient_enrollments where id = 'b9400000-0000-4000-8000-000000000003';
  if row_after.state <> 'active' or row_after.holder_method <> 'none_before_0093'
     or row_after.holder_verified_at is not null or row_after.holder_challenge_id is not null
     or not exists (select 1 from upgrade_before before where before.id = row_after.id
       and (before.contact_channel, before.contact_hmac, before.contact_lookup_hmac, before.contact_ciphertext,
         before.contact_verified_at, before.verified_challenge_id, before.patient_id, before.account_id,
         before.activated_at, before.row_version)
       is not distinct from (row_after.contact_channel, row_after.contact_hmac, row_after.contact_lookup_hmac,
         row_after.contact_ciphertext, row_after.contact_verified_at, row_after.verified_challenge_id,
         row_after.patient_id, row_after.account_id, row_after.activated_at, row_after.row_version)) then
    raise exception 'An active enrollment was not marked none_before_0093 or was otherwise changed';
  end if;
  if (select (invalidated_at is null and consumed_at is not null and purpose = 'contact')
      from identity.public_patient_enrollment_otps where id = 'b9410000-0000-4000-8000-000000000003') is not true then
    raise exception 'An active enrollment''s contact code was changed';
  end if;
  -- Forced row-level security is back on both tables.
  if exists (select 1 from pg_class where oid in ('identity.public_patient_enrollments'::regclass,
      'identity.public_patient_enrollment_otps'::regclass) and not (relrowsecurity and relforcerowsecurity)) then
    raise exception 'The backfill left forced row-level security off';
  end if;
  -- A reset enrollment cannot skip the holder step.
  begin
    update identity.public_patient_enrollments set state = 'verify_contact'
      where id = 'b9400000-0000-4000-8000-000000000001';
    raise exception 'A reset enrollment reached the contact step without a holder proof';
  exception when check_violation then null; end;
end $$;

rollback;
