import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { PatientAllowed, FacilityOptional, AuditAction, AuditFailuresOnly, RequirePermissions } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { VerifyCacDto } from './dto/verify-cac.dto';
import { VerifyNinDto } from './dto/verify-nin.dto';
import { QoreIdVerificationService } from './qoreid-verification.service';
import type { OrganizationVerificationContext } from './qoreid-verification.types';

const ORGANIZATION_CONTEXTS = new Set<OrganizationVerificationContext>(['hospital', 'laboratory', 'pharmacy']);

@Controller('identity')
export class QoreIdVerificationController {
  constructor(private readonly verification: QoreIdVerificationService) {}

  @Post('me/verification/nin')
  @HttpCode(200)
  @PatientAllowed()
  @FacilityOptional()
  @AuditFailuresOnly()
  @AuditAction('identity.patient.nin-verification.command')
  verifyMyNin(@Body() input: VerifyNinDto, @Req() request: HidRequest) {
    return this.verification.verifyPatientNin(request, input.nin);
  }

  @Post('organizations/verification/cac/:organizationContext')
  @HttpCode(200)
  @RequirePermissions('organization.manage')
  @AuditFailuresOnly()
  @AuditAction('identity.organization.cac-verification.command')
  verifyOrganizationCac(
    @Param('organizationContext') organizationContext: string,
    @Body() input: VerifyCacDto,
    @Req() request: HidRequest,
  ) {
    if (!ORGANIZATION_CONTEXTS.has(organizationContext as OrganizationVerificationContext)) {
      throw new DomainProblem(400, 'VERIFICATION_CONTEXT_INVALID', 'The organization verification context is invalid');
    }
    return this.verification.verifyOrganizationCac(
      request,
      organizationContext as OrganizationVerificationContext,
      input.regNumber,
    );
  }
}
