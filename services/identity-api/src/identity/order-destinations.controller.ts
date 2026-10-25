import { Controller, Get, Query, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { type HidRequest, requireRequestContext } from '../common/request-context';
import { OrderDestinationsService } from './order-destinations.service';

/**
 * GET identity/order-destinations?kind=laboratory|pharmacy&query=… (P4c,
 * SPEC-FINAL §3.4, §10.3): a staff session at the X-Facility-ID facility
 * holding ehr.order-route.send. The search is part of sending an order, so
 * it runs under direct care (§8.7 conventions), whatever the header says.
 * The interceptor's row carries the route, never the query string.
 */
@Controller('identity')
export class OrderDestinationsController {
  constructor(private readonly destinations: OrderDestinationsService) {}

  @Get('order-destinations')
  @RequirePermissions('ehr.order-route.send')
  @AuditAction('identity.order-destinations.search')
  search(@Query('kind') kind: unknown, @Query('query') query: unknown, @Req() request: HidRequest) {
    const input = OrderDestinationsService.validate(kind, query);
    return this.destinations.search(requireRequestContext(request, 'direct-care'), input.kind, input.query);
  }
}
