import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService, type AuditEventInput } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { AcceptOrderRouteDto, DeclineOrderRouteDto, ListOrderRoutesQueryDto, ReportWrongPatientDto,
  SearchOrderRoutesDto } from './dto/order-route.dto';
import {
  incomingLabRoute,
  labOrderRouteProblem,
  labRouteDetail,
  orderRouteUnavailable,
  recentLabRoute,
  resultRefusal,
  routePatient,
  wrongPatientAnswer,
  wrongPatientProblem,
  type Row,
} from './lab-order-route.mapping';
import { LabOrderRouteCards } from './order-route-cards';

/** A Health ID as identity.patients stores it (NMIG 0002:187), after upper(btrim()). */
const HEALTH_ID = /^HID-[A-HJ-NP-Z2-9]{6,32}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A route's reference as C9 compares it (8 characters of its id, upper-cased). */
const REFERENCE = /^[0-9A-F]{8}$/;

/**
 * The refused results C9 commits (V6), with the audit outcome and the route's
 * state after them: a mismatch and the lock leave it `sent` (P2), an order
 * already in work withdraws it (R10), and a lapsed one is stored `expired`.
 */
const REFUSED: Readonly<Record<string, { outcome: 'denied' | 'failure'; state: string }>> = {
  patient_mismatch: { outcome: 'denied', state: 'sent' },
  accept_locked: { outcome: 'denied', state: 'sent' },
  order_in_work: { outcome: 'failure', state: 'withdrawn' },
  expired: { outcome: 'failure', state: 'expired' },
};

const invalid = (detail: string) => new DomainProblem(400, 'ORDER_ROUTE_INVALID', detail);

/** The identifier as C9 compares it: a Health ID upper-cased and trimmed, or a calendar date. */
export function normalizedIdentifier(kind: 'health_id' | 'date_of_birth', value: string): string {
  const trimmed = value.trim();
  if (kind === 'health_id') {
    const healthId = trimmed.toUpperCase();
    if (!HEALTH_ID.test(healthId)) throw invalid('The Health ID is not in the form HID-XXXXXX');
    return healthId;
  }
  const date = ISO_DATE.exec(trimmed);
  const parsed = date ? new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]))) : undefined;
  if (!date || !parsed || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw invalid('The date of birth must be a calendar date, YYYY-MM-DD');
  }
  return trimmed;
}

/** The Health ID a counter finds a patient's orders by (the search's body), upper-cased and checked. */
function healthIdFilter(value: string): string {
  const healthId = value.trim().toUpperCase();
  if (!HEALTH_ID.test(healthId)) throw invalid('The Health ID is not in the form HID-XXXXXX');
  return healthId;
}

/** The order's reference as the counter typed it, upper-cased, or null when none was given. */
export function normalizedReference(value: string | undefined): string | null {
  if (value === undefined) return null;
  const reference = value.trim().toUpperCase();
  if (!REFERENCE.test(reference)) throw invalid('The reference is the 8 characters shown with the order');
  return reference;
}

/**
 * The laboratory's side of lab requests other facilities send (P4c,
 * SPEC-FINAL §4, §9.2, §10.2): Incoming and Recent (C7), one route (C8),
 * acceptance with the patient's identifier (C9) and decline (C10).
 *
 * Every command runs READ COMMITTED (R3: the route commands lock the route
 * and compare its version; a stale one is 412). Each writes its audit row
 * (§12) in its transaction: rows about a route this facility has not
 * accepted name no patient (PRIV P4.1).
 */
@Injectable()
export class LabOrderRoutesService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService,
    private readonly cards: LabOrderRouteCards) {}

  /** GET lab/order-routes: Incoming or Recent, never by a Health ID (one in its URL is refused, CODEX §26). */
  async list(context: DataAccessContext, query: ListOrderRoutesQueryDto) {
    return this.listed(context, query.view ?? 'incoming', null);
  }

  /** POST lab/order-routes/search: the same, found by the patient's Health ID from the body, never a URL. */
  async search(context: DataAccessContext, input: SearchOrderRoutesDto) {
    return this.listed(context, input.view ?? 'incoming', healthIdFilter(input.healthId));
  }

  /**
   * Incoming or Recent, audited in its transaction. To a member holding
   * lab.order-route.receive (every caller: the routes require it) the answer
   * also says whether this facility receives lab requests from other
   * facilities now and whether any wait or are held here (item 4, 0089), read
   * after the audit row and left out when it cannot be read. While route
   * access is off the list refuses (423) and nothing more is read: the work
   * list, which that switch never refuses, says it then.
   */
  private async listed(context: DataAccessContext, view: 'incoming' | 'recent', healthId: string | null) {
    const { items, receiving } = await this.run(context, async (client) => {
      const result = await client.query<Row>('select * from lab.list_order_routes($1, $2)', [view, healthId]);
      const items = result.rows.map((row) => (view === 'incoming' ? incomingLabRoute(row) : recentLabRoute(row)));
      await this.audit.recordWithClient(client, this.event(context, 'lab.order-route.list', 'success',
        { resourceType: 'order-route-collection', resourceId: context.facilityId },
        { view, resultCount: items.length, byHealthId: healthId !== null }));
      return { items, receiving: await this.cards.receiving(client, context) };
    });
    return { items, ...receiving, ...(await this.cards.flags()) };
  }

  async get(context: DataAccessContext, routeId: string) {
    return this.run(context, async (client) => {
      const result = await client.query<Row>('select * from lab.get_order_route($1)', [routeId]);
      const row = result.rows[0];
      if (!row) throw new DomainProblem(404, 'ORDER_ROUTE_NOT_FOUND', 'The order route was not found');
      const detail = labRouteDetail(row);
      // The patient is named on the row only when the route shows them now
      // (after acceptance, while it allows a read), from the work item.
      const patientId = detail.patient && detail.workItemId ? await this.workItemPatient(client, detail.workItemId) : undefined;
      await this.audit.recordWithClient(client, this.event(context, 'lab.order-route.read', 'success',
        { resourceType: 'order-route', resourceId: routeId, patientId },
        { routeId, kind: 'lab_request', state: detail.effectiveState }));
      return detail;
    });
  }

  async accept(context: DataAccessContext, routeId: string, input: AcceptOrderRouteDto, idempotencyKey: string) {
    const identifierKind = input.patientIdentifier.kind;
    const identifier = normalizedIdentifier(identifierKind, input.patientIdentifier.value);
    const reference = normalizedReference(input.reference);
    const digest = requestDigest('lab.order-route.accept', { routeId, expectedVersion: input.expectedVersion,
      identifierKind, identifier, ...(reference === null ? {} : { reference }) });
    // A refusal the command returns (a mismatch counted, the lock set, the
    // route withdrawn as order_in_work) commits with its audit row and is
    // answered after the commit (V6); a refusal it raises rolls back.
    const outcome = await this.run(context, async (client) => {
      const result = await client.query<Row>('select * from lab.accept_order_route($1, $2, $3, $4, $5, $6, $7)',
        [routeId, input.expectedVersion, identifierKind, identifier, idempotencyKey, digest, reference]);
      const row = result.rows[0];
      if (!row) throw orderRouteUnavailable();
      const value = typeof row.result === 'string' ? row.result : '';
      const attemptsLeft = row.attempts_left === null || row.attempts_left === undefined ? null : Number(row.attempts_left);
      const version = Number(row.route_row_version);
      const workItemId = typeof row.work_item_id === 'string' ? row.work_item_id : null;
      const replayed = row.replayed === true;
      if (value === 'accepted') {
        if (!workItemId) throw orderRouteUnavailable();
        const patientId = await this.workItemPatient(client, workItemId);
        await this.audit.recordWithClient(client, this.event(context, 'lab.order-route.accept', 'success',
          { resourceType: 'order-route', resourceId: routeId, patientId },
          { routeId, kind: 'lab_request', state: 'accepted', workItemId, identifierKind, withReference: reference !== null,
            replayed }));
        const patient = routePatient(row);
        const licenceBody = typeof row.orderer_licence_body === 'string' ? row.orderer_licence_body : null;
        const licenceNumber = typeof row.orderer_licence_number === 'string' ? row.orderer_licence_number : null;
        return { answer: {
          route: { id: routeId, version, effectiveState: typeof row.effective_state === 'string' ? row.effective_state : 'accepted' },
          workItemId,
          ...(patient ? { patient } : {}),
          clinicalInformation: typeof row.clinical_information === 'string' ? row.clinical_information : null,
          orderer: { licenceBody, licenceNumber },
          replayed,
        } };
      }
      const refusal = resultRefusal(value, attemptsLeft);
      if (!refusal || !REFUSED[value]) throw orderRouteUnavailable();
      await this.audit.recordWithClient(client, this.event(context, 'lab.order-route.accept', REFUSED[value]!.outcome,
        { resourceType: 'order-route', resourceId: routeId },
        { routeId, kind: 'lab_request', state: REFUSED[value]!.state, result: value, identifierKind,
          withReference: reference !== null, ...(value === 'patient_mismatch' ? { attemptsLeft } : {}) }));
      return { refusal };
    });
    if ('refusal' in outcome) throw outcome.refusal;
    return outcome.answer;
  }

  async decline(context: DataAccessContext, routeId: string, input: DeclineOrderRouteDto) {
    return this.run(context, async (client) => {
      const result = await client.query<{ row_version: string | number; state: string }>(
        'select row_version, state from lab.decline_order_route($1, $2, $3)', [routeId, input.expectedVersion, input.reason]);
      const row = result.rows[0];
      if (!row) throw orderRouteUnavailable();
      await this.audit.recordWithClient(client, this.event(context, 'lab.order-route.decline', 'success',
        { resourceType: 'order-route', resourceId: routeId },
        { routeId, kind: 'lab_request', state: row.state, reason: input.reason }));
      return { route: { id: routeId, version: Number(row.row_version), effectiveState: row.state } };
    });
  }

  /**
   * The laboratory accepted this order for someone who was not its patient
   * (C25, SPEC-FINAL item 3 §4.3, §7.1). One READ COMMITTED transaction, run
   * once: the command ends the route's access, withdraws every result that
   * went back, records the report for support and tells the patient; this
   * writes the laboratory's own audit row with the patient (from the command)
   * and the counts, never the note (D7). A replay (same member, key and
   * request) answers the route as it is now and the counts of the first.
   */
  async reportWrongPatient(context: DataAccessContext, routeId: string, input: ReportWrongPatientDto,
    idempotencyKey: string) {
    const note = input.note.trim();
    if (note.length < 8 || note.length > 500) throw invalid('The note for Health ID support must be 8 to 500 characters');
    const digest = requestDigest('lab.order-route.wrong-patient',
      { routeId, expectedVersion: input.expectedVersion, reason: input.reason, note });
    try {
      return await this.database.withTransaction(context, async (client) => {
        const result = await client.query<Row>('select * from lab.report_wrong_patient_order_route($1, $2, $3, $4, $5, $6)',
          [routeId, input.expectedVersion, input.reason, note, idempotencyKey, digest]);
        const row = result.rows[0];
        const answer = row ? wrongPatientAnswer(routeId, row) : undefined;
        const patientId = typeof row?.patient_id === 'string' ? row.patient_id : undefined;
        if (!row || !answer || !patientId) throw orderRouteUnavailable();
        await this.audit.recordWithClient(client, this.event(context, 'lab.order-route.wrong-patient', 'success',
          { resourceType: 'order-route', resourceId: routeId, patientId },
          { routeId, kind: 'lab_request', reportId: typeof row.report_id === 'string' ? row.report_id : null,
            stateBefore: typeof row.state_before === 'string' ? row.state_before : null,
            state: typeof row.route_state === 'string' ? row.route_state : null, reasonCode: input.reason,
            resultsVoided: answer.resultsVoided, dispensingReversed: answer.dispensingReversed, replayed: answer.replayed }));
        return answer;
      }, { isolationLevel: 'READ COMMITTED' });
    } catch (error) {
      throw wrongPatientProblem(error);
    }
  }

  /** The command in its READ COMMITTED transaction, its refusals answered by code (§11). */
  private async run<Result>(context: DataAccessContext, operation: (client: PoolClient) => Promise<Result>) {
    try {
      return await this.database.withTransaction(context, operation, { isolationLevel: 'READ COMMITTED' });
    } catch (error) {
      throw labOrderRouteProblem(error);
    }
  }

  /** The accepted route's patient, from its work item (visible while the route allows a read). */
  private async workItemPatient(client: PoolClient, workItemId: string): Promise<string | undefined> {
    const result = await client.query<{ patient_id: string }>(
      'select patient_id::text as patient_id from lab.work_items where id = $1', [workItemId]);
    return result.rows[0]?.patient_id;
  }

  private event(context: DataAccessContext, action: string, outcome: AuditEventInput['outcome'],
    resource: { resourceType: string; resourceId: string; patientId?: string }, details: Record<string, unknown>): AuditEventInput {
    return { correlationId: context.correlationId, actorType: 'staff', actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId,
      ...(resource.patientId ? { patientId: resource.patientId } : {}), action, resourceType: resource.resourceType,
      resourceId: resource.resourceId, outcome, purposeOfUse: context.purposeOfUse, details, sourceSystem: 'lab-api' };
  }
}
