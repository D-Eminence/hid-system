import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { AcceptOrderRouteDto, CannotCompleteOrderRouteDto, CorrectWrongPatientDto, DeclineOrderRouteDto, FindCorrectableDto,
  ListOrderRoutesQueryDto, ReportWrongPatientDto, SearchOrderRoutesDto } from './dto/order-route.dto';
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

  /**
   * Find an order this laboratory accepted by its exact reference (C30, D17
   * §5.1), to correct it after it ended. A POST, so the reference (with a
   * date of birth an acceptance factor) is in no request line. Declared before
   * the `:routeId` routes; a route id is a version-4 UUID, never this word.
   */
  @Post('correctable') @HttpCode(200)
  @RequirePermissions('lab.order-route.receive') @AuditAction('lab.order-route.correctable.request')
  findCorrectable(@Body() input: FindCorrectableDto, @Req() request: HidRequest) {
    return this.routes.findCorrectable(requireRequestContext(request), input);
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

  /**
   * The laboratory accepted this order for someone who was not its patient
   * and finds out after the order ended or its window lapsed (C29, D17 §5.1):
   * every result it recorded on the order is withdrawn, until 180 days after
   * acceptance, at most 5 per member and 20 per laboratory in any 24 hours.
   * Any member who may receive lab requests; withdrawing a result also needs
   * lab.result.entered-in-error, which the command checks. The interceptor's
   * row carries no body (the support note is never audited).
   */
  @Post(':routeId/wrong-patient-correction') @HttpCode(200)
  @RequirePermissions('lab.order-route.receive') @AuditAction('lab.order-route.wrong-patient-correction.request')
  correctWrongPatient(@Param('routeId', uuid()) routeId: string, @Body() input: CorrectWrongPatientDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.routes.correctWrongPatient(requireRequestContext(request), routeId, input, idempotencyKey);
  }

  /**
   * The laboratory accepted this order and can't complete it (C31, D18
   * SPEC-FINAL §5.1): one fixed reason, the statement that the person it
   * accepted the order for was the order's patient, and, when a possibly
   * critical value is recorded, that the ordering facility was told. The
   * order ends (`cancelled`, `receiving_unable`), nothing more can be
   * recorded on it, and the patient is told; nothing is withdrawn (nothing
   * came back). Any member who may receive lab requests (D18-10); at most 20
   * per member and 50 per laboratory in any 24 hours (D18-7). The
   * interceptor's row carries no body.
   */
  @Post(':routeId/cannot-complete') @HttpCode(200)
  @RequirePermissions('lab.order-route.receive') @AuditAction('lab.order-route.cannot-complete.request')
  cannotComplete(@Param('routeId', uuid()) routeId: string, @Body() input: CannotCompleteOrderRouteDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.routes.cannotComplete(requireRequestContext(request), routeId, input, idempotencyKey);
  }
}
