-- 0039 declared platform.admin_set_control with RETURNS TABLE(control_key,
-- enabled, row_version, replayed). Those output columns are PL/pgSQL variables,
-- so the body's unqualified control_key and row_version references were
-- ambiguous and every call failed with 42702 before reading or changing a
-- control. This keeps the same signature, result, permission checks,
-- validation and event row, and qualifies the table references.
-- CREATE OR REPLACE keeps the owner and privileges set by 0039 and
-- runtime-grants.sql.
create or replace function platform.admin_set_control(
 requested_key text, requested_enabled boolean, expected_version bigint, requested_reason text)
returns table(control_key text,enabled boolean,row_version bigint,replayed boolean)
language plpgsql security definer
set search_path=platform,auth,pg_temp
as $$
declare actor uuid:=platform.current_account_id(); current_row platform.control_settings%rowtype;
begin
 if not auth.account_has_platform_permission(actor,'platform.control.manage') then
   raise exception using errcode='42501',message='ADMIN_PERMISSION_DENIED';
 end if;
 if requested_key not in ('patient_portal_enabled','provider_portal_enabled','outreach_portal_enabled','maintenance_mode','uploads_enabled','break_glass_enabled')
    or requested_reason is null or length(btrim(requested_reason))<8 then
   raise exception using errcode='22023',message='ADMIN_INVALID_CONTROL';
 end if;
 select * into current_row from platform.control_settings setting
 where setting.control_key=requested_key for update;
 if current_row.row_version<>expected_version then
   raise exception using errcode='40001',message='ADMIN_VERSION_CONFLICT';
 end if;
 if current_row.enabled=requested_enabled then
   return query select current_row.control_key,current_row.enabled,current_row.row_version,true; return;
 end if;
 update platform.control_settings setting set enabled=requested_enabled,reason=btrim(requested_reason),
   row_version=setting.row_version+1,updated_by=actor,updated_at=clock_timestamp()
 where setting.control_key=requested_key returning setting.* into current_row;
 insert into platform.control_events(control_key,previous_enabled,enabled,reason,actor_account_id,correlation_id)
 values(current_row.control_key,not current_row.enabled,current_row.enabled,current_row.reason,actor,platform.current_correlation_id());
 return query select current_row.control_key,current_row.enabled,current_row.row_version,false;
end $$;
