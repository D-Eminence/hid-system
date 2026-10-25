import { IsDateString, IsIn, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { STAFF_INVITATION_ROLES, type StaffInvitationRole } from '../../providers/provider.types';

/**
 * The facility's name as an invitation may show it (P4b, SPEC 7): 1-200
 * characters (QoreID legal names can exceed the alert's 120), no control or
 * format characters, no angle brackets, nothing link-like ("://") and nothing
 * domain-like (a letter or digit, a dot, then two letters, as in
 * "hid-payroll.com"), which mail clients may turn into a link (S3). Identity
 * omits a name that would not pass, and the email then says "a facility".
 */
export const STAFF_INVITATION_FACILITY_NAME = /^(?!.*:\/\/)(?!.*[\p{L}\p{N}]\.[\p{L}]{2})[^\p{Cc}\p{Cf}<>]{1,200}$/u;

/**
 * A facility staff invitation email (P4b). Fixed fields only: there is no
 * name of any person and no free-text field (S3), so unknown fields are
 * refused by the global pipe. The link, code and expiry are rendered by this
 * service; the link's host is this deployment's portal, never a request value.
 */
export class DeliverStaffInvitationDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsOptional() @IsString() @Matches(STAFF_INVITATION_FACILITY_NAME) facilityName?: string | null;
  @IsIn(STAFF_INVITATION_ROLES) roleCode!: StaffInvitationRole;
  @IsUUID('4') invitationId!: string;
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token!: string;
  @IsString() @Matches(/^\d{6}$/) code!: string;
  @IsDateString({ strict: true }) expiresAt!: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}
