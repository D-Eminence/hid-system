import { IsString, MaxLength, MinLength } from 'class-validator';

export class PatientChatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  question!: string;
}
