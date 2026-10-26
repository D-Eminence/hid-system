import { IsNotEmpty, IsString, Length } from 'class-validator';

/**
 * The patient's reason for revoking a grant (main's DTO, eb9b1ca). The length
 * is checked on the raw string here; the service trims it and the database
 * command checks 3-500 characters again after trimming (22023).
 */
export class RevokeConsentGrantDto {
  @IsString()
  @IsNotEmpty()
  @Length(3, 500)
  reason!: string;
}
