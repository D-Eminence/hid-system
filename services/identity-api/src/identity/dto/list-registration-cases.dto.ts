import { Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

export const REGISTRATION_CASE_LIST_VIEWS = ['mine', 'facility'] as const;
export type RegistrationCaseListView = typeof REGISTRATION_CASE_LIST_VIEWS[number];

export const REGISTRATION_CASE_LIST_STATUSES = [
  'pending_new_identity_approval',
  'review_required',
  'resolved_existing_identity',
  'linked_existing',
  'approved_new_identity',
  'rejected',
  'cancelled',
] as const;

/**
 * SX-10: GET identity/registration-cases. Query parameters only; none of them
 * is a Health ID, a NIN or a name.
 */
export class ListRegistrationCasesDto {
  /** 'mine' (cases this member started, the default) or 'facility' (every case here; approvers only). */
  @IsOptionalButNotNull()
  @IsIn(REGISTRATION_CASE_LIST_VIEWS)
  view: RegistrationCaseListView = 'mine';

  @IsOptionalButNotNull()
  @IsIn(REGISTRATION_CASE_LIST_STATUSES)
  status?: typeof REGISTRATION_CASE_LIST_STATUSES[number];

  @IsOptionalButNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  /**
   * 0130: 'none' lists only registrations without a NIN (every one of them
   * is a possible duplicate to review later, ID-8a); 'nin' only those whose
   * NIN was checked.
   */
  @IsOptionalButNotNull()
  @IsIn(['none', 'nin'])
  evidence?: 'none' | 'nin';

  /** The `nextCursor` of the previous page, as it was given. */
  @IsOptionalButNotNull()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,200}$/)
  cursor?: string;
}
