import { Injectable, UnauthorizedException } from '@nestjs/common';
import type {
  ActorContext, FacilityAssignment, FacilitySelfService, OrganizationKind, OrganizationProduct,
} from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { CredentialIdentity } from './auth.types';
import { ACTIVE_STAFF_VERIFICATION_STATUSES } from './auth-policy';
import { facilityAdmittedOnProduct, NoActiveFacilityMembershipProblem, ProductNotAuthorisedProblem, productsForFacilities,
  type StaffProduct } from './product-gate';

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
  /** identity.organization_self_service_state's review_state: null for governed and legacy organizations. */
  review_state?: string | null;
  organization_type?: string | null;
  /** identity.organization_staff_kinds (0124): the organisation's effective kinds, empty when none is recorded. */
  organization_kinds?: string[] | null;
  /** identity.organization_staff_kinds (0124): the organisation's active product codes, empty when it holds none. */
  organization_products?: string[] | null;
}

interface PlatformAuthorityRow {
  roles: string[];
  permissions: string[];
}

/**
 * The staff context's membership query exactly as it was before P4b, without
 * its ORDER BY (FEA R4). Kept byte-identical so governed and legacy facilities
 * resolve exactly as before.
 */
export const STAFF_MEMBERSHIPS_SQL = `select account.id::text as account_id,
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
                 facility.name, facility.code`;

/**
 * P4b wraps that query: after grouping, one call per membership row of
 * identity.organization_self_service_state (0086 §5, stable, definer) adds the
 * organization's self sign-up state, which answers no row for governed and
 * legacy organizations. Owner decisions Q90 and Q91 (17 November 2026) add one
 * lateral call per membership row of identity.organization_staff_kinds (0124,
 * stable, definer, one row): the organisation's recorded kinds and the
 * products it holds, which the product gate reads for an administrator. The
 * order is the old one.
 */
export const STAFF_CONTEXT_SQL = `select grouped.*, state.review_state, state.organization_type, kinds.organization_kinds,
         kinds.organization_products
         from (${STAFF_MEMBERSHIPS_SQL}) grouped
         left join lateral identity.organization_self_service_state(grouped.organization_id::uuid) state on true
         left join lateral identity.organization_staff_kinds(grouped.organization_id::uuid) kinds on true
        order by grouped.is_primary desc, grouped.facility_name, grouped.facility_id::uuid`;

const SELF_SERVICE_REVIEW_STATES = new Set(['pending', 'reviewed']);
const ORGANIZATION_KINDS: readonly OrganizationKind[] = ['clinic', 'hospital', 'laboratory', 'pharmacy'];

/** The recorded kinds the gate knows, sorted and once each; an unknown value is dropped. */
function organizationKinds(value: unknown): OrganizationKind[] {
  if (!Array.isArray(value)) return [];
  return ORGANIZATION_KINDS.filter((kind) => value.includes(kind));
}

const ORGANIZATION_PRODUCTS: readonly OrganizationProduct[] = ['ehr', 'laboratory', 'migrate', 'pharmacy'];

/** The held products the gate knows, sorted and once each; an unknown value is dropped. */
function organizationProducts(value: unknown): OrganizationProduct[] {
  if (!Array.isArray(value)) return [];
  return ORGANIZATION_PRODUCTS.filter((product) => value.includes(product));
}

/**
 * Whether an active account with no facility membership is a verified staff
 * login (Q88-2): an active staff record with a verified status, no platform
 * role assignment at all (revoked ones aside) and not one of the sealed demo
 * tenant's accounts (0098's identity.sealed_demo_ids, granted to this
 * runtime). The same conditions identity.activate_outreach_organiser_for_account
 * (0115) checks before it starts an outreach group for an account.
 */
export const VERIFIED_STAFF_WITHOUT_MEMBERSHIP_SQL = `select
         exists (select 1 from identity.staff staff
                  where staff.account_id = $1::uuid
                    and staff.active
                    and lower(btrim(staff.verification_status)) = any($2::text[])) as verified_staff,
         exists (select 1 from auth.account_roles assignment
                  where assignment.account_id = $1::uuid
                    and assignment.scope_type = 'platform'
                    and assignment.revoked_at is null) as platform_role,
         ($1::uuid = any(coalesce((select identity.sealed_demo_ids('account'))::uuid[], array[]::uuid[]))) as sealed_demo`;

/** How a staff session is resolved: the product of the site it is used on, when that site is a product site. */
export interface StaffResolution {
  product?: StaffProduct;
}

@Injectable()
export class CurrentStaffContextService {
  constructor(private readonly database: DatabaseService) {}

  async resolve(
    subject: string,
    authenticationMethod: ActorContext['authenticationMethod'],
    sessionId?: string,
    preferredFacilityId?: string,
    resolution: StaffResolution = {},
  ): Promise<ActorContext> {
    let identity = await this.resolvePostgres(subject, authenticationMethod);
    const hasMembership = identity !== undefined && identity.facilities.length > 0;
    if (!identity) {
      const account = await this.database.query<{ id: string; email: string | null; display_name: string | null }>(
        `select id::text, email, display_name from auth.accounts
          where subject = $1 and status = 'active'
            and (disabled_until is null or disabled_until <= clock_timestamp())`,
        [subject],
      );
      const row = account.rows[0];
      if (!row) throw new UnauthorizedException('Staff account or facility membership is inactive');
      identity = { subject, accountId: row.id, ...(row.email ? { email: row.email } : {}),
        displayName: row.display_name ?? subject, facilities: [], authenticationMethod };
    }
    const platformAuthority = await this.resolvePlatformAuthority(identity.accountId);
    const product = resolution.product;
    if (hasMembership) {
      // Q97: every site the login can open, from all its memberships, before this site's filter.
      const products = productsForFacilities(identity.facilities);
      if (product) {
        // Q88-1: only the memberships whose permissions fit this site's product.
        const fitting = identity.facilities.filter((facility) => facilityAdmittedOnProduct(facility, product));
        if (fitting.length === 0) throw new ProductNotAuthorisedProblem(product, identity.subject);
        identity = { ...identity, facilities: fitting };
      }
      return { ...this.toActor(identity, platformAuthority, sessionId, preferredFacilityId), products };
    }
    // No active membership. A platform administrator keeps today's session
    // on a site with no product (admin.); on a product site no facility fits.
    if (platformAuthority.permissions.includes('platform.admin.access')) {
      if (product) throw new ProductNotAuthorisedProblem(product, identity.subject);
      return { ...this.toActor(identity, platformAuthority, sessionId, preferredFacilityId), products: [] };
    }
    // Q88-2: a verified staff login with no membership yet. On outreach. it
    // gets an account-only session (no facility) for "Start an outreach
    // group"; on every other site it is told so. Anyone else keeps the
    // wrong-password answer (LOGIN-DETAIL-ORACLE).
    if (!(await this.verifiedStaffWithoutMembership(identity.accountId))) {
      throw new UnauthorizedException('Staff account or facility membership is inactive');
    }
    if (product !== 'outreach') throw new NoActiveFacilityMembershipProblem(identity.subject);
    return { ...this.toActor(identity, platformAuthority, sessionId, undefined, true), accountOnly: true as const,
      products: ['outreach'] };
  }

  /** Q88-2's eligibility, read only for an active account that has no active membership. */
  private async verifiedStaffWithoutMembership(accountId: string | undefined): Promise<boolean> {
    if (!accountId) return false;
    const result = await this.database.query<{ verified_staff: boolean; platform_role: boolean; sealed_demo: boolean }>(
      VERIFIED_STAFF_WITHOUT_MEMBERSHIP_SQL, [accountId, [...ACTIVE_STAFF_VERIFICATION_STATUSES]]);
    const row = result?.rows?.[0];
    return row?.verified_staff === true && row.platform_role === false && row.sealed_demo === false;
  }

  private async resolvePostgres(
    subject: string,
    authenticationMethod: 'local' | 'oidc',
  ): Promise<CredentialIdentity | undefined> {
    const result = await this.database.query<StaffContextRow>(
      STAFF_CONTEXT_SQL,
      [subject, [...ACTIVE_STAFF_VERIFICATION_STATUSES]],
    );
    const first = result.rows[0];
    if (!first) return undefined;
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
       join auth.accounts account
         on account.id = assignment.account_id and account.status = 'active'
        and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
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
    accountOnly = false,
  ): ActorContext {
    const facilities = [...identity.facilities].sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
      return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    });
    const selected = facilities.find((facility) => facility.id === preferredFacilityId)
      ?? facilities.find((facility) => facility.isPrimary)
      ?? facilities[0];
    if (!selected && !accountOnly && !platformAuthority.permissions.includes('platform.admin.access')) {
      throw new UnauthorizedException('Staff account or facility membership is inactive');
    }
    return {
      id: identity.subject,
      subject: identity.subject,
      accountId: identity.accountId ?? '',
      sessionId,
      email: identity.email,
      displayName: identity.displayName,
      roles: selected?.roles ?? [],
      role: selected?.roles[0],
      permissions: selected?.permissions ?? [],
      platformRoles: platformAuthority.roles,
      platformPermissions: platformAuthority.permissions,
      facilityIds: facilities.map((facility) => facility.id),
      facilities,
      facility: selected,
      authenticationMethod: identity.authenticationMethod,
    };
  }

  private facility(row: StaffContextRow): FacilityAssignment {
    const kinds = organizationKinds(row.organization_kinds);
    const products = kinds.length > 0 ? organizationProducts(row.organization_products) : [];
    return {
      id: row.facility_id,
      membershipId: row.membership_id,
      organizationId: row.organization_id,
      name: row.facility_name,
      ...(row.facility_code ? { code: row.facility_code } : {}),
      roles: [...new Set(row.roles)].sort(),
      permissions: [...new Set(row.permissions)].sort(),
      isPrimary: row.is_primary,
      // Only a self-signed-up organization that is pending or reviewed; a
      // released one is inactive and never listed.
      ...(row.review_state && SELF_SERVICE_REVIEW_STATES.has(row.review_state) && row.organization_type
        ? { selfService: {
          review: row.review_state as FacilitySelfService['review'],
          organizationType: row.organization_type as FacilitySelfService['organizationType'],
        } } : {}),
      // Q90/Q91: only when a kind is recorded, so a membership with none (a
      // hospital to the gate) answers exactly as before; the held products
      // only beside a kind, since only an organisation with a kind reads them.
      ...(kinds.length > 0 ? { organizationKinds: kinds } : {}),
      ...(products.length > 0 ? { organizationProducts: products } : {}),
    };
  }
}
