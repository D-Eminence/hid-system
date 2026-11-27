\set ON_ERROR_STOP on
-- 0158 (ORD-6, several tests in one lab request): the guard's temporary-table
-- probe. Rollback-only. The probe left 0158 itself (Rahman's nit on the design
-- note, 7167493074; the clinical owner's note 7214746190): in the file it ran
-- inside the lock window and needed TEMP on the database. It runs here, beside
-- the migrations, so the staging rehearsal runs it with every database/tests
-- suite (on its fresh build, on the non-superuser owner's build and on the
-- restored copy), as the note asks; test/database/lab-request-groups runs the
-- same cases (B5) with the data path.
-- 1. 0158's guard trigger on ehr.lab_requests, by its printed form, enabled.
-- 2. The guard on a temporary table with the column, through a trigger made as
--    0158 makes its own (BEFORE UPDATE OF request_group_id, FOR EACH ROW), so
--    no real row is written: the same group passes (null included); another
--    group, null, or a group where there was none is refused 55000
--    LAB_REQUEST_GROUP_FIXED; a SET that does not name the column does not
--    fire it. Each case runs in its own subtransaction and is undone.
-- Synthetic values only (uuid prefix e58).
begin;

do $$
begin
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'ehr.lab_requests'::regclass and not trigger_row.tgisinternal
         and trigger_row.tgname = 'lab_requests_group_fixed' and trigger_row.tgenabled = 'O'
         and pg_get_triggerdef(trigger_row.oid) = 'CREATE TRIGGER lab_requests_group_fixed BEFORE UPDATE OF '
           || 'request_group_id ON ehr.lab_requests FOR EACH ROW EXECUTE FUNCTION ehr.lab_request_group_fixed()') <> 1 then
    raise exception '0158 lab request group probe: the trigger lab_requests_group_fixed is not as 0158 makes it';
  end if;
end
$$;

create temporary table lab_request_group_probe (id integer primary key, request_group_id uuid, note text)
  on commit drop;
create trigger lab_request_group_probe_fixed before update of request_group_id on lab_request_group_probe
  for each row execute function ehr.lab_request_group_fixed();
insert into lab_request_group_probe values
  (1, 'e58f0000-0000-4000-8000-000000000001', 'grouped'), (2, null, 'alone');

do $$
declare
  probe record;
  outcome text;
  changed bigint;
  mismatches text := '';
begin
  for probe in
    select * from (values
      (1, 'the same group passes',
       $q$update lab_request_group_probe set request_group_id = 'e58f0000-0000-4000-8000-000000000001' where id = 1$q$,
       'ok rows=1'),
      (2, 'null kept as null passes',
       $q$update lab_request_group_probe set request_group_id = null where id = 2$q$, 'ok rows=1'),
      (3, 'another group is refused',
       $q$update lab_request_group_probe set request_group_id = 'e58f0000-0000-4000-8000-000000000002' where id = 1$q$,
       '55000 LAB_REQUEST_GROUP_FIXED'),
      (4, 'a group set to null is refused',
       $q$update lab_request_group_probe set request_group_id = null where id = 1$q$, '55000 LAB_REQUEST_GROUP_FIXED'),
      (5, 'a group set where there was none is refused',
       $q$update lab_request_group_probe set request_group_id = 'e58f0000-0000-4000-8000-000000000001' where id = 2$q$,
       '55000 LAB_REQUEST_GROUP_FIXED'),
      (6, 'a SET that does not name the column does not fire it',
       $q$update lab_request_group_probe set note = 'changed'$q$, 'ok rows=2')
    ) cases(seq, name, statement, expected)
    order by seq
  loop
    outcome := null;
    begin
      execute probe.statement;
      get diagnostics changed = row_count;
      outcome := 'ok rows=' || changed;
      -- Undo the change: the subtransaction rolls back, and the outcome is kept.
      raise exception using errcode = 'P0001', message = 'lab request group probe: undo';
    exception when others then
      if outcome is null then
        outcome := sqlstate || ' ' || sqlerrm;
      end if;
    end;
    if outcome is distinct from probe.expected then
      mismatches := mismatches || format(E'\n  %s: expected [%s], got [%s]', probe.name, probe.expected, outcome);
    end if;
  end loop;
  if mismatches <> '' then
    raise exception '0158 lab request group probe failed:%', mismatches;
  end if;
  if (select string_agg(format('%s %s %s', id, coalesce(request_group_id::text, 'null'), note), '|' order by id)
        from lab_request_group_probe)
     is distinct from '1 e58f0000-0000-4000-8000-000000000001 grouped|2 null alone' then
    raise exception '0158 lab request group probe: a case was not undone';
  end if;
  raise notice '0158 lab request group probe: the trigger as made, and 6 cases passed';
end
$$;

rollback;
