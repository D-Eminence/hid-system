import { IsIn } from 'class-validator';

/**
 * The Outreach permissions Identity authorizes (migrations 0024 and 0038): all four.
 * outreach.campaign.write was refused until campaigns had campaign-level governance (ADR-045). Since 0122 (option B,
 * the decision relayed in chat on 2026-11-11) a holder may create a campaign and becomes its admin, and only a
 * campaign's own admins open, close or staff it, in outreach-api and in the database. This must not ship to a database
 * without 0122: there, any holder could add themselves to any campaign and read its linked registrations.
 */
export const OUTREACH_PERMISSIONS = [
  'outreach.registration.read', 'outreach.registration.write', 'outreach.campaign.read', 'outreach.campaign.write',
] as const;
export type OutreachPermission = typeof OUTREACH_PERMISSIONS[number];

export class AuthorizeOutreachDto {
  @IsIn(OUTREACH_PERMISSIONS)
  permission!: OutreachPermission;
}
