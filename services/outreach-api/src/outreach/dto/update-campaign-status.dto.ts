import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
export class UpdateCampaignStatusDto {
  @IsIn(['planned','active','closed']) status!: 'planned' | 'active' | 'closed';
  @IsString() @MinLength(8) @MaxLength(500) reason!: string;
}
