import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { type HidRequest, requireRequestContext } from '../common/request-context';
import { SetOnePersonLabDto } from './dto/facility-settings.dto';
import { FacilitySettingsService } from './facility-settings.service';

/**
 * A facility's own settings (owner decision 33.3): the Admin Settings page
 * reads them and the facility administrator switches One-person lab. Each
 * route needs a staff session at the X-Facility-ID facility with
 * organization.manage (the admin and org_admin roles; not an administrator
 * awaiting support's review, not lab staff); the interceptor audits success
 * and failure at that facility, and the database audits each switch.
 */
@Controller('identity')
export class FacilitySettingsController {
  constructor(private readonly settings: FacilitySettingsService) {}

  /** 200 { onePersonLab: { enabled, changedAt, changedByName, reason } }. */
  @Get('facility-settings')
  @RequirePermissions('organization.manage')
  @AuditAction('identity.facility-settings.read')
  read(@Req() request: HidRequest) {
    return this.settings.read(requireRequestContext(request, 'healthcare-operations'));
  }

  /** 200 { enabled, changedAt, settingId }. */
  @Post('facility-settings/one-person-lab')
  @HttpCode(200)
  @RequirePermissions('organization.manage')
  @AuditAction('identity.facility.one-person-lab.change')
  setOnePersonLab(@Body() input: SetOnePersonLabDto, @Req() request: HidRequest) {
    return this.settings.setOnePersonLab(requireRequestContext(request, 'healthcare-operations'), input.enabled,
      input.reason);
  }
}
