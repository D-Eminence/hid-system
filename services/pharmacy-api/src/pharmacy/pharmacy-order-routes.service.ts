import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { AcceptOrderRouteDto, DeclineOrderRouteDto, ListOrderRoutesQueryDto, SearchOrderRoutesDto }
  from './dto/order-route.dto';
import {
  incomingPrescriptionRoute,
  orderRouteUnavailable,
  pharmacyOrderRouteProblem,
  prescriptionRouteDetail,
  recentPrescriptionRoute,
  resultRefusal,
  routePatient,
  type Row,
} from './pharmacy-order-route.mapping';
import { PharmacyOrderRouteCards } from './order-route-cards';

/** A Health ID as identity.patients stores it (NMIG 0002:187), after upper(btrim()). */
const HEALTH_ID = /^HID-[A-HJ-NP-Z2-9]{6,32}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A route's reference as C15 compares it (8 characters of its id, upper-cased). */
const REFERENCE = /^[0-9A-F]{8}$/;

/** The refused results C15 commits (V6), with the audit outcome and the route's state after them. */
const REFUSED: Readonly<Record<string, { outcome: 'denied' | 'failure'; state: string }>> = {
  patient_mismatch: { outcome: 'denied', state: 'sent' },
  accept_locked: { outcome: 'denied', state: 'sent' },
  order_in_work: { outcome: 'failure', state: 'withdrawn' },
  expired: { outcome: 'failure', state: 'expired' },
};

const invalid = (detail: string) => new DomainProblem(400, 'ORDER_ROUTE_INVALID', detail);

/** The identifier as C15 compares it: a Health ID upper-cased and trimmed, or a calendar date. */
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

/** The Health ID a counter finds a patient's orders by, upper-cased and checked, or null for none. */
function healthIdFilter(value: string | undefined): string | null {
  if (value === undefined) return null;
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
 * The pharmacy's side of prescriptions other facilities send (P4c,
 * SPEC-FINAL §4, §9.3, §10.2): Incoming and Recent (C13), one route (C14),
 * acceptance with the patient's identifier and a reason (C15) and decline
 * (C16). READ COMMITTED (R3); each writes its audit row (§12) in its
 * transaction, naming no patient for a route not accepted here (PRIV P4.1).
 */
@Injectable()
export class PharmacyOrderRoutesService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService,
    private readonly cards: PharmacyOrderRouteCards) {}

  /** GET pharmacy/order-routes: Incoming or Recent; its healthId parameter is deprecated (CODEX §26). */
  async list(context: DataAccessContext, query: ListOrderRoutesQueryDto) {
    return this.listed(context, query.view ?? 'incoming', healthIdFilter(query.healthId));
  }

  /** POST pharmacy/order-routes/search: the same, found by the patient's Health ID from the body, never a URL. */
  async search(context: DataAccessContext, input: SearchOrderRoutesDto) {
    return this.listed(context, input.view ?? 'incoming', healthIdFilter(input.healthId));
  }

  private async listed(context: DataAccessContext, view: 'incoming' | 'recent', healthId: string | null) {
    const items = await this.run(context, async (client) => {
      const result = await client.query<Row>('select * from pharmacy.list_order_routes($1, $2)', [view, healthId]);
      const items = result.rows.map((row) => (view === 'incoming' ? incomingPrescriptionRoute(row) : recentPrescriptionRoute(row)));
      await this.audit.recordWithClient(client, context, 'pharmacy.order-route.list',
        { resourceType: 'order-route-collection', resourceId: context.facilityId },
        { view, resultCount: items.length, byHealthId: healthId !== null });
      return items;
    });
    return { items, ...(await this.cards.flags()) };
  }

  async get(context: DataAccessContext, routeId: string) {
    return this.run(context, async (client) => {
      const result = await client.query<Row>('select * from pharmacy.get_order_route($1)', [routeId]);
      const row = result.rows[0];
      if (!row) throw new DomainProblem(404, 'ORDER_ROUTE_NOT_FOUND', 'The order route was not found');
      const detail = prescriptionRouteDetail(row);
      const patientId = detail.patient && detail.workItemId ? await this.workItemPatient(client, detail.workItemId) : undefined;
      await this.audit.recordWithClient(client, context, 'pharmacy.order-route.read',
        { resourceType: 'order-route', resourceId: routeId, ...(patientId ? { patientId } : {}) },
        { routeId, kind: 'prescription', state: detail.effectiveState });
      return detail;
    });
  }

  async accept(context: DataAccessContext, routeId: string, input: AcceptOrderRouteDto, idempotencyKey: string) {
    const identifierKind = input.patientIdentifier.kind;
    const identifier = normalizedIdentifier(identifierKind, input.patientIdentifier.value);
    const reason = input.reason.trim();
    const reference = normalizedReference(input.reference);
    const digest = requestDigest('pharmacy.order-route.accept', { routeId, expectedVersion: input.expectedVersion,
      identifierKind, identifier, reason, ...(reference === null ? {} : { reference }) });
    // A returned refusal commits with its audit row and is answered after the
    // commit (V6); a raised one rolls back.
    const outcome = await this.run(context, async (client) => {
      const result = await client.query<Row>('select * from pharmacy.accept_order_route($1, $2, $3, $4, $5, $6, $7, $8)',
        [routeId, input.expectedVersion, identifierKind, identifier, reason, idempotencyKey, digest, reference]);
      const row = result.rows[0];
      if (!row) throw orderRouteUnavailable();
      const value = typeof row.result === 'string' ? row.result : '';
      const attemptsLeft = row.attempts_left === null || row.attempts_left === undefined ? null : Number(row.attempts_left);
      const workItemId = typeof row.work_item_id === 'string' ? row.work_item_id : null;
      const replayed = row.replayed === true;
      if (value === 'accepted') {
        if (!workItemId) throw orderRouteUnavailable();
        const patientId = await this.workItemPatient(client, workItemId);
        await this.audit.recordWithClient(client, context, 'pharmacy.order-route.accept',
          { resourceType: 'order-route', resourceId: routeId, ...(patientId ? { patientId } : {}) },
          { routeId, kind: 'prescription', state: 'accepted', workItemId, identifierKind, withReference: reference !== null,
            replayed });
        const patient = routePatient(row);
        return { answer: {
          route: { id: routeId, version: Number(row.route_row_version),
            effectiveState: typeof row.effective_state === 'string' ? row.effective_state : 'accepted' },
          workItemId,
          ...(patient ? { patient } : {}),
          instructions: typeof row.instructions === 'string' ? row.instructions : null,
          orderer: { licenceBody: typeof row.orderer_licence_body === 'string' ? row.orderer_licence_body : null,
            licenceNumber: typeof row.orderer_licence_number === 'string' ? row.orderer_licence_number : null },
          replayed,
        } };
      }
      const refusal = resultRefusal(value, attemptsLeft);
      const refused = REFUSED[value];
      if (!refusal || !refused) throw orderRouteUnavailable();
      await this.audit.recordWithClient(client, context, 'pharmacy.order-route.accept',
        { resourceType: 'order-route', resourceId: routeId },
        { routeId, kind: 'prescription', state: refused.state, result: value, identifierKind,
          withReference: reference !== null, ...(value === 'patient_mismatch' ? { attemptsLeft } : {}) }, refused.outcome);
      return { refusal };
    });
    if ('refusal' in outcome) throw outcome.refusal;
    return outcome.answer;
  }

  async decline(context: DataAccessContext, routeId: string, input: DeclineOrderRouteDto) {
    return this.run(context, async (client) => {
      const result = await client.query<{ row_version: string | number; state: string }>(
        'select row_version, state from pharmacy.decline_order_route($1, $2, $3)', [routeId, input.expectedVersion, input.reason]);
      const row = result.rows[0];
      if (!row) throw orderRouteUnavailable();
      await this.audit.recordWithClient(client, context, 'pharmacy.order-route.decline',
        { resourceType: 'order-route', resourceId: routeId },
        { routeId, kind: 'prescription', state: row.state, reason: input.reason });
      return { route: { id: routeId, version: Number(row.row_version), effectiveState: row.state } };
    });
  }

  private async run<Result>(context: DataAccessContext, operation: (client: PoolClient) => Promise<Result>) {
    try {
      return await this.database.withTransaction(context, operation, { isolationLevel: 'READ COMMITTED' });
    } catch (error) {
      throw pharmacyOrderRouteProblem(error);
    }
  }

  /** The accepted route's patient, from its work item (visible while the route allows a read). */
  private async workItemPatient(client: PoolClient, workItemId: string): Promise<string | undefined> {
    const result = await client.query<{ patient_id: string }>(
      'select patient_id::text as patient_id from pharmacy.work_items where id = $1', [workItemId]);
    return result.rows[0]?.patient_id;
  }
}
