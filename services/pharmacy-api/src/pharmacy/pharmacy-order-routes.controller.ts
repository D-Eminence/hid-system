import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { AcceptOrderRouteDto, CannotCompleteOrderRouteDto, CorrectWrongPatientDto, DeclineOrderRouteDto, FindCorrectableDto,
  ListOrderRoutesQueryDto, ReportWrongPatientDto, SearchOrderRoutesDto } from './dto/order-route.dto';
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

  /**
   * Find a prescription this pharmacy accepted by its exact reference (C30,
   * D17 §5.1), to correct it after it ended. A POST, so the reference (with a
   * date of birth an acceptance factor) is in no request line. Declared before
   * the `:routeId` routes; a route id is a version-4 UUID, never this word.
   */
  @Post('correctable') @HttpCode(200)
  @RequirePermissions('pharmacy.order-route.receive')
  findCorrectable(@Body() input: FindCorrectableDto, @Req() request: HidRequest) {
    return this.routes.findCorrectable(requireRequestContext(request), input);
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

  /**
   * The pharmacy accepted this prescription for someone who was not its
   * patient (C25, SPEC-FINAL item 3 §5.1): its access ends and a dispensing
   * it recorded is reversed, in one transaction. Any member who may receive
   * prescriptions; reversing a dispensing also needs
   * pharmacy.dispensing.reverse, which the command checks.
   */
  @Post(':routeId/wrong-patient') @HttpCode(200)
  @RequirePermissions('pharmacy.order-route.receive')
  reportWrongPatient(@Param('routeId', uuid()) routeId: string, @Body() input: ReportWrongPatientDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.routes.reportWrongPatient(requireRequestContext(request), routeId, input, idempotencyKey);
  }

  /**
   * The pharmacy accepted this prescription for someone who was not its
   * patient and finds out after it ended or its window lapsed (C29, D17
   * §5.1): a dispensing it recorded is reversed, until 180 days after
   * acceptance, at most 5 per member and 20 per pharmacy in any 24 hours. Any
   * member who may receive prescriptions; reversing a dispensing also needs
   * pharmacy.dispensing.reverse, which the command checks.
   */
  @Post(':routeId/wrong-patient-correction') @HttpCode(200)
  @RequirePermissions('pharmacy.order-route.receive')
  correctWrongPatient(@Param('routeId', uuid()) routeId: string, @Body() input: CorrectWrongPatientDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.routes.correctWrongPatient(requireRequestContext(request), routeId, input, idempotencyKey);
  }

  /**
   * The pharmacy accepted this prescription and can't complete it (C31, D18
   * SPEC-FINAL §5.1): one fixed reason and the statement that the person it
   * accepted it for was its patient (or collecting for them). The
   * prescription ends (`cancelled`, `receiving_unable`), the pharmacy stops
   * seeing it at once and the patient is told; nothing is withdrawn (nothing
   * was dispensed). Any member who may receive prescriptions (D18-10); at
   * most 20 per member and 50 per pharmacy in any 24 hours (D18-7).
   */
  @Post(':routeId/cannot-complete') @HttpCode(200)
  @RequirePermissions('pharmacy.order-route.receive')
  cannotComplete(@Param('routeId', uuid()) routeId: string, @Body() input: CannotCompleteOrderRouteDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.routes.cannotComplete(requireRequestContext(request), routeId, input, idempotencyKey);
  }
}
