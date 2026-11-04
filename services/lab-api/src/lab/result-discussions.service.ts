import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService, type AuditEventInput } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import { requireRequestContext, type DataAccessContext, type HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { RecordResultDiscussionDto, WithdrawResultDiscussionDto } from './dto/result-discussion.dto';
import { isGatedLabResult } from './patient-results.service';

/**
 * "Discussed with the patient" (patient chat part 2, migration 0121, owner
 * Q24 b). A clinician with care access to the patient marks a released
 * sensitive or critical result as discussed; while the mark on the result's
 * last released version is active (and its visit is finished), the result may
 * reach the patient's own chat, where ehr-api adds the talk-to-your-doctor
 * line. A mark can be withdrawn with a reason code and a reason. The reason is
 * stored only in lab.result_discussion_events: never in audit.events, a log,
 * an error or a response.
 *
 * Every call writes an ids-only audit row: in its transaction on success, and
 * after the rollback on a refusal.
 */

type Action = 'lab.result.discussion.list' | 'lab.result.discussion.record' | 'lab.result.discussion.withdraw';
interface Resource { resourceType: string; resourceId: string; patientId: string }

interface CommandRow { event_id: string; event_no: number | string; state: string; occurred_at: Date | string;
  finished_visit: boolean; replayed: boolean }
interface ListRow { result_id: string; result_version: number | string; test_code_system: string | null; test_code: string | null;
  test_name: string | null; abnormal_flag: string | null; released_at: Date | string; finished_visit: boolean;
  discussion_state: string | null; discussion_event_no: number | string | null; discussion_at: Date | string | null;
  discussion_by_membership_id: string | null; withdrawal_reason_code: string | null }

export interface ResultDiscussionItem {
  resultId: string; resultVersion: number;
  test: { codeSystem: string | null; code: string | null; name: string | null };
  releasedAt: string;
  gate: { sensitive: boolean; critical: boolean };
  finishedVisit: boolean;
  discussion: null | { state: 'discussed' | 'withdrawn'; eventNo: number; at: string; byMembershipId: string; reasonCode: string | null };
  visibleToPatient: boolean;
}

/** The most gated results the list returns (newest first); `truncated` says when there were more. */
export const RESULT_DISCUSSION_LIST_LIMIT = 500;

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();
const unavailable = (cause?: unknown) => new DomainProblem(503, 'LAB_SERVICE_UNAVAILABLE',
  'The laboratory service could not complete the request', undefined, cause === undefined ? undefined : { cause });

const CONFLICTS: Readonly<Record<string, string>> = {
  RESULT_VERSION_CHANGED: 'The result has a newer version; reload it',
  RESULT_NOT_RELEASED: 'This version of the result is not released',
  RESULT_ENTERED_IN_ERROR: 'This result was entered in error',
  RESULT_NOT_DISCUSSED: 'This result is not marked as discussed',
  RESULT_DISCUSSION_CHANGED: 'The mark on this result was changed after this request; reload it',
  IDEMPOTENCY_KEY_REUSED: 'The Idempotency-Key was used for another request',
};

/** The problem for an error of a result-discussion command (0121). Never the database's text. */
export function resultDiscussionProblem(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message : '';
  const cause = { cause: error };
  switch (code) {
    case '42501':
      if (message === 'PERMISSION_DENIED') return new DomainProblem(403, 'PERMISSION_DENIED', 'Required Lab permission is missing', undefined, cause);
      if (message === 'PATIENT_ACCESS_DENIED') return new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient access is not authorized', undefined, cause);
      if (message === 'PURPOSE_OF_USE_REQUIRED') return new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'Direct care is required', undefined, cause);
      return unavailable(error);
    case '22023':
      return new DomainProblem(400, 'RESULT_DISCUSSION_INVALID', 'The request is invalid', undefined, cause);
    case 'P0002':
      return new DomainProblem(404, 'RESULT_NOT_FOUND', 'The result was not found', undefined, cause);
    case 'P0001': {
      const detail = CONFLICTS[message];
      return detail ? new DomainProblem(409, message, detail, undefined, cause) : unavailable(error);
    }
    default:
      return unavailable(error);
  }
}

@Injectable()
export class ResultDiscussionsService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  /** GET lab/patients/:patientId/result-discussions: the patient's gated results this facility can see, with their marks. */
  async list(request: HidRequest, patientId: string): Promise<{ results: ResultDiscussionItem[]; truncated: boolean }> {
    const context = this.context(request);
    const resource = { resourceType: 'released-result-collection', resourceId: patientId, patientId };
    return this.audited(context, 'lab.result.discussion.list', resource, {}, async (client) => {
      // Every released result, newest first: the gate is applied here, so the cut comes after it
      // (an older sensitive result must not fall behind newer ungated ones).
      const rows = (await client.query<ListRow>('select * from lab.list_result_discussions($1)', [patientId])).rows;
      const gated = rows.flatMap((row) => {
        const gate = isGatedLabResult(row.test_name, row.test_code, row.test_code_system, row.abnormal_flag);
        return gate.sensitive || gate.critical ? [listItem(row, gate)] : [];
      });
      const truncated = gated.length > RESULT_DISCUSSION_LIST_LIMIT;
      const results = truncated ? gated.slice(0, RESULT_DISCUSSION_LIST_LIMIT) : gated;
      return { value: { results, truncated }, details: { recordCount: results.length, truncated } };
    });
  }

  /** POST .../results/:resultId/discussion: marks that released version as discussed with the patient. */
  async record(request: HidRequest, patientId: string, resultId: string, input: RecordResultDiscussionDto, idempotencyKey: string) {
    const context = this.context(request);
    const resultVersion = input.resultVersion;
    const digest = requestDigest('lab.result.discussion.record', { patientId, resultId, resultVersion });
    const resource = { resourceType: 'lab-result', resourceId: resultId, patientId };
    return this.audited(context, 'lab.result.discussion.record', resource, { resultVersion }, async (client) => {
      const row = (await client.query<CommandRow>('select * from lab.record_result_discussion($1,$2,$3,$4,$5)',
        [patientId, resultId, resultVersion, idempotencyKey, digest])).rows[0];
      if (!row || row.state !== 'discussed') throw unavailable();
      const eventNo = Number(row.event_no), replayed = row.replayed === true, finishedVisit = row.finished_visit === true;
      return { value: { resultId, resultVersion, state: 'discussed' as const, eventNo, discussedAt: iso(row.occurred_at),
        visibleToPatient: finishedVisit, replayed },
        details: { resultVersion, eventNo, replayed, finishedVisit } };
    });
  }

  /** POST .../results/:resultId/discussion/withdrawal: withdraws the mark, with a reason code and a reason. */
  async withdraw(request: HidRequest, patientId: string, resultId: string, input: WithdrawResultDiscussionDto, idempotencyKey: string) {
    const context = this.context(request);
    const { resultVersion, reasonCode } = input;
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 8 || reason.length > 500) {
      throw new DomainProblem(400, 'RESULT_DISCUSSION_INVALID', 'A reason of 8 to 500 characters is required');
    }
    // The reason is part of the digest, so a reused key with another reason is refused, but it is never audited.
    const digest = requestDigest('lab.result.discussion.withdraw', { patientId, resultId, resultVersion, reasonCode, reason });
    const resource = { resourceType: 'lab-result', resourceId: resultId, patientId };
    return this.audited(context, 'lab.result.discussion.withdraw', resource, { resultVersion, reasonCode }, async (client) => {
      const row = (await client.query<CommandRow>('select * from lab.withdraw_result_discussion($1,$2,$3,$4,$5,$6,$7)',
        [patientId, resultId, resultVersion, reasonCode, reason, idempotencyKey, digest])).rows[0];
      if (!row || row.state !== 'withdrawn') throw unavailable();
      const eventNo = Number(row.event_no), replayed = row.replayed === true;
      return { value: { resultId, resultVersion, state: 'withdrawn' as const, eventNo, withdrawnAt: iso(row.occurred_at),
        visibleToPatient: false, replayed },
        details: { resultVersion, eventNo, replayed, reasonCode } };
    });
  }

  /** Staff only, under direct care at a facility. */
  private context(request: HidRequest): DataAccessContext {
    if (request.actor?.kind === 'patient' || !request.actor) {
      throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required Lab permission is missing');
    }
    if (request.header('x-purpose-of-use') !== 'direct-care') {
      throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'Direct care is required');
    }
    return requireRequestContext(request, 'direct-care');
  }

  /**
   * Runs the command in one transaction with its success audit row. A refusal
   * rolls the transaction back and is then audited on its own (ids, the
   * problem code and the given details only), before the mapped problem is
   * thrown.
   */
  private async audited<T>(context: DataAccessContext, action: Action, resource: Resource,
    refusalDetails: Record<string, unknown>,
    work: (client: PoolClient) => Promise<{ value: T; details: Record<string, unknown> }>): Promise<T> {
    let problem: DomainProblem;
    try {
      return await this.database.withTransaction(context, async (client) => {
        const { value, details } = await work(client);
        await this.audit.recordWithClient(client, this.event(context, action, 'success', resource, details));
        return value;
      });
    } catch (error) {
      problem = resultDiscussionProblem(error);
    }
    const status = problem.getStatus();
    await this.audit.record(this.event(context, action, status === 403 ? 'denied' : 'failure', resource,
      { ...refusalDetails, code: problem.code, status }));
    throw problem;
  }

  private event(context: DataAccessContext, action: Action, outcome: AuditEventInput['outcome'], resource: Resource,
    details: Record<string, unknown>): AuditEventInput {
    return { correlationId: context.correlationId, actorType: 'staff', actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId, patientId: resource.patientId,
      action, resourceType: resource.resourceType, resourceId: resource.resourceId, outcome, purposeOfUse: context.purposeOfUse,
      details, sourceSystem: 'lab-api' };
  }
}

function listItem(row: ListRow, gate: { sensitive: boolean; critical: boolean }): ResultDiscussionItem {
  const finishedVisit = row.finished_visit === true;
  const state: 'discussed' | 'withdrawn' | null = row.discussion_state === 'discussed' ? 'discussed'
    : row.discussion_state === 'withdrawn' ? 'withdrawn' : null;
  const discussion: ResultDiscussionItem['discussion'] = state && row.discussion_at && row.discussion_by_membership_id && row.discussion_event_no !== null
    ? { state, eventNo: Number(row.discussion_event_no), at: iso(row.discussion_at), byMembershipId: row.discussion_by_membership_id,
      reasonCode: state === 'withdrawn' ? row.withdrawal_reason_code ?? null : null }
    : null;
  return { resultId: row.result_id, resultVersion: Number(row.result_version),
    test: { codeSystem: row.test_code_system, code: row.test_code, name: row.test_name },
    releasedAt: iso(row.released_at), gate, finishedVisit, discussion,
    visibleToPatient: finishedVisit && discussion?.state === 'discussed' };
}
