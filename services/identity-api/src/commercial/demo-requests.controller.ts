import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { TurnstileService } from '../auth/turnstile.service';
import { requireAdminContext } from '../admin/admin-context';
import { AuditAction, AuditFailuresOnly, Public, PlatformScope, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { CreateDemoRequestDto, ListDemoRequestsDto, UpdateDemoRequestStatusDto } from './demo-request.dto';
import { DemoRequestsService } from './demo-requests.service';

@Controller('commercial/demo-requests')
@AuditFailuresOnly()
export class PublicDemoRequestsController {
  private readonly allowedOrigins = new Set(getEnvironment().CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(private readonly demo: DemoRequestsService, private readonly turnstile: TurnstileService) {}

  @Post()
  @Public()
  @HttpCode(202)
  @AuditAction('commercial.demo-request.submit')
  async submit(@Body() input: CreateDemoRequestDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest) {
    const origin = request.header('origin');
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
    const idempotencyKey = requireIdempotencyKey(key);
    await this.turnstile.verify({ token: input.turnstileToken, action: input.turnstileAction,
      origin, remoteIp: request.ip });
    return this.demo.submit(input, idempotencyKey, request);
  }
}

@Controller('admin/demo-requests')
@PlatformScope()
@AuditFailuresOnly()
export class AdminDemoRequestsController {
  constructor(private readonly demo: DemoRequestsService) {}

  @Get()
  @RequirePermissions('platform.demo.read')
  @AuditAction('admin.demo-requests.list')
  list(@Query() filters: ListDemoRequestsDto, @Req() request: HidRequest) {
    return this.demo.list(requireAdminContext(request), filters);
  }

  @Post(':requestId/status')
  @HttpCode(200)
  @RequirePermissions('platform.demo.manage')
  @AuditAction('admin.demo-request.status')
  transition(@Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() input: UpdateDemoRequestStatusDto, @Req() request: HidRequest) {
    const normalized = ifMatch?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    const expectedVersion = normalized ? Number(normalized) : Number.NaN;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'If-Match must contain the expected positive version');
    }
    return this.demo.transition(requireAdminContext(request), requestId, expectedVersion, input);
  }
}
