import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { ActorContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { OWN_PROFILE_VERSION_SQL, ownNameChangeEnabled, ownPasswordChangeEnabled } from './staff-profile-changes';

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
 * SX-5 (Akos P1-8, read part): "My profile" for staff. The changes are SX-6
 * (password while signed in, the name; 0205, each behind its setting) and
 * SX-7 (preferences, shortcuts). Memberships come from the session already
 * resolved by the guard (every active membership the product gate admits on
 * this site). canChange.name is true while STAFF_NAME_CHANGE_ENABLED is on
 * (AUTH_MODE=local), and the answer then carries profileVersion; canChange.password is true
 * while STAFF_PASSWORD_CHANGE_ENABLED is on (AUTH_MODE=local) and the account
 * has a password. Both routes refuse sealed QA and demo logins
 * (STAFF_PROFILE_CHANGE_NOT_ALLOWED), and the password route bearer callers.
 */
@Injectable()
export class StaffProfileService {
  constructor(private readonly database: DatabaseService) {}

  async read(actor: ActorContext, currentFacilityId: string | undefined, correlationId?: string) {
    const nameEditable = ownNameChangeEnabled();
    let row: StaffProfileRow | undefined;
    let profileVersion: number | undefined;
    if (nameEditable && correlationId) {
      // SX-6 (0205): the profile version, through 0205's function (the runtime has no grant on its table), in one
      // read-only transaction with the account-only context it reads the session's account from. The setting is
      // on only once the start-up check has found the function and its EXECUTE.
      ({ row, profileVersion } = await this.database.withTransaction({ actor, facilityId: '', membershipId: '',
        correlationId, purposeOfUse: 'healthcare-operations' }, async (client) => {
        const found = (await client.query<StaffProfileRow>(STAFF_PROFILE_SQL, [actor.accountId, actor.subject])).rows[0];
        const version = found
          ? Number((await client.query<{ profile_version: string | null }>(OWN_PROFILE_VERSION_SQL)).rows[0]?.profile_version)
          : undefined;
        return { row: found, profileVersion: Number.isSafeInteger(version) && (version ?? 0) >= 1 ? version : undefined };
      }, { readOnly: true }));
    } else {
      row = (await this.database.query<StaffProfileRow>(STAFF_PROFILE_SQL, [actor.accountId, actor.subject])).rows[0];
    }
    if (!row) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    const name = row.display_name?.trim() || row.full_name?.trim() || actor.displayName || actor.subject;
    // A stored number with no letter or digit ('--') has no hint: no licence is shown.
    const licenceHint = licenceNumberHint(row.licence_number);
    return {
      accountId: row.account_id,
      name,
      email: row.email,
      signIn: {
        method: actor.authenticationMethod === 'oidc' ? 'single_sign_on' : 'password',
        hasPassword: row.has_password === true,
        passwordChangedAt: iso(row.password_changed_at),
      },
      licence: licenceHint ? { numberHint: licenceHint } : null,
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
      // SX-6: present while the name edit is on; expectedVersion of POST /identity/me/staff-profile.
      ...(profileVersion !== undefined ? { profileVersion } : {}),
      canChange: {
        name: nameEditable && profileVersion !== undefined,
        password: ownPasswordChangeEnabled() && row.has_password === true,
        preferences: false,
      },
    };
  }
}
