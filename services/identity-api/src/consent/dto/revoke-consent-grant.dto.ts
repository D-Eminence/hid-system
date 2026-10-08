import { IsNotEmpty, IsString, Length } from 'class-validator';

export class RevokeConsentGrantDto {
  @IsString()
  @IsNotEmpty()
  @Length(3, 500)
  reason!: string;
}
