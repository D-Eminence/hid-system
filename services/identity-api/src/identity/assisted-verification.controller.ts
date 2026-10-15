import { Body, Controller, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { AssistedRegistrationEnabledGuard } from './assisted-registration.guard';
import { AssistedVerificationService } from './assisted-verification.service';
import { AssistedVerificationDto } from './dto/assisted-verification.dto';

/**
 * The in-person check of facility-assisted registration (ADR-063): a staff
 * member at a participating facility types the desk code the patient's own
 * device shows and the name and date of birth from one original photo ID.
 * The answer is verified, a mismatch per field, or a refusal; never the NIN,
 * a record value, the contact or a Health ID.
 */
@Controller('identity/assisted-verifications')
export class AssistedVerificationController {
  constructor(private readonly assisted: AssistedVerificationService) {}

  @Post()
  @HttpCode(200)
  @RequirePermissions('identity.patient.assisted_registration')
  @UseGuards(AssistedRegistrationEnabledGuard)
  @AuditAction('identity.assisted-verification.request')
  async verify(@Body() input: AssistedVerificationDto, @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest) {
    const key = requireIdempotencyKey(idempotencyKey);
    // Registration is healthcare operations; the staff command records it.
    return this.assisted.verify(input, key, requireRequestContext(request, 'healthcare-operations'));
  }
}
