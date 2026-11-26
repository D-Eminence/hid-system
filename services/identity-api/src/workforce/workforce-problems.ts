import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';

/**
 * ROS-1 (0199-0202): the answers of the licence, leave, in-charge and duty
 * roster routes (docs/INTERFACE_CONTRACT.md ROS-1, Errors). Staff screens show
 * each refusal's own message, and no message says "permission".
 */
export const WORKFORCE_MESSAGES = {
  validation: 'Check the highlighted fields.',
  hrNotAvailable: 'Licence renewals are not switched on yet.',
  rosterNotAvailable: 'The duty roster and leave are not switched on yet.',
  hrNotAllowed: 'Only this facility\'s administrator can see and record licence renewals.',
  staffManagementNotAvailable: 'Staff management is not available at this facility',
  reviewPending: 'Licence renewals can be recorded once Health ID support has checked this facility.',
  rosterNotAllowed: 'Only staff of this facility can see its duty roster.',
  rosterEditNotAllowed: 'Only the department\'s in-charge or an administrator can change this roster.',
  inChargeSetupNotAllowed: 'Only the facility\'s administrators can choose who is in charge of a department.',
  leaveRequestNotAllowed: 'Leave requests are not open to your role here. Ask the administrator.',
  leaveDecisionNotAllowed: 'Only the department\'s in-charge or an administrator can approve or decline this leave.',
  datesInvalid: 'Enter a licence year from last year to 3 years ahead, or an expiry date, checked in the last 90 days.',
  departmentInvalid: 'Choose one of this facility\'s departments.',
  memberInvalid: 'Choose a staff member who works at this facility.',
  leaveDatesInvalid: 'Leave can start up to 30 days ago, must end on or after its start, and can last up to 365 days.',
  weekInvalid: 'Choose a week that starts on a Monday, from 8 weeks ago to 26 weeks ahead.',
  shiftInvalid: 'Choose one of this facility\'s shifts.',
  dateOutsideWeek: 'Choose a day in this roster\'s week.',
  coverInvalid: 'Choose who worked this shift instead: someone else who works at this facility.',
  staffNotFound: 'This person does not work at this facility.',
  recordNotFound: 'This record is not at this facility.',
  licenceNotOnRecord: 'This person has no licence on record for that role. Add it on Staff & access first.',
  alreadyWithdrawn: 'This renewal was already withdrawn.',
  inChargeAlready: 'This person is already in charge of this department.',
  inChargeLimit: 'A department can have up to 5 people in charge.',
  leaveOverlaps: 'You already asked for leave on some of these days.',
  leaveAlreadyDecided: 'This leave request was already approved, declined or cancelled.',
  leaveOwnDecision: 'Someone else must approve or decline your own leave.',
  leaveCancelNotAllowed: 'Approved leave can be cancelled only before it starts. Ask your in-charge.',
  leaveClashesWithRoster: 'This person is on the roster during this leave. Take them off those duties first.',
  noDepartments: 'Add this facility\'s departments to its profile first.',
  shiftStarted: 'Duties that have started cannot be changed. Mark attendance instead.',
  overlap: 'This person is already on duty at that time.',
  restTooShort: (hours: number) => `This person needs at least ${hours} hours between duties.`,
  memberOnLeave: 'This person is on approved leave that day.',
  rosterEmpty: 'Add at least one duty before publishing.',
  notPublished: 'Publish the roster before marking attendance.',
  attendanceNotOpen: 'Attendance can be marked from 1 hour before the shift starts until 7 days after it ends.',
  attendanceOwn: 'Another in-charge or an administrator marks your own attendance.',
  versionConflict: 'Someone else changed this. Reload it and try again.',
  keyReused: 'Idempotency-Key was already used with a different request',
} as const;

export type WorkforceArea = 'hr' | 'roster';

/** HR_CREDENTIALS_ENABLED (routes 1-5) and DUTY_ROSTER_ENABLED (routes 6-22), both off by default. */
export function workforceEnabled(area: WorkforceArea): boolean {
  const environment = getEnvironment();
  return area === 'hr' ? environment.HR_CREDENTIALS_ENABLED : environment.DUTY_ROSTER_ENABLED;
}

export function notAvailable(area: WorkforceArea): DomainProblem {
  return area === 'hr'
    ? new DomainProblem(503, 'HR_CREDENTIALS_NOT_AVAILABLE', WORKFORCE_MESSAGES.hrNotAvailable)
    : new DomainProblem(503, 'DUTY_ROSTER_NOT_AVAILABLE', WORKFORCE_MESSAGES.rosterNotAvailable);
}

/** The flag first: while it is off every route of the area answers its 503. */
export function requireEnabled(area: WorkforceArea): void {
  if (!workforceEnabled(area)) throw notAvailable(area);
}

/** What a session must hold at the facility before the database is asked (the database checks it all again). */
export type RosterAccess = 'read' | 'manage' | 'leave' | 'decide' | 'member';

const ROSTER_REFUSALS: Readonly<Record<Exclude<RosterAccess, 'member'>, readonly [string, string]>> = {
  read: ['DUTY_ROSTER_NOT_ALLOWED', WORKFORCE_MESSAGES.rosterNotAllowed],
  manage: ['IN_CHARGE_SETUP_NOT_ALLOWED', WORKFORCE_MESSAGES.inChargeSetupNotAllowed],
  leave: ['LEAVE_REQUEST_NOT_ALLOWED', WORKFORCE_MESSAGES.leaveRequestNotAllowed],
  decide: ['LEAVE_DECISION_NOT_ALLOWED', WORKFORCE_MESSAGES.leaveDecisionNotAllowed],
};

function sessionPermissions(request: HidRequest): ReadonlySet<string> {
  return new Set(request.actor?.facility?.permissions ?? request.actor?.permissions ?? []);
}

/** Routes 6-22: the session's codes at this facility (any active member for 'member', route 11's and 22's). */
export function requireRosterAccess(request: HidRequest, access: RosterAccess): void {
  if (access === 'member') return;
  const held = sessionPermissions(request);
  const allowed = access === 'read' ? held.has('workforce.roster.read')
    : access === 'manage' ? held.has('workforce.roster.manage')
      : access === 'leave' ? held.has('workforce.leave.request')
        : held.has('workforce.roster.read') || held.has('workforce.roster.manage');
  if (!allowed) {
    const [code, message] = ROSTER_REFUSALS[access];
    throw new DomainProblem(403, code, message);
  }
}

/**
 * Routes 1-5: a staff session holding workforce.manage at a self-signed-up
 * facility (0086's rule, as GET /identity/facility-staff).
 */
export function requireLicenceAccess(request: HidRequest): void {
  if (!request.actor?.facility?.selfService) {
    throw new DomainProblem(403, 'STAFF_MANAGEMENT_NOT_AVAILABLE', WORKFORCE_MESSAGES.staffManagementNotAvailable);
  }
  if (!sessionPermissions(request).has('workforce.manage')) {
    throw new DomainProblem(403, 'HR_CREDENTIALS_NOT_ALLOWED', WORKFORCE_MESSAGES.hrNotAllowed);
  }
}

function databaseError(error: unknown): { code?: string; message: string } {
  if (typeof error !== 'object' || error === null) return { message: '' };
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return { ...(typeof code === 'string' ? { code } : {}), message: typeof message === 'string' ? message : '' };
}

const ROSTER_DENIALS: Readonly<Record<string, readonly [string, string]>> = {
  DUTY_ROSTER_NOT_ALLOWED: ['DUTY_ROSTER_NOT_ALLOWED', WORKFORCE_MESSAGES.rosterNotAllowed],
  IN_CHARGE_SETUP_NOT_ALLOWED: ['IN_CHARGE_SETUP_NOT_ALLOWED', WORKFORCE_MESSAGES.inChargeSetupNotAllowed],
  LEAVE_REQUEST_NOT_ALLOWED: ['LEAVE_REQUEST_NOT_ALLOWED', WORKFORCE_MESSAGES.leaveRequestNotAllowed],
  LEAVE_DECISION_NOT_ALLOWED: ['LEAVE_DECISION_NOT_ALLOWED', WORKFORCE_MESSAGES.leaveDecisionNotAllowed],
};

/**
 * A raised database error of a workforce route: 42501 (who), 22023 (input
 * identity-api never sends), 40001 and 40P01 (a concurrent change), a missing
 * function or table (a database without the route's migration: 503), anything
 * else 503.
 */
export function workforceDatabaseProblem(error: unknown, area: WorkforceArea): DomainProblem {
  if (error instanceof DomainProblem) return error;
  const { code, message } = databaseError(error);
  switch (code) {
    case '42501':
      if (area === 'hr') {
        return message === 'STAFF_MANAGEMENT_NOT_AVAILABLE'
          ? new DomainProblem(403, 'STAFF_MANAGEMENT_NOT_AVAILABLE', WORKFORCE_MESSAGES.staffManagementNotAvailable)
          : new DomainProblem(403, 'HR_CREDENTIALS_NOT_ALLOWED', WORKFORCE_MESSAGES.hrNotAllowed);
      }
      return new DomainProblem(403, ...(ROSTER_DENIALS[message] ?? ROSTER_DENIALS.DUTY_ROSTER_NOT_ALLOWED!));
    case '22023':
      return new DomainProblem(400, 'VALIDATION_FAILED', WORKFORCE_MESSAGES.validation);
    case '40001':
    case '40P01':
      return new DomainProblem(409, 'VERSION_CONFLICT', WORKFORCE_MESSAGES.versionConflict);
    default:
      return notAvailable(area);
  }
}

type Refusal = readonly [status: number, code: string, message: string];

/** The outcomes the database functions answer instead of raising, and their HTTP answers. */
const OUTCOME_REFUSALS: Readonly<Record<string, Refusal>> = {
  key_reused: [409, 'IDEMPOTENCY_KEY_REUSED', WORKFORCE_MESSAGES.keyReused],
  changed: [409, 'VERSION_CONFLICT', WORKFORCE_MESSAGES.versionConflict],
  review_pending: [409, 'FACILITY_REVIEW_PENDING', WORKFORCE_MESSAGES.reviewPending],
  licence_not_on_record: [409, 'LICENCE_NOT_ON_RECORD', WORKFORCE_MESSAGES.licenceNotOnRecord],
  dates_invalid: [400, 'LICENCE_RENEWAL_DATES_INVALID', WORKFORCE_MESSAGES.datesInvalid],
  already_withdrawn: [409, 'LICENCE_RENEWAL_ALREADY_WITHDRAWN', WORKFORCE_MESSAGES.alreadyWithdrawn],
  department_invalid: [400, 'DEPARTMENT_INVALID', WORKFORCE_MESSAGES.departmentInvalid],
  already: [409, 'IN_CHARGE_ALREADY', WORKFORCE_MESSAGES.inChargeAlready],
  limit_reached: [409, 'IN_CHARGE_LIMIT_REACHED', WORKFORCE_MESSAGES.inChargeLimit],
  overlaps: [409, 'LEAVE_OVERLAPS', WORKFORCE_MESSAGES.leaveOverlaps],
  cancel_not_allowed: [409, 'LEAVE_CANCEL_NOT_ALLOWED', WORKFORCE_MESSAGES.leaveCancelNotAllowed],
  decision_not_allowed: [403, 'LEAVE_DECISION_NOT_ALLOWED', WORKFORCE_MESSAGES.leaveDecisionNotAllowed],
  own_decision: [409, 'LEAVE_OWN_DECISION_NOT_ALLOWED', WORKFORCE_MESSAGES.leaveOwnDecision],
  already_decided: [409, 'LEAVE_ALREADY_DECIDED', WORKFORCE_MESSAGES.leaveAlreadyDecided],
  clashes_with_roster: [409, 'LEAVE_CLASHES_WITH_ROSTER', WORKFORCE_MESSAGES.leaveClashesWithRoster],
  week_invalid: [400, 'ROSTER_WEEK_INVALID', WORKFORCE_MESSAGES.weekInvalid],
  no_departments: [409, 'DUTY_ROSTER_NO_DEPARTMENTS', WORKFORCE_MESSAGES.noDepartments],
  edit_not_allowed: [403, 'DUTY_ROSTER_EDIT_NOT_ALLOWED', WORKFORCE_MESSAGES.rosterEditNotAllowed],
  member_invalid: [400, 'ROSTER_MEMBER_INVALID', WORKFORCE_MESSAGES.memberInvalid],
  shift_invalid: [400, 'ROSTER_SHIFT_INVALID', WORKFORCE_MESSAGES.shiftInvalid],
  date_outside_week: [400, 'ROSTER_DATE_OUTSIDE_WEEK', WORKFORCE_MESSAGES.dateOutsideWeek],
  shift_started: [409, 'ROSTER_SHIFT_STARTED', WORKFORCE_MESSAGES.shiftStarted],
  overlap: [409, 'ROSTER_OVERLAP', WORKFORCE_MESSAGES.overlap],
  member_on_leave: [409, 'ROSTER_MEMBER_ON_LEAVE', WORKFORCE_MESSAGES.memberOnLeave],
  empty: [409, 'ROSTER_EMPTY', WORKFORCE_MESSAGES.rosterEmpty],
  not_published: [409, 'ROSTER_NOT_PUBLISHED', WORKFORCE_MESSAGES.notPublished],
  not_open: [409, 'ATTENDANCE_NOT_OPEN', WORKFORCE_MESSAGES.attendanceNotOpen],
  own_not_allowed: [409, 'ATTENDANCE_OWN_NOT_ALLOWED', WORKFORCE_MESSAGES.attendanceOwn],
  cover_invalid: [400, 'ATTENDANCE_COVER_INVALID', WORKFORCE_MESSAGES.coverInvalid],
  assignment_not_found: [404, 'ROSTER_ASSIGNMENT_NOT_FOUND', WORKFORCE_MESSAGES.recordNotFound],
};

/** The not-found code of each route family (the outcome not_found). */
export type NotFoundKind = 'staff' | 'renewal' | 'in-charge' | 'leave' | 'roster';
const NOT_FOUND: Readonly<Record<NotFoundKind, Refusal>> = {
  staff: [404, 'FACILITY_STAFF_NOT_FOUND', WORKFORCE_MESSAGES.staffNotFound],
  renewal: [404, 'LICENCE_RENEWAL_NOT_FOUND', WORKFORCE_MESSAGES.recordNotFound],
  'in-charge': [404, 'IN_CHARGE_NOT_FOUND', WORKFORCE_MESSAGES.recordNotFound],
  leave: [404, 'LEAVE_REQUEST_NOT_FOUND', WORKFORCE_MESSAGES.recordNotFound],
  roster: [404, 'ROSTER_NOT_FOUND', WORKFORCE_MESSAGES.recordNotFound],
};

/** The details a refusal may carry: the leave clash's dates, a roster save's first refused duty. */
export type RefusalDetails = Readonly<Record<string, unknown>> | null | undefined;

/** The answer to an outcome that is a refusal (and 503 for an outcome this image does not know). */
export function outcomeProblem(outcome: string | null | undefined, area: WorkforceArea, notFound: NotFoundKind,
  details?: RefusalDetails): DomainProblem {
  if (outcome === 'not_found') {
    const [status, code, message] = NOT_FOUND[notFound];
    return new DomainProblem(status, code, message);
  }
  if (outcome === 'rest_too_short') {
    const hours = typeof details?.minRestHours === 'number' || typeof details?.minRestHours === 'string'
      ? Number(details.minRestHours) : 8;
    const { minRestHours: _rule, ...duty } = details ?? {};
    return new DomainProblem(409, 'ROSTER_REST_TOO_SHORT', WORKFORCE_MESSAGES.restTooShort(hours), undefined,
      { details: duty });
  }
  const refusal = outcome ? OUTCOME_REFUSALS[outcome] : undefined;
  if (!refusal) return notAvailable(area);
  const [status, code, message] = refusal;
  return new DomainProblem(status, code, message, undefined, details ? { details } : undefined);
}

/** Today's Lagos calendar date, YYYY-MM-DD. */
export function lagosDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit',
    day: '2-digit' }).format(at);
}
