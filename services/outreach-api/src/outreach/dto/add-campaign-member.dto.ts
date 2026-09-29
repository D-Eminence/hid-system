import { IsIn, IsUUID } from 'class-validator';
export class AddCampaignMemberDto {
  @IsUUID('4') membershipId!: string;
  @IsIn(['enumerator','health_worker','admin']) role!: 'enumerator' | 'health_worker' | 'admin';
}
