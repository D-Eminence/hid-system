import { Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import { requireAdminContext } from '../admin/admin-context';
import { AuditAction, AuditFailuresOnly, PlatformScope, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { IntegrationAdminService } from './integration-admin.service';
import { IntegrationConfigurationDto, IntegrationCredentialReferenceDto,
  IntegrationReasonDto, IntegrationRouteDto } from './integration-command.dto';

function version(value: string | undefined): number {
  const normalized = value?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const parsed = normalized ? Number(normalized) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'If-Match must contain the expected positive version');
  }
  return parsed;
}

@Controller('admin/integrations')
@PlatformScope()
@AuditFailuresOnly()
export class IntegrationAdminController {
  constructor(private readonly integrations: IntegrationAdminService) {}

  @Get()
  @RequirePermissions('platform.integration.read')
  @AuditAction('admin.integration.list')
  list(@Req() request: HidRequest) { return this.integrations.list(requireAdminContext(request)); }

  @Get(':provider/audit')
  @RequirePermissions('platform.integration.read')
  @AuditAction('admin.integration.audit')
  audit(@Param('provider') provider: string, @Req() request: HidRequest) {
    return this.integrations.auditHistory(requireAdminContext(request), provider);
  }

  @Get(':provider')
  @RequirePermissions('platform.integration.read')
  @AuditAction('admin.integration.read')
  get(@Param('provider') provider: string, @Req() request: HidRequest) {
    return this.integrations.get(requireAdminContext(request), provider);
  }

  @Post(':provider/enable')
  @RequirePermissions('platform.integration.manage')
  @AuditAction('admin.integration.enable')
  enable(@Param('provider') provider: string, @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() body: IntegrationReasonDto,
    @Req() request: HidRequest) {
    return this.integrations.changeProvider(requireAdminContext(request), provider, version(ifMatch),
      'enable', body.reason, undefined, requireIdempotencyKey(key));
  }

  @Post(':provider/pause')
  @RequirePermissions('platform.integration.manage')
  @AuditAction('admin.integration.pause')
  pause(@Param('provider') provider: string, @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() body: IntegrationReasonDto,
    @Req() request: HidRequest) {
    return this.integrations.changeProvider(requireAdminContext(request), provider, version(ifMatch),
      'pause', body.reason, undefined, requireIdempotencyKey(key));
  }

  @Post(':provider/configuration')
  @RequirePermissions('platform.integration.manage')
  @AuditAction('admin.integration.configure')
  configure(@Param('provider') provider: string, @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() body: IntegrationConfigurationDto,
    @Req() request: HidRequest) {
    return this.integrations.changeProvider(requireAdminContext(request), provider, version(ifMatch),
      'configure', body.reason, body.configuration, requireIdempotencyKey(key));
  }

  @Post(':provider/credential-reference')
  @RequirePermissions('platform.integration.manage')
  @AuditAction('admin.integration.credential-reference')
  credentialReference(@Param('provider') _provider: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() _body: IntegrationCredentialReferenceDto) {
    version(ifMatch);
    requireIdempotencyKey(key);
    throw new DomainProblem(409, 'INTEGRATION_CREDENTIAL_ROTATION_EXTERNAL',
      'Credential rotation requires the infrastructure secret deployment process');
  }

  @Post('capabilities/:capability/selection')
  @RequirePermissions('platform.integration.manage')
  @AuditAction('admin.integration.selection')
  selection(@Param('capability') capability: string, @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() body: IntegrationRouteDto,
    @Req() request: HidRequest) {
    return this.integrations.changeRoute(requireAdminContext(request), capability, version(ifMatch),
      'select', body.provider, body.reason, requireIdempotencyKey(key));
  }

  @Post('capabilities/:capability/fallback')
  @RequirePermissions('platform.integration.manage')
  @AuditAction('admin.integration.fallback')
  fallback(@Param('capability') capability: string, @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() body: IntegrationRouteDto,
    @Req() request: HidRequest) {
    return this.integrations.changeRoute(requireAdminContext(request), capability, version(ifMatch),
      'fallback', body.provider, body.reason, requireIdempotencyKey(key));
  }

  @Post(':provider/test')
  @RequirePermissions('platform.integration.test')
  @AuditAction('admin.integration.test')
  test(@Param('provider') provider: string, @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() body: IntegrationReasonDto,
    @Req() request: HidRequest) {
    return this.integrations.test(requireAdminContext(request), provider, version(ifMatch),
      body.reason, requireIdempotencyKey(key));
  }
}
