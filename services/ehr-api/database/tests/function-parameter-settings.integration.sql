\set ON_ERROR_STOP on
-- Launch (I3, 0083): no application function may carry a SET clause for a
-- parameter that a role may set only as a superuser or with SET ON PARAMETER.
-- PostgreSQL applies a function's SET clauses on every call, as the
-- function's owner for a SECURITY DEFINER function, so such a clause needs
-- that privilege for as long as the function exists. On RDS no role is a
-- superuser. 0015 gave ocr.claim_worker_job(text, integer)
-- `SET plpgsql.variable_conflict = 'use_column'`, a superuser-context
-- parameter; 0083 moves the same option into the function body. Rollback-only.
begin;

-- Load PL/pgSQL so that its parameters are listed in pg_settings.
do $$ begin perform 1; end $$;

do $$
declare
  offending text;
  claim record;
begin
  select string_agg(proc.oid::regprocedure::text || ' sets ' || split_part(config.entry, '=', 1), '; '
           order by proc.oid::regprocedure::text)
    into offending
    from pg_proc proc
    join pg_namespace namespace_row on namespace_row.oid = proc.pronamespace
    cross join lateral unnest(proc.proconfig) config(entry)
    left join pg_settings parameter on parameter.name = split_part(config.entry, '=', 1)
   where namespace_row.nspname not in ('pg_catalog', 'information_schema')
     and namespace_row.nspname not like 'pg\_%'
     and (parameter.name is null or parameter.context <> 'user');
  if offending is not null then
    raise exception 'application functions need a parameter privilege on every call: %', offending;
  end if;

  -- The claim keeps its signature, security, search path and body, with the
  -- column-resolution option as the first line of the body.
  select proc.proconfig, proc.prosecdef, proc.prosrc, pg_get_function_result(proc.oid) as result
    into claim
    from pg_proc proc where proc.oid = 'ocr.claim_worker_job(text,integer)'::regprocedure;
  if claim.proconfig is distinct from array['search_path=ocr, ehr, audit, auth, platform, pg_temp']
     or not claim.prosecdef
     or claim.prosrc !~ '^\s*#variable_conflict use_column\s*\ndeclare\s'
     or claim.result <> 'TABLE(job_id uuid, facility_id uuid, document_id uuid, patient_id uuid, '
       || 'storage_bucket text, storage_key text, object_version_id text, source_sha256_hex text, '
       || 'size_bytes bigint, media_type text, provider text, attempt_no integer, max_attempts integer, '
       || 'claim_token uuid, claim_expires_at timestamp with time zone, correlation_id text)' then
    raise exception 'ocr.claim_worker_job is not the 0014 command with the in-body column resolution option';
  end if;
  if has_function_privilege('public', 'ocr.claim_worker_job(text,integer)', 'EXECUTE') then
    raise exception 'PUBLIC can execute ocr.claim_worker_job';
  end if;
end
$$;

rollback;
