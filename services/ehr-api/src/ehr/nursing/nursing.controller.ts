import {
  Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req,
} from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import { requireRequestContext, type DataAccessContext, type HidRequest } from '../../common/request-context';
import { requireIdempotencyKey } from '../shared/clinical-context';
import {
  AssignmentsQueryDto, CancelTaskDto, CompleteTaskDto, CreateShiftDto, CreateTaskDto, FluidDayQueryDto, FluidEntryDto,
  HandoverNoteDto, HandoverQueryDto, HandoverStepDto, MedicineRoundQueryDto, NewHandoverNoteDto,
  NursingEnteredInErrorDto, ObservationChartQueryDto, RecordDoseDto, SetAssignmentsDto, TaskListQueryDto,
  TaskVersionDto, UpdateShiftDto, UpdateTaskDto, WardRoundQueryDto,
} from './nursing.dto';
import {
  NURSING_MESSAGES, NursingService, notAvailable, nursingRoutesEnabled, requireNursingAccess, type NursingAccess,
} from './nursing.service';

/**
 * The staff context of a nursing route: the service flags first (503
 * NURSING_NOT_AVAILABLE while NURSING_ENABLED or INPATIENT_ENABLED is off),
 * then the purpose (direct care; healthcare operations for clinical shift
 * setup, and either for shift lists and assignments), then the session's codes
 * at this facility (403 in plain words). The database checks all of it again,
 * with the patient's chart access for chart content, and audits.
 */
function nursingContext(request: HidRequest, access: NursingAccess,
  purposes: readonly string[] = ['direct-care']): DataAccessContext {
  if (!nursingRoutesEnabled()) throw notAvailable();
  const purpose = request.header('x-purpose-of-use');
  if (!purpose || !purposes.includes(purpose)) {
    throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', NURSING_MESSAGES.purpose);
  }
  const context = requireRequestContext(request, purpose);
  requireNursingAccess(request, access);
  return context;
}

const uuid = () => new ParseUUIDPipe();
const BOTH = ['direct-care', 'healthcare-operations'] as const;

/**
 * NUR-1 (0174-0177): nursing on the ward. Admissions, orders, doses, tasks,
 * fluid entries, shifts and handover sheets by UUID only; no Health ID or NIN
 * in any path, query, body or answer. Today's vitals routes take the
 * observation chart's new fields (route 1) and the prescription create its
 * inpatient schedule (route 3), behind the same flag.
 */
@Controller('ehr')
export class NursingController {
  constructor(private readonly nursing: NursingService) {}

  /** Route 2: the stay's observation chart (Q195 A, Q199 A: no score; Q202 A: the ICU grid). */
  @Get('admissions/:admissionId/observation-chart')
  @Header('Cache-Control', 'no-store')
  chart(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Query() query: ObservationChartQueryDto) {
    const context = nursingContext(request, 'chart');
    return this.nursing.observationChart(context, admissionId, query.from, query.to, query.view);
  }

  /** Route 4: the stay's medicine administration record. */
  @Get('admissions/:admissionId/medicine-round')
  @Header('Cache-Control', 'no-store')
  medicineRound(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Query() query: MedicineRoundQueryDto) {
    const context = nursingContext(request, 'mar_read');
    return this.nursing.medicineRound(context, admissionId, query.from, query.to);
  }

  /** Route 5: the ward's round (names under ADT-1's rule; medicines only with chart access). */
  @Get('medicine-round')
  @Header('Cache-Control', 'no-store')
  wardRound(@Req() request: HidRequest, @Query() query: WardRoundQueryDto) {
    const context = nursingContext(request, 'mar_read');
    return this.nursing.wardRound(context, query.wardId, query.window ?? 'now');
  }

  /** Route 6: record a dose. */
  @Post('admissions/:admissionId/medicine-administrations')
  @HttpCode(201)
  recordDose(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: RecordDoseDto) {
    const context = nursingContext(request, 'mar_record');
    return this.nursing.recordDose(context, admissionId, input, requireIdempotencyKey(key));
  }

  /** Route 7: a dose marked entered in error (one way). */
  @Post('medicine-administrations/:administrationId/entered-in-error')
  @HttpCode(200)
  doseEnteredInError(@Req() request: HidRequest, @Param('administrationId', uuid()) administrationId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: NursingEnteredInErrorDto) {
    const context = nursingContext(request, 'mar_record');
    return this.nursing.doseEnteredInError(context, administrationId, input, requireIdempotencyKey(key));
  }

  /** Route 8: the task list (a ward's or an admission's). */
  @Get('nursing-tasks')
  @Header('Cache-Control', 'no-store')
  tasks(@Req() request: HidRequest, @Query() query: TaskListQueryDto) {
    const context = nursingContext(request, 'task_read');
    return this.nursing.tasks(context, query);
  }

  /** Route 9: a new task. */
  @Post('admissions/:admissionId/nursing-tasks')
  @HttpCode(201)
  createTask(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CreateTaskDto) {
    const context = nursingContext(request, 'task_write');
    return this.nursing.createTask(context, admissionId, input, requireIdempotencyKey(key));
  }

  /** Route 10: start. */
  @Post('nursing-tasks/:taskId/start')
  @HttpCode(200)
  startTask(@Req() request: HidRequest, @Param('taskId', uuid()) taskId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: TaskVersionDto) {
    const context = nursingContext(request, 'task_write');
    return this.nursing.startTask(context, taskId, input.expectedRowVersion, requireIdempotencyKey(key));
  }

  /** Route 10: complete (the completion record is chart content). */
  @Post('nursing-tasks/:taskId/complete')
  @HttpCode(200)
  completeTask(@Req() request: HidRequest, @Param('taskId', uuid()) taskId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CompleteTaskDto) {
    const context = nursingContext(request, 'task_write');
    return this.nursing.completeTask(context, taskId, input, requireIdempotencyKey(key));
  }

  /** Route 10: cancel. */
  @Post('nursing-tasks/:taskId/cancel')
  @HttpCode(200)
  cancelTask(@Req() request: HidRequest, @Param('taskId', uuid()) taskId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CancelTaskDto) {
    const context = nursingContext(request, 'task_write');
    return this.nursing.cancelTask(context, taskId, input, requireIdempotencyKey(key));
  }

  /** Route 10: reassign or move. */
  @Patch('nursing-tasks/:taskId')
  @HttpCode(200)
  updateTask(@Req() request: HidRequest, @Param('taskId', uuid()) taskId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: UpdateTaskDto) {
    const context = nursingContext(request, 'task_write');
    return this.nursing.updateTask(context, taskId, input, requireIdempotencyKey(key));
  }

  /** Route 11: one fluid day (Q-NUR-15 A). */
  @Get('admissions/:admissionId/fluid-balance')
  @Header('Cache-Control', 'no-store')
  fluidDay(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Query() query: FluidDayQueryDto) {
    const context = nursingContext(request, 'fluid_read');
    return this.nursing.fluidDay(context, admissionId, query.day);
  }

  /** Route 12: a fluid entry. */
  @Post('admissions/:admissionId/fluid-balance')
  @HttpCode(201)
  recordFluid(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: FluidEntryDto) {
    const context = nursingContext(request, 'fluid_write');
    return this.nursing.recordFluid(context, admissionId, input, requireIdempotencyKey(key));
  }

  /** Route 13: a fluid entry marked entered in error. */
  @Post('fluid-balance/:entryId/entered-in-error')
  @HttpCode(200)
  fluidEnteredInError(@Req() request: HidRequest, @Param('entryId', uuid()) entryId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: NursingEnteredInErrorDto) {
    const context = nursingContext(request, 'fluid_write');
    return this.nursing.fluidEnteredInError(context, entryId, input, requireIdempotencyKey(key));
  }

  /** Route 14: the facility's clinical shifts (Q193 A). */
  @Get('clinical-shifts')
  @Header('Cache-Control', 'no-store')
  shifts(@Req() request: HidRequest) {
    return this.nursing.shifts(nursingContext(request, 'shift_list', BOTH));
  }

  @Post('clinical-shifts')
  @HttpCode(201)
  createShift(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined,
    @Body() input: CreateShiftDto) {
    const context = nursingContext(request, 'shift_setup', ['healthcare-operations']);
    return this.nursing.createShift(context, input, requireIdempotencyKey(key));
  }

  @Patch('clinical-shifts/:shiftId')
  @HttpCode(200)
  updateShift(@Req() request: HidRequest, @Param('shiftId', uuid()) shiftId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: UpdateShiftDto) {
    const context = nursingContext(request, 'shift_setup', ['healthcare-operations']);
    return this.nursing.updateShift(context, shiftId, input, requireIdempotencyKey(key));
  }

  /** Route 15: a ward's list for a shift. */
  @Get('shift-assignments')
  @Header('Cache-Control', 'no-store')
  assignments(@Req() request: HidRequest, @Query() query: AssignmentsQueryDto) {
    const context = nursingContext(request, 'assign_read', BOTH);
    return this.nursing.assignments(context, query.date, query.shiftId, query.wardId);
  }

  @Put('shift-assignments')
  @HttpCode(200)
  setAssignments(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined,
    @Body() input: SetAssignmentsDto) {
    const context = nursingContext(request, 'assign', BOTH);
    return this.nursing.setAssignments(context, input, requireIdempotencyKey(key));
  }

  /** Route 16: the handover sheet. */
  @Get('handovers')
  @Header('Cache-Control', 'no-store')
  handover(@Req() request: HidRequest, @Query() query: HandoverQueryDto) {
    const context = nursingContext(request, 'task_read');
    return this.nursing.handover(context, query.wardId, query.date, query.shiftId);
  }

  /** Route 17, on a sheet not made yet (registered before the one with a sheet id). */
  @Put('handovers/new/patients/:admissionId')
  @HttpCode(200)
  newHandoverNote(@Req() request: HidRequest, @Param('admissionId', uuid()) admissionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: NewHandoverNoteDto) {
    const context = nursingContext(request, 'handover');
    return this.nursing.handoverNote(context, null, admissionId, input, requireIdempotencyKey(key));
  }

  /** Route 17: a patient's handover note on a draft sheet. */
  @Put('handovers/:handoverId/patients/:admissionId')
  @HttpCode(200)
  handoverNote(@Req() request: HidRequest, @Param('handoverId', uuid()) handoverId: string,
    @Param('admissionId', uuid()) admissionId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() input: HandoverNoteDto) {
    const context = nursingContext(request, 'handover');
    return this.nursing.handoverNote(context, handoverId, admissionId, input, requireIdempotencyKey(key));
  }

  /** Route 18: the outgoing nurse gives the sheet. */
  @Post('handovers/:handoverId/give')
  @HttpCode(200)
  give(@Req() request: HidRequest, @Param('handoverId', uuid()) handoverId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: HandoverStepDto) {
    const context = nursingContext(request, 'handover');
    return this.nursing.handoverStep(context, handoverId, 'give', input.expectedRowVersion, requireIdempotencyKey(key));
  }

  /** Route 18: a nurse of the next shift accepts it. */
  @Post('handovers/:handoverId/accept')
  @HttpCode(200)
  accept(@Req() request: HidRequest, @Param('handoverId', uuid()) handoverId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: HandoverStepDto) {
    const context = nursingContext(request, 'handover');
    return this.nursing.handoverStep(context, handoverId, 'accept', input.expectedRowVersion, requireIdempotencyKey(key));
  }
}
