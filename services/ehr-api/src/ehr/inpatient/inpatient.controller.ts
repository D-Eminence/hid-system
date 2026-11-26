import {
  Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req,
} from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import { requireRequestContext, type DataAccessContext, type HidRequest } from '../../common/request-context';
import { requireIdempotencyKey } from '../shared/clinical-context';
import {
  AdmissionListQueryDto, AdmitDto, BandPrintDto, BedBoardQueryDto, BedStatusDto, CancelAdmissionDto, CensusQueryDto,
  CreateBedDto, CreateWardDto, DeathRecordAmendDto, DeathRecordDto, DeathRecordPrintQueryDto, DischargeDto,
  PrepareDischargeDto, RequestAdmissionDto, TransferDto, UpdateAdmissionDto, UpdateBedDto, UpdateWardDto,
  WardChargesDto, WardListQueryDto, WardStaffDto,
} from './inpatient.dto';
import {
  INPATIENT_MESSAGES, InpatientService, inpatientEnabled, notAvailable, requireInpatientAccess, type InpatientAccess,
} from './inpatient.service';

/**
 * The staff context of an inpatient route: the service flag first (503
 * INPATIENT_NOT_AVAILABLE while it is off), then the purpose (direct care;
 * healthcare operations for ward setup and for an admin's bed status), then
 * the session's codes at this facility (403 in plain words). The database
 * checks all of it again and audits.
 */
function wardContext(request: HidRequest, access: InpatientAccess,
  purposes: readonly string[] = ['direct-care']): DataAccessContext {
  if (!inpatientEnabled()) throw notAvailable();
  const purpose = request.header('x-purpose-of-use');
  if (!purpose || !purposes.includes(purpose)) {
    throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', INPATIENT_MESSAGES.directCareOnly);
  }
  const context = requireRequestContext(request, purpose);
  requireInpatientAccess(request, access);
  return context;
}

const uuid = () => new ParseUUIDPipe();

/**
 * ADT-1 (0170-0173): inpatient admission, wards and beds, transfers and
 * discharge. Wards, beds and admissions by UUID only; no Health ID or NIN in
 * any path or query. The one Health ID in any answer is the band print's, in
 * the body, for printing.
 */
@Controller('ehr')
export class InpatientController {
  constructor(private readonly inpatient: InpatientService) {}

  /** Route 1: the facility's wards (counts only). */
  @Get('wards')
  @Header('Cache-Control', 'no-store')
  wards(@Req() request: HidRequest, @Query() query: WardListQueryDto) {
    const context = wardContext(request, 'ward_list', ['direct-care', 'healthcare-operations']);
    return this.inpatient.listWards(context, query.includeInactive === true, query.includeBeds === true);
  }

  /** Route 2: a new ward (Q191 A: facility admins). */
  @Post('wards')
  @HttpCode(201)
  createWard(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined, @Body() input: CreateWardDto) {
    const context = wardContext(request, 'ward_manage', ['healthcare-operations']);
    return this.inpatient.createWard(context, input, requireIdempotencyKey(key));
  }

  /** Route 3: change a ward. */
  @Patch('wards/:wardId')
  @HttpCode(200)
  updateWard(@Req() request: HidRequest, @Param('wardId', uuid()) wardId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: UpdateWardDto) {
    const context = wardContext(request, 'ward_manage', ['healthcare-operations']);
    return this.inpatient.updateWard(context, wardId, input, requireIdempotencyKey(key));
  }

  /** Route 4: a new bed or overflow space. */
  @Post('wards/:wardId/beds')
  @HttpCode(201)
  createBed(@Req() request: HidRequest, @Param('wardId', uuid()) wardId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CreateBedDto) {
    const context = wardContext(request, 'ward_manage', ['healthcare-operations']);
    return this.inpatient.createBed(context, wardId, input, requireIdempotencyKey(key));
  }

  /** Route 5: rename a bed, or take it out of use. */
  @Patch('beds/:bedId')
  @HttpCode(200)
  updateBed(@Req() request: HidRequest, @Param('bedId', uuid()) bedId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: UpdateBedDto) {
    const context = wardContext(request, 'ward_manage', ['healthcare-operations']);
    return this.inpatient.updateBed(context, bedId, input, requireIdempotencyKey(key));
  }

  /** Route 6: the ward's staff list. */
  @Put('wards/:wardId/staff')
  @HttpCode(200)
  setWardStaff(@Req() request: HidRequest, @Param('wardId', uuid()) wardId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: WardStaffDto) {
    const context = wardContext(request, 'ward_manage', ['healthcare-operations']);
    return this.inpatient.setWardStaff(context, wardId, input, requireIdempotencyKey(key));
  }

  /** Route 7: the bed board of one ward, or of every active ward of a type (read again every 60 seconds). */
  @Get('bed-board')
  @Header('Cache-Control', 'no-store')
  bedBoard(@Req() request: HidRequest, @Query() query: BedBoardQueryDto) {
    return this.inpatient.bedBoard(wardContext(request, 'ward_read'), query.wardId, query.wardType);
  }

  /** Route 8: the census (counts only). */
  @Get('census')
  @Header('Cache-Control', 'no-store')
  census(@Req() request: HidRequest, @Query() query: CensusQueryDto) {
    return this.inpatient.census(wardContext(request, 'ward_read'), query.date);
  }

  /** Route 9: a bed's status by hand ("Complete bed turnover", "Place in maintenance", "Release from maintenance"). */
  @Post('beds/:bedId/status')
  @HttpCode(200)
  setBedStatus(@Req() request: HidRequest, @Param('bedId', uuid()) bedId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: BedStatusDto) {
    const context = wardContext(request, 'bed_status', ['direct-care', 'healthcare-operations']);
    return this.inpatient.setBedStatus(context, bedId, input, requireIdempotencyKey(key));
  }

  /** Route 10: request an admission (makes the planned inpatient visit at once, Q-ADT-9 A). */
  @Post('admissions')
  @HttpCode(201)
  request(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined,
    @Body() input: RequestAdmissionDto) {
    const context = wardContext(request, 'admission_decide');
    return this.inpatient.request(context, input, requireIdempotencyKey(key));
  }

  /** Route 11: the admissions list (wardType=icu is the ICU page). */
  @Get('admissions')
  @Header('Cache-Control', 'no-store')
  list(@Req() request: HidRequest, @Query() query: AdmissionListQueryDto) {
    return this.inpatient.list(wardContext(request, 'ward_read'), query);
  }

  /** Route 12: one admission and its movements (never the handover text). */
  @Get('admissions/:admissionId')
  @Header('Cache-Control', 'no-store')
  read(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string) {
    return this.inpatient.read(wardContext(request, 'ward_read'), admissionId);
  }

  /** Route 13: "Admit and allocate bed". */
  @Post('admissions/:admissionId/admit')
  @HttpCode(200)
  admit(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: AdmitDto) {
    const context = wardContext(request, 'bed_allocate');
    return this.inpatient.admit(context, admissionId, input, requireIdempotencyKey(key));
  }

  /** Route 14: "Transfer bed", with an optional nursing handover. */
  @Post('admissions/:admissionId/transfer')
  @HttpCode(200)
  transfer(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: TransferDto) {
    const context = wardContext(request, 'bed_allocate');
    return this.inpatient.transfer(context, admissionId, input, requireIdempotencyKey(key));
  }

  /** Route 14: the handover text, only with chart read access. */
  @Get('admissions/:admissionId/movements/:movementId/handover')
  @Header('Cache-Control', 'no-store')
  handover(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Param('movementId', uuid()) movementId: string) {
    return this.inpatient.handover(wardContext(request, 'admission_read'), admissionId, movementId);
  }

  /** Route 15: "Prepare discharge". */
  @Post('admissions/:admissionId/prepare-discharge')
  @HttpCode(200)
  prepareDischarge(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: PrepareDischargeDto) {
    const context = wardContext(request, 'admission_decide');
    return this.inpatient.prepareDischarge(context, admissionId, input, requireIdempotencyKey(key));
  }

  /** Route 16: "Discharge patient". Never reads the bill (Q189 A). */
  @Post('admissions/:admissionId/discharge')
  @HttpCode(200)
  discharge(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: DischargeDto) {
    const context = wardContext(request, 'admission_decide');
    return this.inpatient.discharge(context, admissionId, input, requireIdempotencyKey(key));
  }

  /** Route 17: cancel a request still waiting for a bed. */
  @Post('admissions/:admissionId/cancel')
  @HttpCode(200)
  cancel(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CancelAdmissionDto) {
    const context = wardContext(request, 'admission_decide');
    return this.inpatient.cancel(context, admissionId, input, requireIdempotencyKey(key));
  }

  /** Route 18: change an open admission. */
  @Patch('admissions/:admissionId')
  @HttpCode(200)
  update(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: UpdateAdmissionDto) {
    const context = wardContext(request, 'admission_decide');
    return this.inpatient.update(context, admissionId, input, requireIdempotencyKey(key));
  }

  /** Route 19: the printable discharge summary. */
  @Get('admissions/:admissionId/discharge-summary')
  @Header('Cache-Control', 'no-store')
  dischargeSummary(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string) {
    return this.inpatient.dischargeSummary(wardContext(request, 'admission_read'), admissionId);
  }

  /** Route 20: the inpatient band (the Health ID in this answer only, for printing). */
  @Post('admissions/:admissionId/wristband')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  wristband(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: BandPrintDto) {
    const context = wardContext(request, 'wristband');
    return this.inpatient.wristband(context, admissionId, input, requireIdempotencyKey(key), false);
  }

  /** Route 21: the newborn band, matched to the mother's. */
  @Post('admissions/:admissionId/newborn-band')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  newbornBand(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: BandPrintDto) {
    const context = wardContext(request, 'wristband');
    return this.inpatient.wristband(context, admissionId, input, requireIdempotencyKey(key), true);
  }

  /** Route 22 (switched off, Q188 A): the death record. */
  @Post('admissions/:admissionId/death-record')
  @HttpCode(201)
  deathRecordWrite(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Body() input: DeathRecordDto) {
    return this.inpatient.deathRecordWrite(wardContext(request, 'admission_read'), admissionId, input);
  }

  @Get('admissions/:admissionId/death-record')
  @Header('Cache-Control', 'no-store')
  deathRecordRead(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string) {
    return this.inpatient.deathRecordRead(wardContext(request, 'admission_read'), admissionId);
  }

  @Post('admissions/:admissionId/death-record/amend')
  @HttpCode(200)
  deathRecordAmend(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Body() input: DeathRecordAmendDto) {
    return this.inpatient.deathRecordAmend(wardContext(request, 'admission_read'), admissionId, input);
  }

  @Get('admissions/:admissionId/death-record/print')
  @Header('Cache-Control', 'no-store')
  deathRecordPrint(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Query() query: DeathRecordPrintQueryDto) {
    return this.inpatient.deathRecordPrint(wardContext(request, 'admission_read'), admissionId, query.form);
  }
}

/**
 * ADT-1's charges (Q189 A; 0172, on BILL-1's 0162-0167): ward charges and the
 * interim bill. They sit beside BILL-1's own /commercial routes (BILL-1's
 * gateway location sends /api/v1/commercial/ to ehr-api) and answer 503
 * BILLING_NOT_AVAILABLE on a database without BILL-1 or 0172. Healthcare
 * operations, as BILL-1's routes.
 */
@Controller('commercial')
export class InpatientChargesController {
  constructor(private readonly inpatient: InpatientService) {}

  private context(request: HidRequest): DataAccessContext {
    if (!inpatientEnabled()) throw notAvailable();
    return requireRequestContext(request, 'healthcare-operations');
  }

  @Get('ward-charges')
  @Header('Cache-Control', 'no-store')
  wardCharges(@Req() request: HidRequest) {
    return this.inpatient.wardCharges(this.context(request));
  }

  @Put('ward-charges/:wardId')
  @HttpCode(200)
  setWardCharges(@Req() request: HidRequest, @Param('wardId', uuid()) wardId: string, @Body() input: WardChargesDto) {
    return this.inpatient.setWardCharges(this.context(request), wardId, input);
  }

  @Get('bills/:billId/interim-statement')
  @Header('Cache-Control', 'no-store')
  interimStatement(@Req() request: HidRequest, @Param('billId', uuid()) billId: string) {
    return this.inpatient.interimStatement(this.context(request), billId);
  }
}
