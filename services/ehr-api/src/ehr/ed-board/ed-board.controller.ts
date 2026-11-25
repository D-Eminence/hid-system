import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import { requireRequestContext, type DataAccessContext, type HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import {
  EdArriveDto, EdBoardQueryDto, EdCancelDto, EdDispositionDto, EdLeaveDto, EdLinkVisitDto, EdMoveDto, EdTriageDto,
} from './ed-board.dto';
import {
  ED_MESSAGES, EdBoardService, canTriage, edBoardEnabled, notAvailable, requireEdAccess, type EdAccess,
} from './ed-board.service';

/**
 * The staff context of a board route: the service flag first (503
 * ED_BOARD_NOT_AVAILABLE while it is off), then direct care, then the
 * session's codes at this facility (403 in plain words). The database checks
 * all of it again and audits.
 */
function staffContext(request: HidRequest, access: EdAccess): DataAccessContext {
  if (!edBoardEnabled()) throw notAvailable();
  const context = clinicalContext(request);
  requireEdAccess(request, access);
  return context;
}

/**
 * Route 1's context: direct care, or emergency for a patient found by this
 * member's own emergency search (Q-ED-3 A: the database also requires the
 * member's active break-glass grant for that patient here).
 */
function arrivalContext(request: HidRequest, input: EdArriveDto): DataAccessContext {
  if (!edBoardEnabled()) throw notAvailable();
  const purpose = request.header('x-purpose-of-use');
  if (purpose !== 'direct-care' && !(purpose === 'emergency' && input.matchRef !== undefined)) {
    throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', ED_MESSAGES.directCareOnly);
  }
  const context = requireRequestContext(request, purpose);
  requireEdAccess(request, 'arrive');
  if ((input.triageLevel !== undefined || input.presentingComplaint !== undefined) && !canTriage(request)) {
    throw new DomainProblem(403, 'ED_TRIAGE_NOT_ALLOWED', ED_MESSAGES.triageNotAllowed);
  }
  return context;
}

const uuid = () => new ParseUUIDPipe();

/**
 * ED-1 (0168, 0169): this facility's emergency department board. The front
 * desk puts patients on it and sees it (without the complaint); nurses also
 * triage and move patients; clinicians and doctors also record where the
 * patient goes next (Q-ED-2 A). No Health ID or NIN in any path, query or
 * answer: ED records by UUID only.
 */
@Controller('ehr')
export class EdBoardController {
  constructor(private readonly board: EdBoardService) {}

  /** Route 1: put a patient on the board. */
  @Post('ed-attendances')
  @HttpCode(201)
  arrive(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined, @Body() input: EdArriveDto) {
    const context = arrivalContext(request, input);
    return this.board.arrive(context, input, requireIdempotencyKey(key));
  }

  /** Route 2: the board (read again every 30 seconds while shown). */
  @Get('ed-board')
  @Header('Cache-Control', 'no-store')
  list(@Req() request: HidRequest, @Query() query: EdBoardQueryDto) {
    return this.board.board(staffContext(request, 'read'), query.includeClosedToday === true);
  }

  /** Route 3: one record and its history. */
  @Get('ed-attendances/:attendanceId')
  @Header('Cache-Control', 'no-store')
  read(@Req() request: HidRequest, @Param('attendanceId', uuid()) attendanceId: string) {
    return this.board.read(staffContext(request, 'read'), attendanceId);
  }

  /** Route 4: triage. */
  @Post('ed-attendances/:attendanceId/triage')
  @HttpCode(200)
  triage(@Req() request: HidRequest, @Param('attendanceId', uuid()) attendanceId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: EdTriageDto) {
    const context = staffContext(request, 'triage');
    return this.board.triage(context, attendanceId, input, requireIdempotencyKey(key));
  }

  /** Route 5: move between stages, set or clear who is seeing the patient ("Start care"). */
  @Post('ed-attendances/:attendanceId/move')
  @HttpCode(200)
  move(@Req() request: HidRequest, @Param('attendanceId', uuid()) attendanceId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: EdMoveDto) {
    const context = staffContext(request, 'triage');
    return this.board.move(context, attendanceId, input, requireIdempotencyKey(key));
  }

  /** Route 6: link the visit. */
  @Post('ed-attendances/:attendanceId/visit')
  @HttpCode(200)
  linkVisit(@Req() request: HidRequest, @Param('attendanceId', uuid()) attendanceId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: EdLinkVisitDto) {
    const context = staffContext(request, 'triage');
    return this.board.linkVisit(context, attendanceId, input, requireIdempotencyKey(key));
  }

  /** Route 7: where the patient goes next. */
  @Post('ed-attendances/:attendanceId/disposition')
  @HttpCode(200)
  disposition(@Req() request: HidRequest, @Param('attendanceId', uuid()) attendanceId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: EdDispositionDto) {
    const context = staffContext(request, 'disposition');
    return this.board.disposition(context, attendanceId, input, requireIdempotencyKey(key));
  }

  /** Route 8: "Left the department". */
  @Post('ed-attendances/:attendanceId/leave')
  @HttpCode(200)
  leave(@Req() request: HidRequest, @Param('attendanceId', uuid()) attendanceId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: EdLeaveDto) {
    const context = staffContext(request, 'triage');
    return this.board.leave(context, attendanceId, input, requireIdempotencyKey(key));
  }

  /** Route 9: cancel an arrival made in error. */
  @Post('ed-attendances/:attendanceId/cancel')
  @HttpCode(200)
  cancel(@Req() request: HidRequest, @Param('attendanceId', uuid()) attendanceId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: EdCancelDto) {
    const context = staffContext(request, 'arrive');
    return this.board.cancel(context, attendanceId, input, requireIdempotencyKey(key));
  }
}
