-- Staff working facility per sign-in (ADR-046). A staff member who works at
-- more than one facility chooses one with POST /auth/facility. The Identity API
-- used to store nothing, so every reload (GET /auth/session) and refresh
-- reported the primary facility again and the browser silently moved back to
-- it. The choice is now kept for the sign-in, keyed by its session family as
-- auth.session_assurance is (0069): refresh rotates the session row but keeps
-- the family, so the choice survives rotation, and another sign-in of the same
-- account has its own.
--
-- The row is only the default the session reports. It authorizes nothing:
-- every facility-scoped request still carries X-Facility-ID, which the Identity
-- guard checks against the actor's active memberships, and the Identity API
-- re-checks the stored facility against those memberships whenever it reads it.
--
-- Since staff MFA (0088, ADR-054) a staff sign-in is a session issued after
-- its second factor, so the sign-in a selection belongs to is one that
-- completed the authenticator step; the Identity API reads and writes the
-- selection only through a session its guard has already found MFA-verified.
--
-- Written as 0080 in D-Eminence/hid-system#47 and renumbered 0089 when ported
-- after the launch migrations 0080-0088. Applied migrations 0001 through 0088
-- are immutable. This migration only adds a table, its guard and its trigger:
-- no existing row, function, policy or grant changes.

create table auth.session_facility_selection (
  family_id uuid primary key references auth.sessions(id) on delete restrict,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  membership_id uuid not null,
  selected_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  -- The membership is one of this account's, at this facility.
  foreign key (membership_id, facility_id, account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict
);
comment on table auth.session_facility_selection is
  'Facility a staff sign-in (session family) explicitly selected. A default for GET /auth/session only, never an authorization: each request still carries X-Facility-ID, checked against active memberships.';

-- Admits a row only for the root session of a live staff sign-in of the same
-- account, and an active membership of that account at an active facility. The
-- membership, migration-hold, staff, organization and facility conditions
-- mirror CurrentStaffContextService (active membership without a migration
-- hold, active and verified staff record of the account, active organization,
-- active facility of that organization). Account status and disabled_until are
-- not repeated: TokenService.verify() refuses an inactive or disabled account
-- before the API writes. An update is checked the same way and cannot move the
-- row to another sign-in or account. Sign-out and revocation leave the row in
-- place, as they leave auth.session_assurance; nothing deletes it, and a
-- signed-out sign-in can never change it again.
create function auth.guard_session_facility_selection_change()
returns trigger
language plpgsql
set search_path = auth, identity, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'SESSION_FACILITY_SELECTION_IMMUTABLE';
  end if;
  if tg_op = 'UPDATE' and (new.family_id is distinct from old.family_id
     or new.account_id is distinct from old.account_id) then
    raise exception using errcode = '55000', message = 'SESSION_FACILITY_SELECTION_IMMUTABLE';
  end if;
  if not exists (
    select 1 from auth.sessions session_row
     where session_row.id = new.family_id and session_row.family_id = new.family_id
       and session_row.account_id = new.account_id and session_row.session_kind = 'staff'
  ) or not exists (
    -- The sign-in is live: a session of the family is unrevoked and unexpired.
    select 1 from auth.sessions live
     where live.family_id = new.family_id and live.revoked_at is null
       and live.expires_at > clock_timestamp() and live.absolute_expires_at > clock_timestamp()
  ) or not exists (
    select 1
      from identity.staff_facility_memberships membership
      join identity.staff staff_row
        on staff_row.id = membership.staff_id and staff_row.account_id = membership.account_id
      join identity.organizations organization_row on organization_row.id = membership.organization_id
      join identity.facilities facility
        on facility.id = membership.facility_id and facility.organization_id = membership.organization_id
     where membership.id = new.membership_id
       and membership.account_id = new.account_id
       and membership.facility_id = new.facility_id
       and membership.active
       and membership.migration_hold_reason is null
       and staff_row.active
       -- ACTIVE_STAFF_VERIFICATION_STATUSES in services/identity-api/src/auth/
       -- auth-policy.ts; identity.has_active_membership (0008) repeats it too.
       and lower(btrim(staff_row.verification_status)) in ('verified', 'approved', 'active')
       and organization_row.active
       and facility.active
  ) then
    raise exception using errcode = '23514', message = 'SESSION_FACILITY_SELECTION_INVALID';
  end if;
  return new;
end
$$;
revoke all on function auth.guard_session_facility_selection_change() from public;
create trigger session_facility_selection_guard
  before insert or update or delete on auth.session_facility_selection
  for each row execute function auth.guard_session_facility_selection_change();
