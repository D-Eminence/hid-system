import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, PatientOnly, RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { consentContext, patientConsentContext } from './consent-context';
import { ConsentService } from './consent.service';
import { CloseGrantDto } from './dto/close-grant.dto';
import { DenyAccessRequestDto } from './dto/deny-access-request.dto';
import { ListStaffAccessRequestsDto } from './dto/list-staff-access-requests.dto';
import { CreateAccessRequestDto } from './dto/create-access-request.dto';
import { CreateBreakGlassDto } from './dto/create-break-glass.dto';
import { VerifyPatientAccessPinDto } from './dto/verify-patient-access-pin.dto';
import { RevokeConsentGrantDto } from './dto/revoke-consent-grant.dto';
import { OpenOwnFacilityDto } from './dto/open-own-facility.dto';
import { DomainProblem } from '../common/problem';

@Controller('identity')
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  @Get('me/access-requests')
  @PatientOnly()
  @AuditAction('identity.access-request.list.request')
  listMyAccessRequests(@Req() request: HidRequest) {
    return this.consent.listMyAccessRequests(patientConsentContext(request));
  }

  @Get('access-requests')
  @RequirePermissions('identity.consent.write')
  @AuditAction('identity.access-request.list.request')
  listMyStaffAccessRequests(@Req() request: HidRequest, @Query() query: ListStaffAccessRequestsDto) {
    return this.consent.listMyStaffAccessRequests(
      consentContext(request, ['direct-care', 'healthcare-operations']),
      query,
    );
  }

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
  @PatientOnly()
  @AuditAction('identity.access-request.approve.command')
  approveAccessRequest(
    @Req() request: HidRequest,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
  ) {
    return this.consent.approveAccessRequest(patientConsentContext(request), requestId);
  }

  @Post('access-requests/:requestId/deny')
  @HttpCode(200)
  @PatientOnly()
  @AuditAction('identity.access-request.deny.command')
  denyAccessRequest(
    @Req() request: HidRequest,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body() input: DenyAccessRequestDto,
  ) {
    return this.consent.denyAccessRequest(patientConsentContext(request), requestId, input.reason);
  }

  /**
   * The patient revokes a grant they gave (main 0066 item 2, migration 0087):
   * a patient-approved or PIN-derived grant; break-glass and workforce grants
   * answer 409. The database command binds it to the live patient session.
   * As in main, no recent sign-in and no recovery hold: revoking only removes
   * access. No purpose-of-use, facility or idempotency header; a repeat
   * answers 200 with replayed: true.
   */
  @Post('me/consent-grants/:grantId/revoke')
  @HttpCode(200)
  @PatientOnly()
  @AuditAction('identity.consent-grant.patient-revoke.command')
  revokeMyConsentGrant(
    @Req() request: HidRequest,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body() input: RevokeConsentGrantDto,
  ) {
    return this.consent.revokeMyConsentGrant(request, grantId, input.reason);
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

  /**
   * 0131 (ID-4, owner Q101 of 18 November 2026): a doctor, nurse or
   * clinician opens a patient of this facility (registered at its desk, or a
   * consented visit here in the last 24 months) for 24 hours without a PIN.
   * The answer's authorization.basis is 'own-facility'. A Health ID that
   * does not exist answers 404 "No such patient" (owner Q100 B).
   */
  @Post('own-facility-access')
  @HttpCode(200)
  @RequirePermissions('identity.patient.open-own-facility')
  @AuditAction('identity.patient.open-own-facility.command')
  openOwnFacilityPatient(@Req() request: HidRequest, @Body() input: OpenOwnFacilityDto) {
    if ((input.hid === undefined) === (input.patientId === undefined)) {
      throw new DomainProblem(400, 'PATIENT_IDENTIFIER_REQUIRED', 'Give the patient\'s Health ID or the patient id, not both.');
    }
    return this.consent.openOwnFacilityPatient(consentContext(request, ['direct-care']), input);
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
