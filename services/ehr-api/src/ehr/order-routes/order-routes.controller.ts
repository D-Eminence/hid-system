import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { FacilityOptional, PatientAllowed, RequirePermissions } from '../../common/decorators';
import { requireIdempotencyKey } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import { requireRequestContext, type HidRequest } from '../../common/request-context';
import { PatientStopOrderRouteDto, SendOrderRouteDto, WithdrawOrderRouteDto } from './dto/order-route.dto';
import { ORDER_ROUTE_KINDS, type OrderRouteKind } from './order-route.mapping';
import { KIND_WRITE_PERMISSION, OrderRoutesService } from './order-routes.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });
const LAB = 'patients/:patientId/encounters/:encounterId/lab-requests/:requestId/order-routes';
const PRESCRIPTION = 'patients/:patientId/encounters/:encounterId/prescriptions/:prescriptionId/order-routes';

/**
 * The ordering facility's cross-facility order routes (P4c, SPEC-FINAL
 * §10.1): send a lab request or prescription to a laboratory or pharmacy at
 * another facility with the clinician's attestation, list an order's routes,
 * withdraw one before acceptance, and read the attestation text to confirm.
 * Staff only (no @PatientAllowed), facility required. The purpose header must
 * be one Novu knows (400 PURPOSE_OF_USE_REQUIRED otherwise), and the service
 * answers anything but direct-care 403 PERMISSION_DENIED (PRIV P10).
 */
@Controller('ehr')
export class OrderRoutesController {
  constructor(private readonly routes: OrderRoutesService) {}

  @Post(LAB)
  @HttpCode(201)
  @RequirePermissions('ehr.lab-request.write', 'ehr.order-route.send')
  sendLabRequest(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) encounterId: string, @Param('requestId', uuid()) requestId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: SendOrderRouteDto) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.routes.send(requireRequestContext(request), 'lab_request', patientId, encounterId, requestId, input,
      idempotencyKey);
  }

  @Get(LAB)
  @RequirePermissions('ehr.lab-request.read')
  listLabRequestRoutes(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) encounterId: string, @Param('requestId', uuid()) requestId: string) {
    return this.routes.list(requireRequestContext(request), 'lab_request', patientId, encounterId, requestId);
  }

  @Post(`${LAB}/:routeId/withdraw`)
  @HttpCode(200)
  @RequirePermissions('ehr.order-route.send')
  withdrawLabRequestRoute(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) _encounterId: string, @Param('requestId', uuid()) requestId: string,
    @Param('routeId', uuid()) routeId: string, @Body() input: WithdrawOrderRouteDto) {
    return this.routes.withdraw(requireRequestContext(request), 'lab_request', patientId, requestId, routeId, input);
  }

  @Post(PRESCRIPTION)
  @HttpCode(201)
  @RequirePermissions('ehr.prescription.write', 'ehr.order-route.send')
  sendPrescription(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) encounterId: string, @Param('prescriptionId', uuid()) prescriptionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: SendOrderRouteDto) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.routes.send(requireRequestContext(request), 'prescription', patientId, encounterId, prescriptionId,
      input, idempotencyKey);
  }

  @Get(PRESCRIPTION)
  @RequirePermissions('ehr.prescription.read')
  listPrescriptionRoutes(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) encounterId: string, @Param('prescriptionId', uuid()) prescriptionId: string) {
    return this.routes.list(requireRequestContext(request), 'prescription', patientId, encounterId, prescriptionId);
  }

  @Post(`${PRESCRIPTION}/:routeId/withdraw`)
  @HttpCode(200)
  @RequirePermissions('ehr.order-route.send')
  withdrawPrescriptionRoute(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) _encounterId: string, @Param('prescriptionId', uuid()) prescriptionId: string,
    @Param('routeId', uuid()) routeId: string, @Body() input: WithdrawOrderRouteDto) {
    return this.routes.withdraw(requireRequestContext(request), 'prescription', patientId, prescriptionId, routeId,
      input);
  }

  /**
   * The current attestation text of a kind (C24), shown as the send screen's
   * checkbox. ehr.order-route.send and the kind's write permission; the kind
   * comes from the query, so its permission is checked here.
   */
  @Get('order-route-attestation')
  @RequirePermissions('ehr.order-route.send')
  attestation(@Req() request: HidRequest, @Query('kind') kind: unknown) {
    if (typeof kind !== 'string' || !ORDER_ROUTE_KINDS.includes(kind as OrderRouteKind)) {
      throw new DomainProblem(400, 'ORDER_ROUTE_INVALID', 'kind must be lab_request or prescription');
    }
    if (!request.actor?.permissions.includes(KIND_WRITE_PERMISSION[kind as OrderRouteKind])) {
      throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
    }
    return this.routes.attestation(requireRequestContext(request), kind as OrderRouteKind);
  }
}

/**
 * The patient's orders sent to other facilities (SPEC-FINAL §5, §10.1): the
 * list and Stop before acceptance, the patient's only write. Nothing else is
 * served under me/order-routes.
 */
@Controller('ehr/me/order-routes')
@FacilityOptional()
@PatientAllowed()
export class PatientOrderRoutesController {
  constructor(private readonly routes: OrderRoutesService) {}

  @Get()
  list(@Req() request: HidRequest) {
    return this.routes.patientList(request);
  }

  @Post(':routeId/withdraw')
  @HttpCode(200)
  stop(@Req() request: HidRequest, @Param('routeId', uuid()) routeId: string, @Body() input: PatientStopOrderRouteDto) {
    return this.routes.patientStop(request, routeId, input.expectedVersion);
  }
}
