import { Controller, Get, Query, Req, UseInterceptors } from '@nestjs/common';
import { AuditAction } from '../common/decorators';
import { type HidRequest, requireRequestContext } from '../common/request-context';
import { AuditPurposeInterceptor } from './audit-purpose.interceptor';
import { FacilityStaffNamesQueryDto } from './facility-staff-names.dto';
import { FacilityStaffNamesService } from './facility-staff-names.service';

/**
 * GET /api/v1/identity/facility-staff-names (SX-9): for any staff member
 * active at the X-Facility-ID facility (the header is required; a facility
 * the caller is not active at is refused 403 FACILITY_ACCESS_DENIED by the
 * guard). No permission beyond membership: names only, of the caller's own
 * colleagues. Success and failure are audited
 * (api.identity.facility-staff-names.read) with purpose
 * healthcare-operations, the purpose it always reads under, not the
 * browser's X-Purpose-Of-Use.
 */
@Controller('identity')
export class FacilityStaffNamesController {
  constructor(private readonly names: FacilityStaffNamesService) {}

  @Get('facility-staff-names')
  @AuditAction('identity.facility-staff-names.read')
  @UseInterceptors(new AuditPurposeInterceptor('healthcare-operations'))
  list(@Query() query: FacilityStaffNamesQueryDto, @Req() request: HidRequest) {
    return this.names.list(requireRequestContext(request, 'healthcare-operations'), query.membershipIds?.split(','));
  }
}
