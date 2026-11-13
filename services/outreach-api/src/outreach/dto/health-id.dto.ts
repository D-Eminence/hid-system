import { DomainProblem } from '../../common/problem';
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

/**
 * POST /outreach/registration-cases/:caseId/health-id/create-unverified (0120)
 * takes the body {} (or none). Any field is refused 400 VALIDATION_FAILED, as
 * the validation pipe refuses an unknown field on the other routes (a DTO
 * class with no fields cannot be used: the pipe refuses every value for it).
 */
export function requireEmptyHealthIdBody(body: unknown): void {
  if (body === undefined || body === null) return;
  const fields = typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
  if (fields?.length === 0) return;
  throw new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
    fields ? fields.map((field) => ({ field, messages: [`property ${field} should not exist`] }))
      : [{ field: 'body', messages: ['the body must be an empty object'] }]);
}
