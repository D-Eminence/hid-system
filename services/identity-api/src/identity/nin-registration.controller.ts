import { Body, Controller, Get, Header, Headers, Optional, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { ApproveRegistrationCaseDto } from './dto/approve-registration-case.dto';
import { LinkRegistrationCaseDto } from './dto/link-registration-case.dto';
import { ResolveNinDto } from './dto/resolve-nin.dto';
import { EnrollPatientDto } from './dto/enroll-patient.dto';
import { ListRegistrationCasesDto } from './dto/list-registration-cases.dto';
import { NinRegistrationService } from './nin-registration.service';
import { getEnvironment } from '../config/environment';
import { NinProviderBreaker } from './nin-provider-breaker';

@Controller('identity')
export class NinRegistrationController {
  constructor(
    private readonly registrations: NinRegistrationService,
    @Optional() private readonly ninBreaker: NinProviderBreaker = new NinProviderBreaker(),
  ) {}

  @Get('registration-capabilities')
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.registration-capabilities.read')
  capabilities() {
    const mode = getEnvironment().NIN_PROVIDER_MODE;
    const enabled = mode === 'test';
    return {
      // ID-0: `available` is false while the NIN service breaker is tripped
      // (or NIN checks are off), so the desk knows before it asks.
      nin: { enabled, state: enabled ? 'test-only' : mode, available: enabled && this.ninBreaker.available() },
      // ID-0: registration without a NIN stays off until ID-2 ships.
      withoutNin: { enabled: false },
      newPatientRegistrationRequiresNin: true,
    };
  }

  @Post('nin/resolve')
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.nin.resolve.request')
  resolve(
    @Body() input: ResolveNinDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const context = requireRequestContext(request, input.purpose);
    return this.registrations.resolve(input, idempotencyKey, context);
  }

  /**
   * SX-10: the desk's own cases (view=mine, the default) or, for approvers,
   * every case at this facility (view=facility). No NIN digits; audited.
   */
  @Get('registration-cases')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.registration-case.list.request')
  listCases(@Query() query: ListRegistrationCasesDto, @Req() request: HidRequest) {
    return this.registrations.listCases(query, requireRequestContext(request));
  }

  @Get('registration-cases/:caseId')
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.registration-case.read.request')
  getCase(@Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string, @Req() request: HidRequest) {
    const context = requireRequestContext(request);
    return this.registrations.getCase(caseId, context);
  }

  @Post('registration-cases/:caseId/approve-new')
  @RequirePermissions('identity.registration.approve')
  @AuditAction('identity.registration-case.approve-new.request')
  approveNew(
    @Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string,
    @Body() input: ApproveRegistrationCaseDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const context = requireRequestContext(request, input.purpose);
    return this.registrations.approveNew(caseId, input, idempotencyKey, context);
  }

  @Post('registration-cases/:caseId/enroll')
  @RequirePermissions('identity.registration.approve')
  @AuditAction('identity.patient.enroll.request')
  enroll(
    @Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string,
    @Body() input: EnrollPatientDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest,
  ) {
    requireIdempotencyKey(idempotencyKey);
    return this.registrations.enroll(caseId, input, idempotencyKey, requireRequestContext(request, input.purpose));
  }

  @Post('registration-cases/:caseId/link-existing')
  @RequirePermissions('identity.registration.approve')
  @AuditAction('identity.registration-case.link-existing.request')
  linkExisting(
    @Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string,
    @Body() input: LinkRegistrationCaseDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const context = requireRequestContext(request, input.purpose);
    return this.registrations.linkExisting(caseId, input, idempotencyKey, context);
  }
}
