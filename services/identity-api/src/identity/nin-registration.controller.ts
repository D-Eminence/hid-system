import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
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
import { RegisterWithoutNinDto, NO_NIN_REASONS } from './dto/register-without-nin.dto';
import { RegistrationWithoutNinService } from './registration-without-nin.service';
import { DomainProblem } from '../common/problem';
import { NIN_VERIFICATION_PROVIDER, type NinVerificationProvider } from './nin.types';
import { LinkPatientNinDto } from './dto/link-patient-nin.dto';
import { PatientNinLinkService } from './patient-nin-link.service';

@Controller('identity')
export class NinRegistrationController {
  constructor(
    private readonly registrations: NinRegistrationService,
    @Optional() private readonly ninBreaker: NinProviderBreaker = new NinProviderBreaker(),
    @Optional() private readonly withoutNin?: RegistrationWithoutNinService,
    @Optional() @Inject(NIN_VERIFICATION_PROVIDER) private readonly provider?: NinVerificationProvider,
    @Optional() private readonly ninLink?: PatientNinLinkService,
  ) {}

  @Get('registration-capabilities')
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.registration-capabilities.read')
  async capabilities(@Req() request: HidRequest) {
    return {
      // ID-0: `available` is false while the NIN service breaker is tripped
      // (or NIN checks are off), so the desk knows before it asks.
      nin: await this.ninCapability(request),
      // ID-2 (0130, owner Q106): the desk may register a patient without a
      // NIN; a phone (and address) is required except for a child.
      withoutNin: { enabled: true, phoneRequiredUnlessChild: true, reasons: [...NO_NIN_REASONS] },
      newPatientRegistrationRequiresNin: false,
    };
  }

  private async ninCapability(request: HidRequest): Promise<{ enabled: boolean; state: string; available: boolean }> {
    if (this.provider?.name === 'qoreid' && this.provider.isEnabled) {
      // Q108: NIN checks through QoreID, on while QoreID's switch is on (read
      // now, never cached). A switch that cannot be read is "try again".
      // 0098 G6, 0123 G6q: off at a desk of the sealed demo or QA tenant, as
      // resolve answers there; a seal that cannot be read is "try again".
      let enabled: boolean;
      try {
        enabled = await this.provider.isEnabled()
          && !(await this.registrations.sealedTenant(request.facilityId, request.actor?.accountId));
      } catch {
        return { enabled: true, state: 'live', available: false };
      }
      return enabled ? { enabled, state: 'live', available: this.ninBreaker.available() }
        : { enabled, state: 'unavailable', available: false };
    }
    const mode = getEnvironment().NIN_PROVIDER_MODE;
    const enabled = mode === 'test';
    return { enabled, state: enabled ? 'test-only' : mode, available: enabled && this.ninBreaker.available() };
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
   * ID-2 (0130, owner Q106 of 18 November 2026): register a patient without a
   * NIN. With no possible duplicate the same desk person's request creates
   * the patient at once; otherwise the case waits for an approver. The answer
   * says which, and never who might be the same person.
   */
  @Post('registration-cases/without-nin')
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.registration.without-nin.request')
  registerWithoutNin(
    @Body() input: RegisterWithoutNinDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const context = requireRequestContext(request, input.purpose);
    return this.requireWithoutNin().register(input, idempotencyKey, context);
  }

  /**
   * ID-2 (0130): an approver rejects a registration without a NIN that was
   * sent for review (not the same person who started it). A NIN case
   * answers 409.
   */
  @Post('registration-cases/:caseId/reject')
  @RequirePermissions('identity.registration.approve')
  @AuditAction('identity.registration-case.reject.request')
  async reject(
    @Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string,
    @Body() input: ApproveRegistrationCaseDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const context = requireRequestContext(request, input.purpose);
    return this.requireWithoutNin().review(caseId, 'reject', input, idempotencyKey, context);
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
  async approveNew(
    @Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string,
    @Body() input: ApproveRegistrationCaseDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const context = requireRequestContext(request, input.purpose);
    // ID-2 (0130): a registration without a NIN is decided by its own command.
    if (this.withoutNin && await this.withoutNin.evidenceOf(caseId, context) === 'none') {
      return this.withoutNin.review(caseId, 'create_new', input, idempotencyKey, context);
    }
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
  async linkExisting(
    @Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string,
    @Body() input: LinkRegistrationCaseDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const context = requireRequestContext(request, input.purpose);
    // ID-2 (0130): linking a registration without a NIN is always an approver's decision.
    if (this.withoutNin && await this.withoutNin.evidenceOf(caseId, context) === 'none') {
      return this.withoutNin.review(caseId, 'link_existing', input, idempotencyKey, context);
    }
    return this.registrations.linkExisting(caseId, input, idempotencyKey, context);
  }

  /**
   * ID-6 (0138, Akos P0-1): verify a NIN later and link it, for this
   * facility's own patient (0131's basis; a consent grant does not allow it).
   * The patient by UUID; the NIN only in the body. 200 with nin_linked or
   * already_linked; the refusals are the planned contract's (ID-6).
   */
  @Post('patients/:patientId/nin')
  @HttpCode(200)
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.patient.nin-link.request')
  linkNin(
    @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Body() input: LinkPatientNinDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const context = requireRequestContext(request, input.purpose);
    if (!this.ninLink) {
      throw new DomainProblem(503, 'NIN_LINK_UNAVAILABLE', 'Adding a NIN is not available right now.');
    }
    return this.ninLink.link(patientId, input, idempotencyKey, context);
  }

  private requireWithoutNin(): RegistrationWithoutNinService {
    if (!this.withoutNin) {
      throw new DomainProblem(503, 'REGISTRATION_WITHOUT_NIN_UNAVAILABLE', 'Registration without a NIN is not available right now.');
    }
    return this.withoutNin;
  }
}
