import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';

interface StaffNameRow extends QueryResultRow {
  membership_id: string;
  name: string | null;
  current: boolean;
}

/** The most names one answer carries without a membershipIds filter. */
export const FACILITY_STAFF_NAMES_LIMIT = 500;

/**
 * The names of the X-Facility-ID facility's staff, past and present, by
 * membership: the facility is the request's, bound by the guard to one of
 * the caller's own active memberships, and never anything the caller names.
 * A member whose login was deleted is answered with no name. No email,
 * licence, role or account id is read.
 */
export const FACILITY_STAFF_NAMES_SQL = `select membership.id::text as membership_id,
         case when account.status = 'deleted' then null
              else coalesce(nullif(btrim(account.display_name), ''), nullif(btrim(staff.full_name), '')) end as name,
         (membership.active and staff.active and account.status = 'active') as current
    from identity.staff_facility_memberships membership
    join identity.staff staff
      on staff.id = membership.staff_id
     and staff.account_id = membership.account_id
    join auth.accounts account
      on account.id = membership.account_id
   where membership.facility_id = $1::uuid
     and ($2::uuid[] is null or membership.id = any($2::uuid[]))
   order by 3 desc, 2 nulls last, 1
   limit $3`;

/**
 * SX-9 (Akos P1-10): who started each job or case on this facility's saved
 * lists (OCR jobs, registration cases) is shown by name. Read only.
 */
@Injectable()
export class FacilityStaffNamesService {
  constructor(private readonly database: DatabaseService) {}

  async list(context: DataAccessContext, membershipIds: readonly string[] | undefined) {
    const ids = membershipIds ? [...new Set(membershipIds.map((id) => id.toLowerCase()))] : null;
    const rows = await this.database.withTransaction(context, async (client) => (await client.query<StaffNameRow>(
      FACILITY_STAFF_NAMES_SQL, [context.facilityId, ids, FACILITY_STAFF_NAMES_LIMIT + 1])).rows, { readOnly: true });
    const shown = rows.slice(0, FACILITY_STAFF_NAMES_LIMIT);
    return {
      facilityId: context.facilityId,
      staff: shown.map((row) => ({ membershipId: row.membership_id, name: row.name, current: row.current === true })),
      complete: rows.length <= FACILITY_STAFF_NAMES_LIMIT,
    };
  }
}
