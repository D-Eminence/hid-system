import { Body, Controller, Post, Req } from '@nestjs/common';
import { AuditAction, Public, RequirePermissions } from '../common/decorators';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { AuthorizationCheckDto } from './dto/authorization-check.dto';
import { AuthorizeOutreachDto } from './dto/authorize-outreach.dto';
import { ConsentStatusDto } from './dto/consent-status.dto';
import { PatientLookupDto } from './dto/patient-lookup.dto';
import { IdentityService } from './identity.service';
import { WorkloadAuthService } from '../auth/workload-auth.service';
import { DomainProblem } from '../common/problem';

@Controller('identity')
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly workloadAuth: WorkloadAuthService,
  ) {}

  @Post('patient-lookup')
  @RequirePermissions('identity.patient.read')
  @AuditAction('identity.patient.lookup.request')
  lookup(@Body() input: PatientLookupDto, @Req() request: HidRequest) {
    const context = requireRequestContext(request, input.purpose);
    return this.identity.lookupPatient(input.hid, input.purpose, context);
  }

  @Post('authorization/check')
  @RequirePermissions('identity.authorization.check')
  @AuditAction('identity.authorization.check.request')
  authorize(@Body() input: AuthorizationCheckDto, @Req() request: HidRequest) {
    const context = requireRequestContext(request, input.purpose);
    return this.identity.authorize(input.patientId, input.scope, input.purpose, context);
  }

  @Post('service/authorization/check')
  @RequirePermissions('identity.authorization.check')
  @AuditAction('identity.service.authorization.check.request')
  async authorizeService(@Body() input: AuthorizationCheckDto, @Req() request: HidRequest) {
    await this.workloadAuth.authenticateService(
      request.header('x-hid-internal-caller'),
      request.header('x-hid-service-authorization'),
      request.header('x-hid-service-token'),
    );
    const context = requireRequestContext(request, input.purpose);
    return this.identity.authorize(input.patientId, input.scope, input.purpose, context);
  }

  @Post('service/workloads/document-scanner/authorize')
  @Public()
  @AuditAction('identity.service.document-scanner.authorization.request')
  async authorizeDocumentScanner(@Req() request: HidRequest) {
    if (request.header('x-hid-internal-caller') !== 'ehr-api') {
      throw new DomainProblem(401, 'WORKLOAD_AUTHENTICATION_REQUIRED',
        'The EHR workload identity is required for document scanner authorization');
    }
    await this.workloadAuth.authenticateService(
      request.header('x-hid-internal-caller'),
      request.header('x-hid-service-authorization'),
      request.header('x-hid-service-token'),
    );
    return this.workloadAuth.authenticateScanner(request.header('x-hid-scanner-authorization'));
  }

  @Post('outreach/authorize')
  @AuditAction('identity.outreach.authorization.request')
  async authorizeOutreach(@Body() input: AuthorizeOutreachDto, @Req() request: HidRequest) {
    await this.workloadAuth.authenticateOutreach(
      request.header('x-hid-internal-caller'),
      request.header('x-hid-service-authorization'),
      request.header('x-hid-service-token'),
    );
    const context = requireRequestContext(request, 'direct-care');
    if (!context.actor.permissions.includes(input.permission)) {
      throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required Outreach permission is missing');
    }
    return { authorized: true, actor: context.actor };
  }

  @Post('outreach/patient-authorization')
  @RequirePermissions('identity.authorization.check')
  @AuditAction('identity.outreach.patient-authorization.request')
  async authorizeOutreachPatient(@Body() input: AuthorizationCheckDto, @Req() request: HidRequest) {
    await this.workloadAuth.authenticateOutreach(
      request.header('x-hid-internal-caller'),
      request.header('x-hid-service-authorization'),
      request.header('x-hid-service-token'),
    );
    const context = requireRequestContext(request, input.purpose);
    return this.identity.authorize(input.patientId, input.scope, input.purpose, context);
  }

  @Post('consent-status')
  @RequirePermissions('identity.consent.read')
  @AuditAction('identity.consent.status.request')
  consentStatus(@Body() input: ConsentStatusDto, @Req() request: HidRequest) {
    const context = requireRequestContext(request, input.purpose);
    return this.identity.consentStatus(input.patientId, input.purpose, context);
  }
}
