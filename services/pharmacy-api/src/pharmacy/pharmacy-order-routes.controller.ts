import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { AcceptOrderRouteDto, DeclineOrderRouteDto, ListOrderRoutesQueryDto, SearchOrderRoutesDto } from './dto/order-route.dto';
import { PharmacyOrderRoutesService } from './pharmacy-order-routes.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * Prescriptions other facilities send to this pharmacy (P4c, SPEC-FINAL
 * §10.2). Browser routes for members holding pharmacy.order-route.receive
 * (only the `pharmacist` role), facility required; never an internal caller.
 */
@Controller('pharmacy/order-routes')
export class PharmacyOrderRoutesController {
  constructor(private readonly routes: PharmacyOrderRoutesService) {}

  /** Incoming or Recent. A healthId in the URL is refused 400 before this route runs (health-id-in-url.ts). */
  @Get()
  @RequirePermissions('pharmacy.order-route.receive')
  list(@Query() query: ListOrderRoutesQueryDto, @Req() request: HidRequest) {
    return this.routes.list(requireRequestContext(request), query);
  }

  /**
   * Find by the patient's Health ID, sent in the body so it is in no request
   * line a gateway, edge log or browser history keeps (CODEX §26).
   */
  @Post('search') @HttpCode(200)
  @RequirePermissions('pharmacy.order-route.receive')
  search(@Body() input: SearchOrderRoutesDto, @Req() request: HidRequest) {
    return this.routes.search(requireRequestContext(request), input);
  }

  @Get(':routeId')
  @RequirePermissions('pharmacy.order-route.receive')
  get(@Param('routeId', uuid()) routeId: string, @Req() request: HidRequest) {
    return this.routes.get(requireRequestContext(request), routeId);
  }

  @Post(':routeId/accept') @HttpCode(201)
  @RequirePermissions('pharmacy.order-route.receive')
  accept(@Param('routeId', uuid()) routeId: string, @Body() input: AcceptOrderRouteDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.routes.accept(requireRequestContext(request), routeId, input, idempotencyKey);
  }

  @Post(':routeId/decline') @HttpCode(200)
  @RequirePermissions('pharmacy.order-route.receive')
  decline(@Param('routeId', uuid()) routeId: string, @Body() input: DeclineOrderRouteDto, @Req() request: HidRequest) {
    return this.routes.decline(requireRequestContext(request), routeId, input);
  }
}
