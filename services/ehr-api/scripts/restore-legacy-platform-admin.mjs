// Exact, source-supported first administrator restoration. No clinical grants.
import { createHash } from 'node:crypto';

export const canonicalJson = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Error(code); };

export async function restoreLegacyPlatformAdmin(client, options) {
  const { mode, runId, sourceChecksum, profileId, profileChecksum, emailChecksum, reason } = options;
  if (!['DryRun','Apply','Verify'].includes(mode) || !reason || reason.length < 8 || reason.length > 500
    || ![sourceChecksum,profileChecksum,emailChecksum].every(s=>/^[a-f0-9]{64}$/.test(s??''))) fail('RESTORATION_EVIDENCE_REQUIRED');
  await client.query('begin isolation level serializable');
  try {
    await client.query("set local lock_timeout='5s';set local statement_timeout='30s'");
    await client.query("select pg_advisory_xact_lock(hashtextextended('hid-platform-admin-bootstrap',0)),pg_advisory_xact_lock(hashtextextended('hid.platform.last-super-admin',0))");
    const migration = await client.query("select 1 from migration.schema_migrations where version='0064_standalone_platform_administration.sql'");
    if (migration.rowCount !== 1) fail('PLATFORM_ADMIN_MIGRATION_REQUIRED');
    const source = (await client.query(`select s.payload,s.payload_sha256,r.source_checksum_sha256,r.status
      from migration.source_rows s join migration.runs r on r.id=s.run_id
      where s.run_id=$1 and s.entity_type='user_profiles' and s.source_pk=$2 for share of s,r`,[runId,profileId])).rows;
    if (source.length !== 1 || !['verified','completed'].includes(source[0].status)
      || source[0].source_checksum_sha256.trim() !== sourceChecksum) fail('VERIFIED_EXACT_SOURCE_REQUIRED');
    const row=source[0], p=row.payload;
    if (p.id !== profileId || p.app_role !== 'platform_admin' || p.active !== true || p.deleted_at !== null
      || sha(canonicalJson(p)) !== profileChecksum || row.payload_sha256.trim() !== profileChecksum) fail('ACTIVE_APPROVED_SOURCE_PROFILE_REQUIRED');
    const targets=(await client.query(`select id,subject,status,disabled_until,row_version,
      encode(sha256(convert_to(lower(btrim(email)),'UTF8')),'hex') email_checksum
      from auth.accounts where id=$1 for update`,[p.auth_user_id])).rows;
    const target=targets[0];
    if (targets.length!==1 || target.status!=='active' || target.disabled_until && new Date(target.disabled_until)>new Date()
      || target.email_checksum!==emailChecksum) fail('EXACT_ACTIVE_DESIGNATED_ACCOUNT_REQUIRED');
    const unrelated=(await client.query(`select
      exists(select 1 from identity.patients where account_id=$1) patient,
      exists(select 1 from identity.staff where account_id=$1) staff,
      exists(select 1 from identity.staff_facility_memberships where account_id=$1) membership,
      exists(select 1 from auth.account_roles where account_id=$1 and scope_type='facility') clinical_assignment`,[target.id])).rows[0];
    if (Object.values(unrelated).some(Boolean)) fail('EXACT_STANDALONE_ACCOUNT_REQUIRED');
    if (!(await client.query(`select 1 from auth.roles role
      join auth.role_permissions rp on rp.role_code=role.code
      join auth.permissions p on p.code=rp.permission_code and p.active
      where role.code='platform_super_admin' and role.active and p.code='platform.admin.access'`)).rowCount) fail('ACTIVE_CANONICAL_ADMIN_ROLE_REQUIRED');
    const assignments=(await client.query("select role_code,grant_reason,revoked_at from auth.account_roles where account_id=$1 and scope_type='platform'",[target.id])).rows;
    const existingAudit=(await client.query(`select details,reason from audit.events where action='admin.platform-role.legacy-restore'
      and resource_type='authentication-account' and resource_id=$1 and source_system='legacy-platform-admin-restoration'`,[target.id])).rows;
    const details={roleCode:'platform_super_admin',sourceRole:'platform_admin',sourceRunId:runId,
      sourceProfileId:profileId,sourceProfileSha256:profileChecksum,sourceChecksumSha256:sourceChecksum,
      targetEmailSha256:emailChecksum,clinicalPermissionsGranted:false};
    let created=false;
    if(assignments.length || existingAudit.length) {
      if(assignments.length!==1 || assignments[0].role_code!=='platform_super_admin' || assignments[0].revoked_at
        || assignments[0].grant_reason!==reason || existingAudit.length!==1 || existingAudit[0].reason!==reason
        || canonicalJson(existingAudit[0].details)!==canonicalJson(details)) fail('EXISTING_RESTORATION_DIFFERS');
    } else {
      if(mode==='Verify') fail('RESTORATION_NOT_APPLIED');
      const others=(await client.query(`select count(distinct a.id)::int count from auth.accounts a
        join auth.account_roles ar on ar.account_id=a.id and ar.scope_type='platform' and ar.revoked_at is null
        join auth.roles r on r.code=ar.role_code and r.active
        where a.status='active' and (a.disabled_until is null or a.disabled_until<=clock_timestamp())
          and ar.role_code in ('platform_super_admin','platform_admin')`)).rows[0].count;
      if(others!==0) fail('FIRST_ADMIN_RESTORATION_ONLY');
      await client.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,granted_by,grant_reason)
        values(gen_random_uuid(),$1,'platform_super_admin','platform',null,$2)`,[target.id,reason]);
      await client.query('update auth.accounts set row_version=row_version+1,updated_at=clock_timestamp() where id=$1',[target.id]);
      await client.query(`insert into audit.events(correlation_id,actor_type,action,outcome,resource_type,resource_id,
        purpose_of_use,reason,provenance,source_system,details)
        values('legacy-platform-admin-restoration','system','admin.platform-role.legacy-restore','success',
          'authentication-account',$1,'healthcare-operations',$2,'system','legacy-platform-admin-restoration',$3::jsonb)`,
        [target.id,reason,JSON.stringify(details)]);
      created=true;
    }
    const permitted=(await client.query("select auth.account_has_platform_permission($1,'platform.admin.access') allowed",[target.id])).rows[0].allowed;
    if(!permitted) fail('RESTORED_AUTHORITY_CHECK_FAILED');
    await client.query(mode==='DryRun'?'rollback':'commit');
    return {passed:true,mode,account_reference:sha(target.id).slice(0,12),profile_sha256:profileChecksum,
      source_run_id:runId,platform_admin_access:true,clinical_permissions_granted:false,
      facility_memberships_created:0,audit_verified:true,role_created:created&&mode==='Apply',
      changes_rolled_back:mode==='DryRun',idempotent_replay:!created};
  } catch(error) { await client.query('rollback').catch(()=>{});throw error; }
}
