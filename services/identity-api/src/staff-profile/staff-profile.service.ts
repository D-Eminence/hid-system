import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { ActorContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';

interface StaffProfileRow extends QueryResultRow {
  account_id: string;
  display_name: string | null;
  email: string | null;
  password_changed_at: Date | string | null;
  has_password: boolean;
  account_created_at: Date | string;
  full_name: string | null;
  licence_number: string | null;
}

/**
 * The signed-in member's own account and staff record, by account id and
 * subject together, active accounts only. It never selects the password hash
 * itself (has_password is computed in the database). Same tables the staff
 * session is built from (auth.accounts, identity.staff; neither has
 * row-level security; hid_identity_runtime reads both).
 */
export const STAFF_PROFILE_SQL = `select account.id::text as account_id,
         account.display_name,
         account.email,
         account.password_changed_at,
         (account.password_hash is not null) as has_password,
         account.created_at as account_created_at,
         staff.full_name,
         staff.license_number as licence_number
    from auth.accounts account
    left join identity.staff staff
      on staff.account_id = account.id
     and staff.active
   where account.id = $1::uuid
     and account.subject = $2
     and account.status = 'active'`;

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** What a facility sees of a licence number (0086 identity.licence_number_hint): its last four letters or digits. */
export function licenceNumberHint(value: string | null): string | null {
  if (!value) return null;
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return compact ? compact.slice(-4) : null;
}

/**
 * SX-5 (Akos P1-8, read part): "My profile" for staff. Read only; the
 * changes (password while signed in, preferences, shortcuts) are SX-6 and
 * SX-7. Memberships come from the session already resolved by the guard
 * (every active membership the product gate admits on this site).
 */
@Injectable()
export class StaffProfileService {
  constructor(private readonly database: DatabaseService) {}

  async read(actor: ActorContext, currentFacilityId: string | undefined) {
    const result = await this.database.query<StaffProfileRow>(STAFF_PROFILE_SQL, [actor.accountId, actor.subject]);
    const row = result.rows[0];
    if (!row) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    const name = row.display_name?.trim() || row.full_name?.trim() || actor.displayName || actor.subject;
    return {
      accountId: row.account_id,
      name,
      email: row.email,
      signIn: {
        method: actor.authenticationMethod === 'oidc' ? 'single_sign_on' : 'password',
        hasPassword: row.has_password === true,
        passwordChangedAt: iso(row.password_changed_at),
      },
      licence: row.licence_number ? { numberHint: licenceNumberHint(row.licence_number) } : null,
      memberSince: iso(row.account_created_at),
      currentFacilityId: currentFacilityId ?? null,
      facilities: actor.facilities.map((facility) => ({
        id: facility.id,
        membershipId: facility.membershipId,
        name: facility.name,
        roles: [...facility.roles],
        isPrimary: facility.isPrimary,
        isCurrent: facility.id === currentFacilityId,
      })),
      products: [...(actor.products ?? [])],
      canChange: { name: false, password: false, preferences: false },
    };
  }
}
