export type CampaignStatus = 'planned' | 'active' | 'closed';
export type CampaignRole = 'enumerator' | 'health_worker' | 'admin';
export interface OutreachCampaign {
  id: string; facilityId: string; name: string; services: string[]; status: CampaignStatus;
  startsAt: string; endsAt: string | null; rowVersion: number; createdAt: string; updatedAt: string;
}
/** A campaign's members by name, and to its admins who could be added (campaignRole null), with the caller's role. */
export interface CampaignStaff {
  yourRole: CampaignRole | null;
  people: { membershipId: string; name: string; campaignRole: CampaignRole | null }[];
}
export interface CampaignMember {
  id: string; campaignId: string; membershipId: string; role: CampaignRole; createdAt: string;
}
