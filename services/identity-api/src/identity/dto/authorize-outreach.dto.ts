import { IsIn } from 'class-validator';

/**
 * The Outreach permissions Identity authorizes (migrations 0024 and 0038).
 * outreach.campaign.write is defined but not authorized: Outreach's campaign
 * create, status and member routes have no campaign-level governance yet, so
 * any holder at the facility could add themselves to any campaign and read its
 * linked registrations, or close it (ADR-045).
 */
export const OUTREACH_PERMISSIONS = [
  'outreach.registration.read', 'outreach.registration.write', 'outreach.campaign.read',
] as const;
export type OutreachPermission = typeof OUTREACH_PERMISSIONS[number];

export class AuthorizeOutreachDto {
  @IsIn(OUTREACH_PERMISSIONS)
  permission!: OutreachPermission;
}
