import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /outreach/registration-cases/:caseId/health-id/start (0119). */
export class StartHealthIdDto {
  /** 'sms' is accepted and answered 503 OUTREACH_HEALTH_ID_UNAVAILABLE until SMS codes are live. */
  @IsIn(['email', 'sms'])
  channel!: 'email' | 'sms';

  /** Required for channel email; a bad one answers 422 OUTREACH_HEALTH_ID_EMAIL_INVALID. */
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;
}

/** POST /outreach/registration-cases/:caseId/health-id/confirm (0119). */
export class ConfirmHealthIdDto {
  /** Six digits; anything else answers 422 OUTREACH_HEALTH_ID_CODE_INVALID. */
  @IsString()
  @MaxLength(32)
  code!: string;
}
