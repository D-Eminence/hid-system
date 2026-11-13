import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** outreach-api's POST identity/outreach/health-id/start (0119): the registration and where the code goes. */
export class StartOutreachHealthIdDto {
  @IsUUID()
  caseId!: string;

  @IsIn(['email', 'sms'])
  channel!: 'email' | 'sms';

  /** Required for channel email; checked by the service so that a bad one answers OUTREACH_HEALTH_ID_EMAIL_INVALID. */
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;
}

/** outreach-api's POST identity/outreach/health-id/confirm (0119): the code the person read out. */
export class ConfirmOutreachHealthIdDto {
  @IsUUID()
  caseId!: string;

  /** Six digits; anything else answers OUTREACH_HEALTH_ID_CODE_INVALID. */
  @IsString()
  @MaxLength(32)
  code!: string;
}

/** outreach-api's POST identity/outreach/health-id/create-unclaimed (0120): the registration only. */
export class CreateUnclaimedOutreachHealthIdDto {
  @IsUUID()
  caseId!: string;
}
