import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/**
 * Optional paging of the registration list (the website without them gets the
 * newest 100, as before): one campaign's registrations, a page size of 1-500,
 * and the cursor from the previous page's X-Next-Cursor header.
 */
export class ListRegistrationCasesQueryDto {
  @IsOptional() @IsUUID('4')
  campaignId?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : value)
  @IsInt({ message: 'limit must be a whole number from 1 to 500' }) @Min(1) @Max(500)
  limit?: number;

  @IsOptional() @IsString() @MaxLength(96)
  before?: string;
}
