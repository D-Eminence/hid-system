import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res,
  UseFilters } from '@nestjs/common';
import type { Response } from 'express';
import { AuditAction } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { type DataAccessContext, type HidRequest, requireRequestContext } from '../common/request-context';
import { DutyRosterService, type WriteAnswer } from './duty-roster.service';
import {
  CreateLeaveRequestDto, CreateRosterDto, ExpectedRowVersionDto, LeaveToDecideQueryDto, MarkAttendanceDto,
  NameInChargeDto, OnDutyQueryDto, RosterWeekQueryDto, SetRosterAssignmentsDto,
} from './workforce.dto';
import { requireEnabled, requireRosterAccess, type RosterAccess } from './workforce-problems';
import { WorkforceProblemFilter } from './workforce-validation.filter';

/**
 * The context of a duty roster or leave route: DUTY_ROSTER_ENABLED first (503
 * DUTY_ROSTER_NOT_AVAILABLE while off), then the session's codes at this
 * facility (403 in plain words); purpose is always healthcare-operations.
 * The database checks it all again (editors and deciders by department) and
 * audits.
 */
function rosterContext(request: HidRequest, access: RosterAccess): DataAccessContext {
  requireEnabled('roster');
  requireRosterAccess(request, access);
  return requireRequestContext(request, 'healthcare-operations');
}

function send(response: Response, answer: WriteAnswer) {
  response.status(answer.status);
  return answer.body;
}

const uuid = () => new ParseUUIDPipe();

/**
 * ROS-1 routes 6-22 (0200, 0202): department in-charges, leave and the duty
 * roster on NUR-1's clinical shifts (Q193 A: "Duty roster"; the cashier's day
 * is the till day). Staff never clock in; attendance is marked by an editor
 * (Q242 A). No Health ID in any path, query or answer.
 */
@Controller('identity')
@UseFilters(WorkforceProblemFilter)
export class DutyRosterController {
  constructor(private readonly roster: DutyRosterService) {}

  /** Route 6: who is in charge of each department. */
  @Get('duty-roster/in-charges')
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.duty-roster.in-charges')
  inCharges(@Req() request: HidRequest) {
    return this.roster.inCharges(rosterContext(request, 'read'));
  }

  /** Route 7: name an in-charge (administrators). */
  @Post('duty-roster/in-charges')
  @AuditAction('identity.duty-roster.in-charge-add')
  async nameInCharge(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined,
    @Body() input: NameInChargeDto, @Res({ passthrough: true }) response: Response) {
    const context = rosterContext(request, 'manage');
    return send(response, await this.roster.nameInCharge(context, input, requireIdempotencyKey(key)));
  }

  /** Route 8: end an in-charge (administrators). */
  @Post('duty-roster/in-charges/:inChargeId/end')
  @AuditAction('identity.duty-roster.in-charge-end')
  async endInCharge(@Req() request: HidRequest, @Param('inChargeId', uuid()) inChargeId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: ExpectedRowVersionDto,
    @Res({ passthrough: true }) response: Response) {
    const context = rosterContext(request, 'manage');
    return send(response, await this.roster.endInCharge(context, inChargeId, input.expectedRowVersion,
      requireIdempotencyKey(key)));
  }

  /** Route 9: my leave requests. */
  @Get('me/leave-requests')
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.staff-leave.list-mine')
  myLeave(@Req() request: HidRequest) {
    return this.roster.myLeave(rosterContext(request, 'leave'));
  }

  /** Route 10: ask for leave (type and dates only). */
  @Post('me/leave-requests')
  @AuditAction('identity.staff-leave.request')
  async askLeave(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined,
    @Body() input: CreateLeaveRequestDto, @Res({ passthrough: true }) response: Response) {
    const context = rosterContext(request, 'leave');
    return send(response, await this.roster.askLeave(context, input, requireIdempotencyKey(key)));
  }

  /** Route 11: the requester cancels. */
  @Post('me/leave-requests/:leaveRequestId/cancel')
  @AuditAction('identity.staff-leave.cancel')
  async cancelLeave(@Req() request: HidRequest, @Param('leaveRequestId', uuid()) leaveRequestId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: ExpectedRowVersionDto,
    @Res({ passthrough: true }) response: Response) {
    const context = rosterContext(request, 'member');
    return send(response, await this.roster.cancelLeave(context, leaveRequestId, input.expectedRowVersion,
      requireIdempotencyKey(key)));
  }

  /** Route 12: leave to decide, or decided (administrators: all; in-charges: their departments). */
  @Get('leave-requests')
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.staff-leave.list-to-decide')
  leaveToDecide(@Req() request: HidRequest, @Query() query: LeaveToDecideQueryDto) {
    return this.roster.leaveToDecide(rosterContext(request, 'decide'), query.status ?? 'requested',
      query.departmentCode ?? null);
  }

  /** Route 13: approve (never one's own; refused over rostered duties). */
  @Post('leave-requests/:leaveRequestId/approve')
  @HttpCode(200)
  @AuditAction('identity.staff-leave.approve')
  async approve(@Req() request: HidRequest, @Param('leaveRequestId', uuid()) leaveRequestId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: ExpectedRowVersionDto,
    @Res({ passthrough: true }) response: Response) {
    const context = rosterContext(request, 'decide');
    return send(response, await this.roster.decideLeave(context, leaveRequestId, 'approve', input.expectedRowVersion,
      requireIdempotencyKey(key)));
  }

  /** Route 14: decline (never one's own; no reason). */
  @Post('leave-requests/:leaveRequestId/decline')
  @HttpCode(200)
  @AuditAction('identity.staff-leave.decline')
  async decline(@Req() request: HidRequest, @Param('leaveRequestId', uuid()) leaveRequestId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: ExpectedRowVersionDto,
    @Res({ passthrough: true }) response: Response) {
    const context = rosterContext(request, 'decide');
    return send(response, await this.roster.decideLeave(context, leaveRequestId, 'decline', input.expectedRowVersion,
      requireIdempotencyKey(key)));
  }

  /** Route 15: the facility's rosters for a week. */
  @Get('duty-rosters')
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.duty-roster.list')
  rosters(@Req() request: HidRequest, @Query() query: RosterWeekQueryDto) {
    return this.roster.rosters(rosterContext(request, 'read'), query.weekStart);
  }

  /** Route 16: one roster (drafts for editors only). */
  @Get('duty-rosters/:rosterId')
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.duty-roster.read')
  read(@Req() request: HidRequest, @Param('rosterId', uuid()) rosterId: string) {
    return this.roster.roster(rosterContext(request, 'read'), rosterId);
  }

  /** Route 17: make the week's draft roster of a department (editors). */
  @Post('duty-rosters')
  @AuditAction('identity.duty-roster.create')
  async create(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined,
    @Body() input: CreateRosterDto, @Res({ passthrough: true }) response: Response) {
    const context = rosterContext(request, 'read');
    return send(response, await this.roster.createRoster(context, input, requireIdempotencyKey(key)));
  }

  /** Route 18: replace the week's duties, all or nothing (editors). */
  @Put('duty-rosters/:rosterId/assignments')
  @AuditAction('identity.duty-roster.assignments-set')
  async setAssignments(@Req() request: HidRequest, @Param('rosterId', uuid()) rosterId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: SetRosterAssignmentsDto,
    @Res({ passthrough: true }) response: Response) {
    const context = rosterContext(request, 'read');
    return send(response, await this.roster.setAssignments(context, rosterId, input, requireIdempotencyKey(key)));
  }

  /** Route 19: publish, or publish again after changes (editors). */
  @Post('duty-rosters/:rosterId/publish')
  @AuditAction('identity.duty-roster.publish')
  async publish(@Req() request: HidRequest, @Param('rosterId', uuid()) rosterId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: ExpectedRowVersionDto,
    @Res({ passthrough: true }) response: Response) {
    const context = rosterContext(request, 'read');
    return send(response, await this.roster.publish(context, rosterId, input.expectedRowVersion,
      requireIdempotencyKey(key)));
  }

  /** Route 20: mark attendance (editors, never their own duty). */
  @Post('duty-rosters/:rosterId/assignments/:assignmentId/attendance')
  @AuditAction('identity.duty-roster.attendance')
  async markAttendance(@Req() request: HidRequest, @Param('rosterId', uuid()) rosterId: string,
    @Param('assignmentId', uuid()) assignmentId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() input: MarkAttendanceDto, @Res({ passthrough: true }) response: Response) {
    const context = rosterContext(request, 'read');
    return send(response, await this.roster.markAttendance(context, rosterId, assignmentId, input,
      requireIdempotencyKey(key)));
  }

  /** Route 21: who is on duty now. */
  @Get('duty-roster/on-duty')
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.duty-roster.on-duty')
  onDuty(@Req() request: HidRequest, @Query() query: OnDutyQueryDto) {
    return this.roster.onDuty(rosterContext(request, 'read'), query.departmentCode ?? null);
  }

  /** Route 22: my published duties (any active member). */
  @Get('me/duties')
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.duty-roster.my-duties')
  myDuties(@Req() request: HidRequest) {
    return this.roster.myDuties(rosterContext(request, 'member'));
  }
}
