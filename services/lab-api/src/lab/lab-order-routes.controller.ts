import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { AcceptOrderRouteDto, DeclineOrderRouteDto, ListOrderRoutesQueryDto } from './dto/order-route.dto';
import { LabOrderRoutesService } from './lab-order-routes.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * Lab requests other facilities send to this laboratory (P4c, SPEC-FINAL
 * §10.2). Browser routes for members holding lab.order-route.receive (only
 * the `lab` role), facility required; never an internal caller.
 */
@Controller('lab/order-routes')
export class LabOrderRoutesController {
  constructor(private readonly routes: LabOrderRoutesService) {}

  @Get()
  @RequirePermissions('lab.order-route.receive') @AuditAction('lab.order-route.list.request')
  list(@Query() query: ListOrderRoutesQueryDto, @Req() request: HidRequest) {
    return this.routes.list(requireRequestContext(request), query);
  }

  @Get(':routeId')
  @RequirePermissions('lab.order-route.receive') @AuditAction('lab.order-route.read.request')
  get(@Param('routeId', uuid()) routeId: string, @Req() request: HidRequest) {
    return this.routes.get(requireRequestContext(request), routeId);
  }

  @Post(':routeId/accept') @HttpCode(201)
  @RequirePermissions('lab.order-route.receive') @AuditAction('lab.order-route.accept.request')
  accept(@Param('routeId', uuid()) routeId: string, @Body() input: AcceptOrderRouteDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.routes.accept(requireRequestContext(request), routeId, input, idempotencyKey);
  }

  @Post(':routeId/decline') @HttpCode(200)
  @RequirePermissions('lab.order-route.receive') @AuditAction('lab.order-route.decline.request')
  decline(@Param('routeId', uuid()) routeId: string, @Body() input: DeclineOrderRouteDto, @Req() request: HidRequest) {
    return this.routes.decline(requireRequestContext(request), routeId, input);
  }
}
