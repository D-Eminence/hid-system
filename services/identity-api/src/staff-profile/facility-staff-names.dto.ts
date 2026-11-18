import { IsOptional, Matches } from 'class-validator';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export const FACILITY_STAFF_NAMES_MAX_IDS = 100;

/**
 * GET /api/v1/identity/facility-staff-names[?membershipIds=<id>,<id>,…]:
 * up to 100 membership ids, comma separated. Unknown keys are refused by the
 * global validation pipe.
 */
export class FacilityStaffNamesQueryDto {
  @IsOptional()
  @Matches(new RegExp(`^${UUID}(?:,${UUID}){0,${FACILITY_STAFF_NAMES_MAX_IDS - 1}}$`))
  membershipIds?: string;
}
