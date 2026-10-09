import { IsUUID } from 'class-validator';

export class SelectFacilityDto {
  @IsUUID('4')
  facilityId!: string;
}
