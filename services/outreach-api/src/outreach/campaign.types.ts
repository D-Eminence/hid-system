export type CampaignStatus = 'planned' | 'active' | 'closed';
export type CampaignRole = 'enumerator' | 'health_worker' | 'admin';
export interface OutreachCampaign {
  id: string; facilityId: string; name: string; services: string[]; status: CampaignStatus;
  startsAt: string; endsAt: string | null; rowVersion: number; createdAt: string; updatedAt: string;
}
export interface CampaignMember {
  id: string; campaignId: string; membershipId: string; role: CampaignRole; createdAt: string;
}
