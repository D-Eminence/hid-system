\set ON_ERROR_STOP on
-- Rollback-only coverage for the sealed legacy-identity source ledger. A
-- partial staging run must never be resumed with a later repeatable-read
-- transaction or accept rows after its snapshot evidence is sealed.
begin;

insert into migration.runs (
  id, source_system, source_snapshot, mode, status, started_by,
  source_transaction_snapshot
) values (
  'c1000000-0000-4000-8000-000000000001',
  'legacy_identity', 'cutover-staging-integrity-fixture', 'stage', 'running',
  'cutover-staging-integrity-test', 'fixture:cutover-staging-integrity'
);
insert into migration.source_rows (
  run_id, entity_type, source_pk, payload, payload_sha256
) values (
  'c1000000-0000-4000-8000-000000000001',
  'accounts', 'c2000000-0000-4000-8000-000000000001',
  '{"id":"c2000000-0000-4000-8000-000000000001"}'::jsonb, repeat('a', 64)
);
update migration.runs
   set status = 'staged',
       source_counts = jsonb_build_object('accounts', 1),
       source_checksum_sha256 = repeat('b', 64)
 where id = 'c1000000-0000-4000-8000-000000000001';

do $$
begin
  begin
    insert into migration.source_rows (
      run_id, entity_type, source_pk, payload, payload_sha256
    ) values (
      'c1000000-0000-4000-8000-000000000001',
      'accounts', 'c2000000-0000-4000-8000-000000000002',
      '{"id":"c2000000-0000-4000-8000-000000000002"}'::jsonb, repeat('c', 64)
    );
    raise exception 'sealed legacy staging run accepted a new source row';
  exception when sqlstate '55000' then null;
  end;

  begin
    update migration.runs
       set source_counts = '{}'::jsonb
     where id = 'c1000000-0000-4000-8000-000000000001';
    raise exception 'sealed legacy staging run accepted modified source evidence';
  exception when sqlstate '55000' then null;
  end;

  begin
    update migration.runs
       set status = 'running'
     where id = 'c1000000-0000-4000-8000-000000000001';
    raise exception 'sealed legacy staging run resumed with a new transaction';
  exception when sqlstate '55000' then null;
  end;

  if (select status from migration.runs where id = 'c1000000-0000-4000-8000-000000000001') <> 'staged'
     or (select count(*) from migration.source_rows where run_id = 'c1000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'sealed staging run state changed after rejected mutations';
  end if;
end
$$;

rollback;
