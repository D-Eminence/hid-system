import { Body, Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { consentContext } from '../consent/consent-context';
import { EmergencyPatientSearchDto, PatientSearchDto } from './patient-search.dto';
import { PatientSearchService } from './patient-search.service';

/**
 * Staff patient search (0132, ID-3a and ID-3b; owner decisions of 18
 * November 2026). Keys go in the body, never in the URL; answers carry
 * matchRefs, never a Health ID or a patient id.
 */
@Controller('identity')
export class PatientSearchController {
  constructor(private readonly searches: PatientSearchService) {}

  /**
   * POST /api/v1/identity/patient-search, X-Purpose-Of-Use: direct-care.
   * Front desk, approvers and clinicians (identity.registration.write).
   */
  @Post('patient-search')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.patient.search.request')
  search(@Body() input: PatientSearchDto, @Req() request: HidRequest) {
    return this.searches.search(consentContext(request, ['direct-care']), input);
  }

  /**
   * POST /api/v1/identity/patient-search/emergency, X-Purpose-Of-Use:
   * emergency. Staff who may use emergency access
   * (identity.break-glass.write), with the platform's emergency access on
   * and a typed reason. The cards give no access: break-glass still needs
   * its own reason.
   */
  @Post('patient-search/emergency')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('identity.break-glass.write')
  @AuditAction('identity.patient.emergency-search.request')
  emergencySearch(@Body() input: EmergencyPatientSearchDto, @Req() request: HidRequest) {
    return this.searches.emergencySearch(consentContext(request, ['emergency']), input);
  }
}
