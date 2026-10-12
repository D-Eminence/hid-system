import { IsIn } from 'class-validator';

/** Every Outreach permission the database defines (migrations 0024 and 0038). */
export const OUTREACH_PERMISSIONS = [
  'outreach.registration.read', 'outreach.registration.write',
  'outreach.campaign.read', 'outreach.campaign.write',
] as const;
export type OutreachPermission = typeof OUTREACH_PERMISSIONS[number];

export class AuthorizeOutreachDto {
  @IsIn(OUTREACH_PERMISSIONS)
  permission!: OutreachPermission;
}
