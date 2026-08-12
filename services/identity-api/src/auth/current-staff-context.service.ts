import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { ActorContext, FacilityAssignment } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { CredentialIdentity } from './auth.types';
import { ACTIVE_STAFF_VERIFICATION_STATUSES } from './auth-policy';

interface StaffContextRow {
  account_id: string;
  subject: string;
  email: string;
  display_name: string;
  facility_id: string;
  membership_id: string;
  organization_id: string;
  facility_name: string;
  facility_code: string | null;
  roles: string[];
  permissions: string[];
  is_primary: boolean;
}

interface PlatformAuthorityRow {
  roles: string[];
  permissions: string[];
}

@Injectable()
export class CurrentStaffContextService {
  constructor(private readonly database: DatabaseService) {}

  async resolve(
    subject: string,
    authenticationMethod: ActorContext['authenticationMethod'],
    sessionId?: string,
    preferredFacilityId?: string,
  ): Promise<ActorContext> {
    const identity = await this.resolvePostgres(subject, authenticationMethod);
    if (!identity.accountId) {
      const account = await this.database.query<{ id: string }>(
        `select id::text from auth.accounts
          where subject = $1 and status = 'active'
            and (disabled_until is null or disabled_until <= clock_timestamp())`,
        [subject],
      );
      const accountId = account.rows[0]?.id;
      if (!accountId) throw new UnauthorizedException('Migrated authentication account is unavailable');
      identity.accountId = accountId;
    }
    const platformAuthority = await this.resolvePlatformAuthority(identity.accountId);
    return this.toActor(identity, platformAuthority, sessionId, preferredFacilityId);
  }

  private async resolvePostgres(
    subject: string,
    authenticationMethod: 'local' | 'oidc',
  ): Promise<CredentialIdentity> {
    const result = await this.database.query<StaffContextRow>(
      `select account.id::text as account_id,
              account.subject,
              account.email,
              account.display_name,
              membership.facility_id::text,
              membership.id::text as membership_id,
              membership.organization_id::text,
              facility.name as facility_name,
              facility.code as facility_code,
              array_remove(array[membership.membership_role, membership.app_role], null) as roles,
              coalesce(array_agg(distinct permission.code) filter (where permission.code is not null), array[]::text[]) as permissions,
              membership.is_primary
         from auth.accounts account
         join identity.staff_facility_memberships membership
           on membership.account_id = account.id
          and membership.active
          and membership.migration_hold_reason is null
         join identity.staff staff
           on staff.id = membership.staff_id
          and staff.account_id = account.id
          and staff.active
          and lower(btrim(staff.verification_status)) = any($2::text[])
         join identity.organizations organization
           on organization.id = membership.organization_id
          and organization.active
         join identity.facilities facility
           on facility.id = membership.facility_id
          and facility.organization_id = membership.organization_id
          and facility.active
         left join auth.account_roles account_role
           on account_role.account_id = account.id
          and account_role.scope_type = 'facility'
          and account_role.membership_id = membership.id
          and account_role.facility_id = membership.facility_id
          and account_role.revoked_at is null
         left join auth.roles role
           on role.code = account_role.role_code
          and role.active
         left join auth.role_permissions role_permission on role_permission.role_code = role.code
         left join auth.permissions permission
           on permission.code = role_permission.permission_code
          and permission.active
        where account.subject = $1
          and account.status = 'active'
          and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
        group by account.id, account.subject, account.email, account.display_name,
                 membership.id, membership.facility_id, membership.organization_id,
                 membership.membership_role, membership.app_role, membership.is_primary,
                 facility.name, facility.code
        order by membership.is_primary desc, facility.name, membership.facility_id`,
      [subject, [...ACTIVE_STAFF_VERIFICATION_STATUSES]],
    );
    const first = result.rows[0];
    if (!first) throw new UnauthorizedException('Staff account or facility membership is inactive');
    return {
      subject: first.subject,
      accountId: first.account_id,
      email: first.email,
      displayName: first.display_name,
      facilities: result.rows.map((row) => this.facility(row)),
      authenticationMethod,
    };
  }

  private async resolvePlatformAuthority(accountId: string | undefined): Promise<PlatformAuthorityRow> {
    if (!accountId) return { roles: [], permissions: [] };
    const result = await this.database.query<PlatformAuthorityRow>(
      `select
         coalesce(array_agg(distinct role.code) filter (where role.code is not null), array[]::text[]) as roles,
         coalesce(array_agg(distinct permission.code) filter (where permission.code is not null), array[]::text[]) as permissions
       from auth.account_roles assignment
       join auth.roles role
         on role.code = assignment.role_code and role.active
       left join auth.role_permissions role_permission on role_permission.role_code = role.code
       left join auth.permissions permission
         on permission.code = role_permission.permission_code and permission.active
       where assignment.account_id = $1
         and assignment.scope_type = 'platform'
         and assignment.revoked_at is null`,
      [accountId],
    );
    const row = result.rows[0];
    return {
      roles: [...new Set(row?.roles ?? [])].sort(),
      permissions: [...new Set(row?.permissions ?? [])].sort(),
    };
  }

  private toActor(
    identity: CredentialIdentity,
    platformAuthority: PlatformAuthorityRow,
    sessionId?: string,
    preferredFacilityId?: string,
  ): ActorContext {
    const facilities = [...identity.facilities].sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
      return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    });
    const selected = facilities.find((facility) => facility.id === preferredFacilityId)
      ?? facilities.find((facility) => facility.isPrimary)
      ?? facilities[0];
    if (!selected) throw new UnauthorizedException('No active facility membership');
    return {
      id: identity.subject,
      subject: identity.subject,
      accountId: identity.accountId ?? '',
      sessionId,
      email: identity.email,
      displayName: identity.displayName,
      roles: selected.roles,
      role: selected.roles[0],
      permissions: selected.permissions,
      platformRoles: platformAuthority.roles,
      platformPermissions: platformAuthority.permissions,
      facilityIds: facilities.map((facility) => facility.id),
      facilities,
      facility: selected,
      authenticationMethod: identity.authenticationMethod,
    };
  }

  private facility(row: StaffContextRow): FacilityAssignment {
    return {
      id: row.facility_id,
      membershipId: row.membership_id,
      organizationId: row.organization_id,
      name: row.facility_name,
      ...(row.facility_code ? { code: row.facility_code } : {}),
      roles: [...new Set(row.roles)].sort(),
      permissions: [...new Set(row.permissions)].sort(),
      isPrimary: row.is_primary,
    };
  }
}
