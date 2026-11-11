-- 0109 Support chat Health ID check: which of the given Health IDs are
-- issued. Written on staging-novu-ci-20261005 at 013c3eff (migrations
-- 0001-0108 applied); it is the next migration after 0108 and adds one
-- function, identity.support_health_id_matches, nothing else. Its number is
-- the next free one when it merges (the open migration PRs hold 0110, 0111
-- and 0113-0121), so it may be renumbered then.
--
-- Owner decision of 2026-10-31 (option (a) for the website's support-chat
-- guard, with a server check): support-api checks every support chat message
-- against the Health IDs actually issued, through identity-api, and replaces
-- each one with a fixed placeholder before any text reaches Lex. identity-api
-- owns the Health IDs; this function is how it reads them for that check.
-- The declaration in config/production-schema-compatibility.json is signed
-- separately: its reviewed_by stays empty until the owner signs it there.
--
-- WHAT IT DOES
-- identity.support_health_id_matches(candidates text[]) returns the
-- candidates that are an issued Health ID (identity.patients.hid_code, every
-- status: a Health ID stays personal once issued), each once, in order, and
-- nothing else: no patient id, name, status or any other column. A candidate
-- is HID- and 6 to 32 Health ID characters, upper case, exactly as
-- identity.patients' CHECK (0002) requires a hid_code to be; identity-api
-- sends them so. One to 200 candidates. Any other input (none, more than 200,
-- a null, a lower-case or malformed candidate, a nested array) raises 22023,
-- so a bad request never answers "no match": support-api then answers 503 and
-- sends nothing to Lex.
--
-- It is SECURITY DEFINER, owned by identity.patients' owner, so it reads past
-- identity.patients' row-level security (0005's policies let a reader see
-- only their own patient row or one their consent covers; the support check
-- has neither). The table is not FORCE ROW LEVEL SECURITY (section 0 checks:
-- if it were, the owner would see no row and every check would answer "no
-- match"). The match is upper(hid_code) = any(candidates), which uses 0002's
-- unique index patients_hid_code_ci_uq on upper(hid_code). STABLE, search_path
-- pg_catalog, pg_temp. Only hid_identity_runtime may execute it (no PUBLIC):
-- identity-api's support route, which accepts the support-api workload alone.
--
-- No table, column, constraint, index, policy, trigger, role or other
-- function changes; no row is read or written by this file. BACKWARD
-- COMPATIBLE: nothing calls the function until identity-api's support route
-- is released, and today's identity-api never names it.
--
-- PRECONDITIONS (catalog reads only; 55000 or 42501, nothing applied):
-- 0001-0108 applied (0108's records-processing cover body md5
-- 6928763d3b69f0e4b4acf96a6a255736 is the marker); not applied yet (else
-- "0109: already applied"); identity.patients with hid_code text NOT NULL,
-- its unique index on upper(hid_code), and no forced row-level security; the
-- applier is that table's owner or may SET ROLE to it, and the owner has
-- CREATE on schema identity.

do $$
declare
  table_owner oid;
begin
  -- a. Prerequisites (0001-0108; 0108's cover body is the marker).
  if to_regclass('identity.patients') is null
     or to_regprocedure('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)'))
        is distinct from '6928763d3b69f0e4b4acf96a6a255736' then
    raise exception using errcode = '55000', message = '0109: 0001-0108 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regprocedure('identity.support_health_id_matches(text[])') is not null then
    raise exception using errcode = '55000', message = '0109: already applied';
  end if;
  -- c. The column, its index and the table's row-level security, as 0002 and
  -- 0005 left them.
  if not exists (select 1 from pg_attribute attribute
                  where attribute.attrelid = 'identity.patients'::regclass and attribute.attname = 'hid_code'
                    and attribute.atttypid = 'text'::regtype and attribute.attnotnull and not attribute.attisdropped) then
    raise exception using errcode = '55000', message = '0109: identity.patients.hid_code is not text NOT NULL';
  end if;
  if not exists (select 1 from pg_index index_row
                  where index_row.indrelid = 'identity.patients'::regclass
                    and index_row.indexrelid = to_regclass('identity.patients_hid_code_ci_uq')
                    and index_row.indisunique and index_row.indisvalid
                    and pg_get_indexdef(index_row.indexrelid) like '%(upper(hid_code))') then
    raise exception using errcode = '55000', message = '0109: the unique index on upper(identity.patients.hid_code) is missing';
  end if;
  if (select relation.relforcerowsecurity from pg_class relation where relation.oid = 'identity.patients'::regclass) then
    raise exception using errcode = '55000',
      message = '0109: identity.patients forces row-level security, so its owner would see no Health ID';
  end if;
  -- d. Who will own the function.
  table_owner := (select relation.relowner from pg_class relation where relation.oid = 'identity.patients'::regclass);
  if not pg_has_role(current_user, table_owner, 'SET')
     or not has_schema_privilege(table_owner, 'identity', 'CREATE') then
    raise exception using errcode = '42501', message = format(
      '0109: the applier (%s) must be able to SET ROLE to identity.patients'' owner (%s), which needs CREATE on schema identity',
      current_user, pg_get_userbyid(table_owner));
  end if;
end
$$;

-- 1. The check.
create function identity.support_health_id_matches(candidates text[])
returns table (health_id text)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if candidates is null
     or pg_catalog.cardinality(candidates) < 1
     or pg_catalog.cardinality(candidates) > 200
     or pg_catalog.array_ndims(candidates) <> 1
     or exists (select 1 from pg_catalog.unnest(candidates) candidate
                 where candidate is null or candidate !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$') then
    raise exception using errcode = '22023',
      message = 'Support Health ID check: 1 to 200 candidates, each HID- and 6 to 32 Health ID characters';
  end if;
  return query
    select distinct pg_catalog.upper(patient.hid_code)
      from identity.patients patient
     where pg_catalog.upper(patient.hid_code) = any (candidates)
     order by 1;
end
$$;

comment on function identity.support_health_id_matches(text[]) is
  '0109 (owner decision of 2026-10-31, the support chat''s server check): the given candidates that are an issued Health ID (identity.patients.hid_code, any status), each once, and nothing else about any patient. 1 to 200 candidates, each HID- and 6 to 32 Health ID characters, upper case; anything else raises 22023. Executed by identity-api''s support route alone (hid_identity_runtime), for support-api, which replaces each match before the text reaches Lex.';

-- The table's owner owns the function (a no-op when the applier is that
-- owner, as on every database built by one migration login).
do $$
declare
  table_owner oid := (select relation.relowner from pg_class relation
                       where relation.oid = 'identity.patients'::regclass);
begin
  if (select proc.proowner from pg_proc proc
       where proc.oid = 'identity.support_health_id_matches(text[])'::regprocedure) <> table_owner then
    execute format('alter function identity.support_health_id_matches(text[]) owner to %I', pg_get_userbyid(table_owner));
  end if;
end
$$;

-- 2. Grants (here and in runtime-grants.sql).
revoke all on function identity.support_health_id_matches(text[]) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.support_health_id_matches(text[]) to hid_identity_runtime;
  end if;
end
$$;

-- 3. Post-checks (after the grants, so the ACL is the final one).
do $$
declare
  mismatch text;
begin
  if not exists (
       select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
        where proc.oid = 'identity.support_health_id_matches(text[])'::regprocedure
          and proc.proowner = (select relation.relowner from pg_class relation
                                where relation.oid = 'identity.patients'::regclass)
          and language_row.lanname = 'plpgsql' and proc.prosecdef and not proc.proisstrict
          and proc.provolatile = 's' and proc.proretset and proc.prokind = 'f'
          and proc.proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[]
          and pg_get_function_result(proc.oid) = 'TABLE(health_id text)') then
    mismatch := 'the function''s owner, attributes or result';
  end if;
  if mismatch is null then
    select string_agg(granted.what, '; ') into mismatch
      from (
        select case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
               || ' ' || acl.privilege_type || ' on the function' as what
          from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
         where proc.oid = 'identity.support_health_id_matches(text[])'::regprocedure
           and acl.grantee <> proc.proowner
           and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime' or acl.privilege_type <> 'EXECUTE')
        union all
        select 'missing hid_identity_runtime EXECUTE on the function'
          from pg_roles role_row
         where role_row.rolname = 'hid_identity_runtime'
           and not exists (select 1 from pg_proc proc, aclexplode(proc.proacl) acl
                            where proc.oid = 'identity.support_health_id_matches(text[])'::regprocedure
                              and acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE')) granted;
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0109: not as this file makes it: %s', mismatch);
  end if;
end
$$;
