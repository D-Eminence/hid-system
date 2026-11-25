import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { consentContext } from './consent-context';
import { WardStayAccessDto } from './dto/ward-stay-access.dto';
import { WardStayAccessService } from './ward-stay-access.service';

/**
 * ADT-1 route 23 (0173; owner decision Q156 A, 25 November 2026): "Open chart
 * for this stay" for the ward team of an admitted patient. Built and switched
 * off until Rahman and the DPO agree: it answers 503
 * WARD_STAY_ACCESS_NOT_AVAILABLE and the screen offers the usual own-facility
 * opening (0131). The admission by UUID in the body; never a Health ID.
 */
@Controller('identity')
export class WardStayAccessController {
  constructor(private readonly wardStay: WardStayAccessService) {}

  @Post('ward-stay-access')
  @HttpCode(200)
  @RequirePermissions('ehr.ward.read')
  @AuditAction('identity.ward-stay.open.command')
  openWardStay(@Req() request: HidRequest, @Body() input: WardStayAccessDto) {
    return this.wardStay.open(consentContext(request, ['direct-care']), input.admissionId);
  }
}
