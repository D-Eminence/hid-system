import { IsString, Length, MaxLength, MinLength } from 'class-validator';

/** POST /ehr/me/chat: the question and the notice version the patient acknowledged. Unknown fields are refused. */
export class AskRecordChatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  question!: string;

  @IsString()
  @Length(1, 40)
  noticeVersion!: string;
}
