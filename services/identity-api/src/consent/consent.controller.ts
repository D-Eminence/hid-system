import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AuditAction, PatientAllowed, RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { consentContext } from './consent-context';
import { ConsentService } from './consent.service';
import { CloseGrantDto } from './dto/close-grant.dto';
import { DenyAccessRequestDto } from './dto/deny-access-request.dto';
import { CreateAccessRequestDto } from './dto/create-access-request.dto';
import { CreateBreakGlassDto } from './dto/create-break-glass.dto';
import { VerifyPatientAccessPinDto } from './dto/verify-patient-access-pin.dto';

@Controller('identity')
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  @Post('access-requests')
  @HttpCode(201)
  @RequirePermissions('identity.consent.write')
  @AuditAction('identity.access-request.command')
  createAccessRequest(@Req() request: HidRequest, @Body() input: CreateAccessRequestDto) {
    return this.consent.createAccessRequest(
      consentContext(request, ['direct-care', 'healthcare-operations']),
      input,
    );
  }

  @Post('access-requests/:requestId/approve')
  @HttpCode(200)
  @PatientAllowed()
  @AuditAction('identity.access-request.approve.command')
  approveAccessRequest(
    @Req() request: HidRequest,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
  ) {
    return this.consent.approveAccessRequest(consentContext(request, ['direct-care']), requestId);
  }

  @Post('access-requests/:requestId/deny')
  @HttpCode(200)
  @PatientAllowed()
  @AuditAction('identity.access-request.deny.command')
  denyAccessRequest(
    @Req() request: HidRequest,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body() input: DenyAccessRequestDto,
  ) {
    return this.consent.denyAccessRequest(consentContext(request, ['direct-care']), requestId, input.reason);
  }

  @Post('break-glass')
  @HttpCode(201)
  @RequirePermissions('identity.consent.write', 'identity.break-glass.write')
  @AuditAction('identity.break-glass.command')
  activateBreakGlass(@Req() request: HidRequest, @Body() input: CreateBreakGlassDto) {
    return this.consent.activateBreakGlass(consentContext(request, ['emergency']), input);
  }

  @Post('standard-access/pin')
  @HttpCode(200)
  @RequirePermissions('identity.patient-access-pin.verify')
  @AuditAction('identity.patient-access-pin.verify.command')
  verifyPatientAccessPin(@Req() request: HidRequest, @Body() input: VerifyPatientAccessPinDto) {
    return this.consent.verifyPatientAccessPin(consentContext(request, ['direct-care']), input);
  }

  @Post('consent-grants/:grantId/close')
  @HttpCode(200)
  @RequirePermissions('identity.consent.write')
  @AuditAction('identity.consent-grant.close.command')
  closeOwnGrant(
    @Req() request: HidRequest,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body() input: CloseGrantDto,
  ) {
    return this.consent.closeOwnGrant(
      consentContext(request, ['direct-care', 'emergency', 'healthcare-operations']),
      grantId,
      input.reason,
    );
  }
}
