import { IsDateString, IsIn, IsObject, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { ACCOUNT_DELETION_NOTICE_KINDS, type AccountDeletionNoticeKind } from '../../providers/account-deletion-emails';

/**
 * E4 (B5, 0096): an account-deletion email, to the account's verified email.
 * Fixed fields only, email only; the global pipe refuses any other field, so
 * no name, Health ID or free text can be sent. scheduledFor is required for
 * a scheduled email.
 */
export class DeliverAccountDeletionDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsIn(ACCOUNT_DELETION_NOTICE_KINDS) kind!: AccountDeletionNoticeKind;
  @ValidateIf((input: { kind?: string; scheduledFor?: unknown }) => input.kind === 'scheduled' || input.scheduledFor !== undefined)
  @IsDateString({ strict: true }) scheduledFor?: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}
