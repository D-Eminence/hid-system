import { Controller, Get, Query, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { AuditService } from './audit.service';
import { ListAuditEventsDto } from './dto/list-audit-events.dto';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('events')
  @RequirePermissions('audit.read')
  @AuditAction('audit.events.list.request')
  list(@Req() request: HidRequest, @Query() query: ListAuditEventsDto) {
    const purpose = request.header('x-purpose-of-use');
    if (purpose !== 'healthcare-operations') {
      throw new DomainProblem(
        400,
        'PURPOSE_OF_USE_REQUIRED',
        'X-Purpose-Of-Use must be healthcare-operations for audit access',
      );
    }
    return this.audit.listFacilityEvents(requireRequestContext(request, purpose), query);
  }
}
