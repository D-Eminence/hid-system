import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { consentContext } from './consent-context';
import { ConsentService } from './consent.service';
import { CloseGrantDto } from './dto/close-grant.dto';
import { CreateAccessRequestDto } from './dto/create-access-request.dto';
import { CreateBreakGlassDto } from './dto/create-break-glass.dto';

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

  @Post('break-glass')
  @HttpCode(201)
  @RequirePermissions('identity.consent.write', 'identity.break-glass.write')
  @AuditAction('identity.break-glass.command')
  activateBreakGlass(@Req() request: HidRequest, @Body() input: CreateBreakGlassDto) {
    return this.consent.activateBreakGlass(consentContext(request, ['emergency']), input);
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
