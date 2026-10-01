import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { requireAdminContext } from '../admin/admin-context';
import { TurnstileService } from '../auth/turnstile.service';
import { AuditAction, AuditFailuresOnly, FacilityOptional, Public, RequirePermissions } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { ApproveOrganizationApplicationDto, CompleteOrganizationProfileDto,
  ListOrganizationApplicationsDto, ReviewOrganizationApplicationDto,
  StartOrganizationProfileCompletionDto, SubmitOrganizationApplicationDto,
  VerifyOrganizationProfileCompletionDto } from './dto/organization-application.dto';
import { OrganizationApplicationsService } from './organization-applications.service';
import { OrganizationProfileCompletionService } from './organization-profile-completion.service';

function expectedVersion(value: string | undefined): number {
  const normalized = value?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const version = normalized ? Number(normalized) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'If-Match must contain the expected positive version');
  }
  return version;
}

@Controller('identity/organization-applications')
@AuditFailuresOnly()
export class PublicOrganizationApplicationsController {
  private readonly allowedOrigins = new Set(getEnvironment().CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(private readonly applications: OrganizationApplicationsService,
    private readonly turnstile: TurnstileService) {}

  @Post()
  @Public()
  @HttpCode(202)
  @AuditAction('identity.organization-application.submit')
  async submit(@Body() input: SubmitOrganizationApplicationDto, @Req() request: HidRequest) {
    const origin = request.header('origin');
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
    await this.turnstile.verify({ token: input.turnstileToken, action: input.turnstileAction,
      origin, remoteIp: request.ip });
    return this.applications.submit(input, request);
  }
}

const COMPLETION_COOKIE = 'hid_org_completion';

@Controller('identity/organization-applications/completion')
@Public()
@AuditFailuresOnly()
export class PublicOrganizationProfileCompletionController {
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(
    this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(private readonly completion: OrganizationProfileCompletionService,
    private readonly turnstile: TurnstileService) {}

  @Post('start')
  @HttpCode(200)
  @AuditAction('identity.organization-application.completion-start')
  async start(@Body() input: StartOrganizationProfileCompletionDto, @Req() request: HidRequest) {
    this.assertOrigin(request);
    await this.turnstile.verify({ token: input.turnstileToken, action: input.turnstileAction,
      origin: request.header('origin'), remoteIp: request.ip });
    return this.completion.start(input, request.ip, request.correlationId);
  }

  @Post('verify')
  @HttpCode(200)
  @AuditAction('identity.organization-application.completion-verify')
  async verify(@Body() input: VerifyOrganizationProfileCompletionDto,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    const result = await this.completion.verify(input.challengeId, input.code, request.correlationId);
    response.cookie(COMPLETION_COOKIE, result.cookie, this.cookieOptions());
    return { verified: true };
  }

  @Get('profile')
  @AuditAction('identity.organization-application.completion-profile')
  profile(@Req() request: HidRequest) {
    return this.completion.current(this.cookie(request), request.correlationId);
  }

  @Patch('profile')
  @AuditAction('identity.organization-application.completion-save')
  save(@Body() input: CompleteOrganizationProfileDto,
    @Headers('if-match') ifMatch: string | undefined, @Req() request: HidRequest) {
    this.assertOrigin(request);
    return this.completion.complete(this.cookie(request), expectedVersion(ifMatch),
      input, request.correlationId);
  }

  private assertOrigin(request: HidRequest): void {
    const origin = request.header('origin');
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
  }

  private cookie(request: HidRequest): string | undefined {
    const values = (request.header('cookie') ?? '').split(';').map((part) => part.trim())
      .filter((part) => part.startsWith(`${COMPLETION_COOKIE}=`));
    return values.length === 1 ? values[0]?.slice(COMPLETION_COOKIE.length + 1) : undefined;
  }

  private cookieOptions() {
    return { httpOnly: true, sameSite: 'strict' as const,
      secure: this.environment.AUTH_COOKIE_SECURE,
      path: '/api/v1/identity/organization-applications/completion',
      maxAge: 60 * 60 * 1000 };
  }
}

@Controller('admin/organization-applications')
@FacilityOptional()
@AuditFailuresOnly()
export class AdminOrganizationApplicationsController {
  constructor(private readonly applications: OrganizationApplicationsService) {}

  @Get()
  @RequirePermissions('platform.identity-review.read')
  @AuditAction('admin.organization-applications.list')
  list(@Query() filters: ListOrganizationApplicationsDto, @Req() request: HidRequest) {
    return this.applications.list(requireAdminContext(request), filters.status);
  }

  @Post(':applicationId/verify-cac')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.organization-application.verify-cac')
  verify(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined, @Req() request: HidRequest) {
    return this.applications.verify(requireAdminContext(request), applicationId, expectedVersion(ifMatch));
  }

  @Post(':applicationId/approve')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage', 'platform.principal.manage', 'platform.role.manage')
  @AuditAction('admin.organization-application.approve')
  approve(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() input: ApproveOrganizationApplicationDto, @Req() request: HidRequest) {
    return this.applications.approve(requireAdminContext(request), applicationId, expectedVersion(ifMatch), input);
  }

  @Post(':applicationId/reject')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.organization-application.reject')
  reject(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() input: ReviewOrganizationApplicationDto, @Req() request: HidRequest) {
    return this.applications.reject(requireAdminContext(request), applicationId, expectedVersion(ifMatch), input.reason);
  }
}
