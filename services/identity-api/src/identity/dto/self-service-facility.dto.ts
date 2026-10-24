import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
export const SELF_SERVICE_FACILITY_STATES = ['unreviewed', 'reviewed', 'all'] as const;
export type SelfServiceFacilityState = typeof SELF_SERVICE_FACILITY_STATES[number];

export class ListSelfServiceFacilitiesDto {
  @IsOptional() @IsIn(SELF_SERVICE_FACILITY_STATES)
  state?: SelfServiceFacilityState;
}

/** Support's note that a self-signed-up facility was checked: 8-500 characters, trimmed. */
export class ReviewSelfServiceFacilityDto {
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  note!: string;
}
