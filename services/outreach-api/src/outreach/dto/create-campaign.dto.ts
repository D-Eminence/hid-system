import { IsArray, IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCampaignDto {
  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsArray() @IsIn(['registration','vitals','vaccination','lab_sample','referral'], { each: true }) services!: string[];
  @IsDateString() startsAt!: string;
  @IsOptional() @IsDateString() endsAt?: string;
}
