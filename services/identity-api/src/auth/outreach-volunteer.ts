import { ACTIVE_STAFF_VERIFICATION_STATUSES } from './auth-policy';

/** What a password-free sign-in may ask for: a long session on the volunteer's own phone, or the standard one. */
export type DeviceTrust = 'own_device' | 'standard';
/** How a password-free sign-in was made (recorded in the session event and the audit only). */
export type SignInVia = 'invitation_link' | 'email_code';

/** Which login to check: by account id (a session) or by email (a sign-in that starts from an address). */
export type VolunteerLookup = { accountId: string } | { email: string };

/** Anything that runs one parameterised query: a PoolClient or the DatabaseService. */
export interface EligibilityQueryable {
  query(text: string, values: unknown[]): Promise<{ rows: Array<{ eligible?: boolean | null }> }>;
}

/**
 * The one query that decides whether a login is a volunteer-only outreach
 * login, the only kind that may sign in without a password or keep a long
 * session. It reads only tables Identity's runtime role can already select
 * (auth.accounts, auth.account_roles, identity.staff,
 * identity.staff_facility_memberships) and calls only
 * identity.sealed_demo_facility, which Identity may execute. True only when:
 * - the account is active, its email is verified and it is not disabled;
 * - its subject is the one 0115 gives a volunteer created by an invitation
 *   ('outreach-volunteer:<account id>'), so patient logins, hospital staff
 *   and the sealed demo logins never match;
 * - it has an active, verified identity.staff record (as the staff context);
 * - it has at least one active facility role 'outreach_volunteer' on an
 *   active membership, and no other active role at all (platform roles too);
 * - every active membership is an outreach_volunteer one, and none is at a
 *   sealed demo facility.
 * identity.patients is not read: its row-level security shows Identity only
 * some patients, so it cannot prove a login is not a patient's. The subject
 * and the roles above already exclude patient logins.
 * This is the single source of truth: never decide from cached actor roles.
 */
export const VOLUNTEER_SIGN_IN_ELIGIBLE_SQL = `select exists (
  select 1
    from auth.accounts account
   where (($1::uuid is not null and account.id = $1::uuid)
          or ($1::uuid is null and $2::text is not null and lower(account.email) = lower($2::text)))
     and account.status = 'active'
     and account.email_verified_at is not null
     and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
     and account.subject = 'outreach-volunteer:' || account.id::text
     and exists (select 1 from identity.staff staff
                  where staff.account_id = account.id and staff.active
                    and lower(btrim(staff.verification_status)) = any($3::text[]))
     and exists (select 1 from auth.account_roles assignment
                   join identity.staff_facility_memberships membership
                     on membership.id = assignment.membership_id and membership.account_id = account.id
                    and membership.active
                  where assignment.account_id = account.id and assignment.revoked_at is null
                    and assignment.scope_type = 'facility' and assignment.role_code = 'outreach_volunteer')
     and not exists (select 1 from auth.account_roles assignment
                      where assignment.account_id = account.id and assignment.revoked_at is null
                        and (assignment.scope_type <> 'facility' or assignment.role_code <> 'outreach_volunteer'))
     and not exists (select 1 from identity.staff_facility_memberships membership
                      where membership.account_id = account.id and membership.active
                        and (membership.membership_role is distinct from 'outreach_volunteer'
                             or (membership.app_role is not null and membership.app_role <> 'outreach_volunteer')
                             or identity.sealed_demo_facility(membership.facility_id)))
) as eligible`;

/**
 * Whether the login may use password-free sign-in and the "own phone"
 * session (VOLUNTEER_SIGN_IN_ELIGIBLE_SQL). Anything but a true answer is
 * false. A database error is thrown to the caller, which decides how to fail
 * closed.
 */
export async function volunteerSignInEligible(client: EligibilityQueryable, lookup: VolunteerLookup): Promise<boolean> {
  const accountId = 'accountId' in lookup ? lookup.accountId : null;
  const email = 'email' in lookup ? lookup.email.trim() : null;
  if (accountId === null && !email) return false;
  const result = await client.query(VOLUNTEER_SIGN_IN_ELIGIBLE_SQL,
    [accountId, email, [...ACTIVE_STAFF_VERIFICATION_STATUSES]]);
  return result.rows[0]?.eligible === true;
}
