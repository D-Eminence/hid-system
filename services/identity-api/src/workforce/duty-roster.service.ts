import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type {
  CreateLeaveRequestDto, CreateRosterDto, MarkAttendanceDto, NameInChargeDto, SetRosterAssignmentsDto,
} from './workforce.dto';
import { type NotFoundKind, outcomeProblem, type RefusalDetails, WORKFORCE_MESSAGES, workforceDatabaseProblem }
  from './workforce-problems';

/**
 * ROS-1 routes 6-22 (0200, 0202): department in-charges, leave and the duty
 * roster. Every call works through the SECURITY DEFINER functions of 0200 and
 * 0202, which admit the caller (0200's identity.workforce_actor: an active
 * membership here, the route's code, healthcare-operations), decide (editors
 * are 0200's identity.workforce_editor_departments) and audit in the
 * request's transaction, refusals included. The database refuses overlapping
 * duties, a rest under the rule (DRAFT 8 hours, awaiting the clinical lead),
 * duties on approved leave and approvals over rostered duties, whatever writes
 * the row. Built at Q-ROS-8 A to Q-ROS-15 A (not yet answered by the owner).
 */

export const WORKFORCE_SQL = {
  inChargeList: 'select identity.workforce_in_charge_list() as body',
  inChargeAdd: 'select * from identity.workforce_in_charge_add($1, $2, $3, $4)',
  inChargeEnd: 'select * from identity.workforce_in_charge_end($1, $2, $3, $4)',
  leaveMine: 'select identity.staff_leave_requests_mine() as body',
  leaveCreate: 'select * from identity.staff_leave_request_create($1, $2, $3, $4, $5, $6)',
  leaveCancel: 'select * from identity.staff_leave_request_cancel($1, $2, $3, $4)',
  leaveToDecide: 'select * from identity.staff_leave_requests_to_decide($1, $2)',
  leaveDecide: 'select * from identity.staff_leave_request_decide($1, $2, $3, $4, $5)',
  rosterList: 'select * from identity.duty_roster_list($1)',
  rosterRead: 'select * from identity.duty_roster_read($1)',
  rosterCreate: 'select * from identity.duty_roster_create($1, $2, $3, $4)',
  rosterSet: 'select * from identity.duty_roster_assignments_set($1, $2, $3::jsonb, $4, $5)',
  rosterPublish: 'select * from identity.duty_roster_publish($1, $2, $3, $4)',
  attendance: 'select * from identity.duty_roster_attendance_mark($1, $2, $3, $4, $5, $6, $7)',
  onDuty: 'select * from identity.duty_roster_on_duty($1)',
  myDuties: 'select identity.duty_roster_my_duties() as body',
} as const;

interface OutcomeRow extends QueryResultRow {
  outcome: string;
  replayed?: boolean;
  details?: Record<string, unknown> | null;
  [answer: string]: unknown;
}

/** A write's answer: its HTTP status and body. */
export interface WriteAnswer {
  status: number;
  body: Record<string, unknown>;
}

@Injectable()
export class DutyRosterService {
  constructor(private readonly database: DatabaseService) {}

  private async one(context: DataAccessContext, sql: string, values: unknown[] = []): Promise<OutcomeRow | undefined> {
    try {
      return await this.database.withTransaction(context, async (client) =>
        (await client.query<OutcomeRow>(sql, values)).rows[0]);
    } catch (error) {
      throw workforceDatabaseProblem(error, 'roster');
    }
  }

  /** The answer of a function that returns (outcome, replayed, <answer>, [details]). */
  private written(row: OutcomeRow | undefined, success: readonly string[], notFound: NotFoundKind,
    answer: (row: OutcomeRow) => Record<string, unknown>, createdStatus = 200): WriteAnswer {
    if (!row || !success.includes(row.outcome)) {
      throw outcomeProblem(row?.outcome, 'roster', notFound, (row?.details ?? undefined) as RefusalDetails);
    }
    const replayed = row.replayed === true;
    return { status: replayed ? 200 : createdStatus, body: { ...answer(row), replayed } };
  }

  // Routes 6-8: department in-charges.
  async inCharges(context: DataAccessContext) {
    return (await this.one(context, WORKFORCE_SQL.inChargeList))?.body ?? { departments: [] };
  }

  async nameInCharge(context: DataAccessContext, input: NameInChargeDto, key: string): Promise<WriteAnswer> {
    const digest = requestDigest('identity.duty-roster.in-charge-add', { ...input });
    const row = await this.one(context, WORKFORCE_SQL.inChargeAdd, [input.departmentCode, input.membershipId, key, digest]);
    if (row?.outcome === 'member_invalid') {
      throw new DomainProblem(400, 'IN_CHARGE_MEMBER_INVALID', WORKFORCE_MESSAGES.memberInvalid);
    }
    return this.written(row, ['named'], 'in-charge', (answer) => ({ inCharge: answer.in_charge }), 201);
  }

  async endInCharge(context: DataAccessContext, inChargeId: string, expectedRowVersion: number,
    key: string): Promise<WriteAnswer> {
    const digest = requestDigest('identity.duty-roster.in-charge-end', { inChargeId, expectedRowVersion });
    const row = await this.one(context, WORKFORCE_SQL.inChargeEnd, [inChargeId, expectedRowVersion, key, digest]);
    return this.written(row, ['ended'], 'in-charge', (answer) => ({ inCharge: answer.in_charge }));
  }

  // Routes 9-14: leave.
  async myLeave(context: DataAccessContext) {
    return (await this.one(context, WORKFORCE_SQL.leaveMine))?.body ?? { items: [] };
  }

  async askLeave(context: DataAccessContext, input: CreateLeaveRequestDto, key: string): Promise<WriteAnswer> {
    const departmentCode = input.departmentCode ?? null;
    const digest = requestDigest('identity.staff-leave.request', { leaveType: input.leaveType, startsOn: input.startsOn,
      endsOn: input.endsOn, departmentCode });
    const row = await this.one(context, WORKFORCE_SQL.leaveCreate, [input.leaveType, input.startsOn, input.endsOn,
      departmentCode, key, digest]);
    if (row?.outcome === 'dates_invalid') {
      throw new DomainProblem(400, 'LEAVE_DATES_INVALID', WORKFORCE_MESSAGES.leaveDatesInvalid);
    }
    return this.written(row, ['requested'], 'leave', (answer) => ({ leaveRequest: answer.leave_request }), 201);
  }

  async cancelLeave(context: DataAccessContext, leaveRequestId: string, expectedRowVersion: number,
    key: string): Promise<WriteAnswer> {
    const digest = requestDigest('identity.staff-leave.cancel', { leaveRequestId, expectedRowVersion });
    const row = await this.one(context, WORKFORCE_SQL.leaveCancel, [leaveRequestId, expectedRowVersion, key, digest]);
    return this.written(row, ['cancelled'], 'leave', (answer) => ({ leaveRequest: answer.leave_request }));
  }

  async leaveToDecide(context: DataAccessContext, status: 'requested' | 'decided', departmentCode: string | null) {
    const row = await this.one(context, WORKFORCE_SQL.leaveToDecide, [status, departmentCode]);
    if (row?.outcome !== 'listed') throw outcomeProblem(row?.outcome, 'roster', 'leave');
    return row.body as Record<string, unknown>;
  }

  async decideLeave(context: DataAccessContext, leaveRequestId: string, decision: 'approve' | 'decline',
    expectedRowVersion: number, key: string): Promise<WriteAnswer> {
    const digest = requestDigest(`identity.staff-leave.${decision}`, { leaveRequestId, expectedRowVersion });
    const row = await this.one(context, WORKFORCE_SQL.leaveDecide, [leaveRequestId, decision, expectedRowVersion, key,
      digest]);
    return this.written(row, [decision === 'approve' ? 'approved' : 'declined'], 'leave',
      (answer) => ({ leaveRequest: answer.leave_request }));
  }

  // Routes 15-22: the duty roster.
  async rosters(context: DataAccessContext, weekStart: string) {
    const row = await this.one(context, WORKFORCE_SQL.rosterList, [weekStart]);
    if (row?.outcome !== 'listed') throw outcomeProblem(row?.outcome, 'roster', 'roster');
    return row.body as Record<string, unknown>;
  }

  async roster(context: DataAccessContext, rosterId: string) {
    const row = await this.one(context, WORKFORCE_SQL.rosterRead, [rosterId]);
    if (row?.outcome !== 'found') throw outcomeProblem(row?.outcome, 'roster', 'roster');
    return row.roster as Record<string, unknown>;
  }

  async createRoster(context: DataAccessContext, input: CreateRosterDto, key: string): Promise<WriteAnswer> {
    const digest = requestDigest('identity.duty-roster.create', { ...input });
    const row = await this.one(context, WORKFORCE_SQL.rosterCreate, [input.departmentCode, input.weekStart, key, digest]);
    return this.written(row, ['created', 'already_exists'], 'roster',
      (answer) => ({ outcome: answer.outcome, roster: answer.roster }), 201);
  }

  async setAssignments(context: DataAccessContext, rosterId: string, input: SetRosterAssignmentsDto,
    key: string): Promise<WriteAnswer> {
    const seen = new Set<string>();
    for (const [index, entry] of input.assignments.entries()) {
      const id = `${entry.membershipId.toLowerCase()}|${entry.shiftId.toLowerCase()}|${entry.dutyDate}`;
      if (seen.has(id)) {
        throw new DomainProblem(400, 'VALIDATION_FAILED', WORKFORCE_MESSAGES.validation,
          [{ field: `assignments.${index}`, messages: ['Each duty can be given once'] }]);
      }
      seen.add(id);
    }
    const assignments = input.assignments.map((entry) => ({ membershipId: entry.membershipId.toLowerCase(),
      shiftId: entry.shiftId.toLowerCase(), dutyDate: entry.dutyDate }));
    const digest = requestDigest('identity.duty-roster.assignments-set', { rosterId,
      expectedRowVersion: input.expectedRowVersion, assignments });
    const row = await this.one(context, WORKFORCE_SQL.rosterSet, [rosterId, input.expectedRowVersion,
      JSON.stringify(assignments), key, digest]);
    return this.written(row, ['saved'], 'roster', (answer) => ({ roster: answer.roster, changes: answer.changes }));
  }

  async publish(context: DataAccessContext, rosterId: string, expectedRowVersion: number,
    key: string): Promise<WriteAnswer> {
    const digest = requestDigest('identity.duty-roster.publish', { rosterId, expectedRowVersion });
    const row = await this.one(context, WORKFORCE_SQL.rosterPublish, [rosterId, expectedRowVersion, key, digest]);
    return this.written(row, ['published', 'unchanged'], 'roster',
      (answer) => ({ outcome: answer.outcome, roster: answer.roster }));
  }

  async markAttendance(context: DataAccessContext, rosterId: string, assignmentId: string, input: MarkAttendanceDto,
    key: string): Promise<WriteAnswer> {
    if ((input.attendance === 'swapped') !== (input.coveredByMembershipId !== undefined)) {
      throw new DomainProblem(400, 'VALIDATION_FAILED', WORKFORCE_MESSAGES.validation,
        [{ field: 'coveredByMembershipId', messages: ['Name who worked instead for swapped, and only then'] }]);
    }
    const covered = input.coveredByMembershipId ?? null;
    const digest = requestDigest('identity.duty-roster.attendance', { rosterId, assignmentId,
      expectedRowVersion: input.expectedRowVersion, attendance: input.attendance, coveredByMembershipId: covered });
    const row = await this.one(context, WORKFORCE_SQL.attendance, [rosterId, assignmentId, input.expectedRowVersion,
      input.attendance, covered, key, digest]);
    return this.written(row, ['marked'], 'roster', (answer) => ({ assignment: answer.assignment }));
  }

  async onDuty(context: DataAccessContext, departmentCode: string | null) {
    const row = await this.one(context, WORKFORCE_SQL.onDuty, [departmentCode]);
    if (row?.outcome !== 'listed') throw outcomeProblem(row?.outcome, 'roster', 'roster');
    return row.body as Record<string, unknown>;
  }

  async myDuties(context: DataAccessContext) {
    return (await this.one(context, WORKFORCE_SQL.myDuties))?.body ?? { items: [] };
  }
}
