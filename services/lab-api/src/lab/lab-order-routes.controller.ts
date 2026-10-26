import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { AcceptOrderRouteDto, DeclineOrderRouteDto, ListOrderRoutesQueryDto, ReportWrongPatientDto, SearchOrderRoutesDto }
  from './dto/order-route.dto';
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

  /** Incoming or Recent. A healthId in the URL is refused 400 before this route runs (health-id-in-url.ts). */
  @Get()
  @RequirePermissions('lab.order-route.receive') @AuditAction('lab.order-route.list.request')
  list(@Query() query: ListOrderRoutesQueryDto, @Req() request: HidRequest) {
    return this.routes.list(requireRequestContext(request), query);
  }

  /**
   * Find by the patient's Health ID, sent in the body so it is in no request
   * line a gateway, edge log or browser history keeps (CODEX §26).
   */
  @Post('search') @HttpCode(200)
  @RequirePermissions('lab.order-route.receive') @AuditAction('lab.order-route.list.request')
  search(@Body() input: SearchOrderRoutesDto, @Req() request: HidRequest) {
    return this.routes.search(requireRequestContext(request), input);
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

  /**
   * The laboratory accepted this order for someone who was not its patient
   * (C25, SPEC-FINAL item 3 §5.1): its access ends and every result it sent
   * back is withdrawn, in one transaction. Any member who may receive lab
   * requests; withdrawing a result also needs lab.result.entered-in-error,
   * which the command checks. The interceptor's row carries no body (the
   * support note is never audited).
   */
  @Post(':routeId/wrong-patient') @HttpCode(200)
  @RequirePermissions('lab.order-route.receive') @AuditAction('lab.order-route.wrong-patient.request')
  reportWrongPatient(@Param('routeId', uuid()) routeId: string, @Body() input: ReportWrongPatientDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.routes.reportWrongPatient(requireRequestContext(request), routeId, input, idempotencyKey);
  }
}
