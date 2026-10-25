import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { ClinicalRepository } from '../shared/clinical.repository';
import type { SendOrderRouteDto, WithdrawOrderRouteDto } from './dto/order-route.dto';
import {
  orderRouteSummary,
  orderRouteView,
  patientOrderRoute,
  type OrderRouteKind,
  type PatientOrderRoute,
} from './order-route.mapping';
import { orderRouteProblem, orderRouteUnavailable, type OrderRouteScope } from './order-route.problems';

interface SendRow extends QueryResultRow {
  route_id: string;
  reference: string | null;
  state: string;
  row_version: string | number;
  created_at: Date | string;
  respond_by: Date | string;
  receiving_facility_name: string | null;
  order_row_version: string | number;
  order_status: string;
  replayed: boolean;
}

interface WithdrawRow extends QueryResultRow {
  row_version: string | number;
  state: string;
  ended_at: Date | string | null;
  /** Optional: the route's patient, when C2 returns it (checked against the path). */
  patient_id?: string | null;
}

interface StopRow extends QueryResultRow {
  row_version: string | number;
  state: string;
  effective_state: string;
}

const ORDER_TABLE: Readonly<Record<OrderRouteKind, 'lab_requests' | 'prescriptions'>> = {
  lab_request: 'lab_requests',
  prescription: 'prescriptions',
};

/** The write permission of each kind (SPEC-FINAL §3.3): the attestation route checks it per request. */
export const KIND_WRITE_PERMISSION: Readonly<Record<OrderRouteKind, string>> = {
  lab_request: 'ehr.lab-request.write',
  prescription: 'ehr.prescription.write',
};

const ATTESTATION_KIND: Readonly<Record<OrderRouteKind, string>> = {
  lab_request: 'lab',
  prescription: 'prescription',
};

/**
 * The ordering facility's side of cross-facility orders (P4c, SPEC-FINAL
 * §9.1, §10.1) and the patient's list and Stop (§5).
 *
 * - Send (C1) and the order's route views (C3) run in ClinicalRepository.run:
 *   Identity's consent check (write for send, read for views), the clinical
 *   transaction and its staff audit row at A with the patient. The send's row
 *   is the attestation's audit (§3.5, §12).
 * - Withdraw (C2) discloses nothing and needs no consent grant (PRIV P7.1):
 *   a plain staff transaction with its own audit row.
 * - The attestation text (C24): a staff transaction with its own audit row,
 *   no patient.
 * - The patient's routes use the patient-self transaction and a patient
 *   audit row (as GET me/records).
 *
 * Every staff route runs only under `direct-care`, never break-glass (PRIV
 * P10): another purpose is 403 PERMISSION_DENIED before anything is called.
 */
@Injectable()
export class OrderRoutesService {
  constructor(
    private readonly repository: ClinicalRepository,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly identity: IdentityApiService,
  ) {}

  async send(context: DataAccessContext, kind: OrderRouteKind, patientId: string, encounterId: string,
    orderId: string, input: SendOrderRouteDto, idempotencyKey: string) {
    requireDirectCare(context);
    // The text confirmed must be of this kind; C1 also refuses one of the
    // other kind (22023) and an outdated one (ORDER_ROUTE_ATTESTATION_OUTDATED).
    if (!input.attestationTextVersion.startsWith(`order-route-${ATTESTATION_KIND[kind]}-attestation-v`)) {
      throw new DomainProblem(400, 'ORDER_ROUTE_INVALID', 'The attestation text is not of this kind of order');
    }
    const routeId = randomUUID();
    const digest = requestDigest('order-route.send', {
      kind, patientId, encounterId, orderId,
      expectedRowVersion: input.expectedRowVersion,
      receivingFacilityId: input.receivingFacilityId,
      patientAgreed: input.patientAgreed,
      attestationTextVersion: input.attestationTextVersion,
    });
    return this.repository.run(context, patientId, 'write_records', {
      action: 'ehr.order-route.send',
      resourceType: 'order-route',
      details: {
        kind,
        receivingFacilityId: input.receivingFacilityId,
        attestationTextVersion: input.attestationTextVersion,
        patientAgreement: 'clinician_attested',
      },
    }, async (client) => {
      const row = await this.single<SendRow>(client,
        'select * from ehr.send_order_route($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [routeId, kind, patientId, orderId, encounterId, input.expectedRowVersion, input.receivingFacilityId,
          input.attestationTextVersion, idempotencyKey, digest], 'ORDER_NOT_FOUND');
      const replayed = row.replayed === true;
      // C1 answers only these columns. A new route is `sent` and was just
      // checked eligible (H4), so its receiver is available; for a replay the
      // stored route is answered as it is and its receiver's availability now
      // is not known (null): GET .../order-routes reads it (C3).
      const route = orderRouteSummary({
        route_id: row.route_id,
        reference: row.reference,
        kind,
        row_version: row.row_version,
        effective_state: row.state,
        receiving_facility_id: input.receivingFacilityId,
        receiving_facility_name: row.receiving_facility_name,
        receiving_available: replayed ? null : true,
        created_at: row.created_at,
        respond_by: row.respond_by,
      }, kind);
      return {
        value: {
          route,
          order: { id: orderId, status: row.order_status, rowVersion: Number(row.order_row_version) },
          replayed,
        },
        resourceId: row.route_id,
        details: { routeId: row.route_id, replayed },
      };
    });
  }

  /** The order's routes, newest first, with the attestation, events and what came back (C3). */
  async list(context: DataAccessContext, kind: OrderRouteKind, patientId: string, encounterId: string,
    orderId: string) {
    requireDirectCare(context);
    return this.repository.run(context, patientId, 'read_records', {
      action: 'ehr.order-route.list', resourceType: 'order-route', resourceId: orderId, details: { kind },
    }, async (client) => {
      const rows = await this.rows(client, 'select * from ehr.list_order_routes_for_order($1,$2,$3)',
        [kind, patientId, orderId], 'ORDER_NOT_FOUND');
      const items = rows.map((row) => orderRouteView(row, kind));
      return { value: { items }, details: { resultCount: items.length } };
    }, (client) => this.repository.exists(client, ORDER_TABLE[kind], orderId, patientId, context.facilityId,
      encounterId));
  }

  /**
   * The ordering facility withdraws a route before acceptance (C2). Any
   * member holding ehr.order-route.send at the ordering facility, with no
   * consent grant (it discloses nothing). The route's own audit row at A.
   */
  async withdraw(context: DataAccessContext, kind: OrderRouteKind, patientId: string, orderId: string,
    routeId: string, input: WithdrawOrderRouteDto) {
    requireDirectCare(context);
    try {
      return await this.database.withTransaction(context, async (client) => {
        const row = await this.single<WithdrawRow>(client, 'select * from ehr.withdraw_order_route($1,$2,$3,$4,$5)',
          [routeId, kind, orderId, input.expectedVersion, input.reason], 'ORDER_ROUTE_NOT_FOUND');
        // C2 binds the route to the order and the ordering facility, not to
        // the path's patient, and withdrawal reads nothing under consent, so
        // the EHR cannot check that patient itself. C2 is asked to answer the
        // route's patient (services report, "expects from the database"):
        // when it does, the path's patient must be that one, and the audit row
        // below names the route's patient. Without it the row names the path's
        // patient, as the audit interceptor's api.* row does on every route.
        const routePatientId = typeof row.patient_id === 'string' ? row.patient_id : undefined;
        if (routePatientId !== undefined && routePatientId !== patientId) {
          throw new DomainProblem(404, 'ORDER_ROUTE_NOT_FOUND', 'The order route was not found');
        }
        const version = Number(row.row_version);
        await this.audit.recordWithClient(client, {
          correlationId: context.correlationId,
          actorType: 'staff',
          actorSubject: context.actor.subject,
          actorAccountId: context.actor.accountId,
          actorMembershipId: context.membershipId,
          organizationId: context.actor.facility?.organizationId,
          facilityId: context.facilityId,
          patientId,
          action: 'ehr.order-route.withdraw',
          resourceType: 'order-route',
          resourceId: routeId,
          outcome: 'success',
          purposeOfUse: context.purposeOfUse,
          details: { routeId, kind, reason: input.reason, state: row.state, version },
        });
        // OrderRouteSummary's shape, with what C2 answers. The rest (the
        // receiving facility, the dates) would need a read under the patient's
        // consent, which withdrawal does not need; the page reloads the list.
        return { route: orderRouteSummary({ route_id: routeId, kind, row_version: row.row_version,
          effective_state: row.state, ended_at: row.ended_at, ended_kind: 'orderer' }, kind) };
      });
    } catch (error) {
      throw orderRouteProblem(error, 'staff', 'ORDER_ROUTE_NOT_FOUND');
    }
  }

  /** The current attestation text of a kind, for the send screen (C24, §3.5). */
  async attestation(context: DataAccessContext, kind: OrderRouteKind) {
    requireDirectCare(context);
    try {
      return await this.database.withTransaction(context, async (client) => {
        const row = await this.single<{ version: string; text: string }>(client,
          'select version, text from ehr.order_route_attestation_text($1)', [kind], 'ORDER_ROUTE_NOT_FOUND');
        await this.audit.recordWithClient(client, {
          correlationId: context.correlationId,
          actorType: 'staff',
          actorSubject: context.actor.subject,
          actorAccountId: context.actor.accountId,
          actorMembershipId: context.membershipId,
          organizationId: context.actor.facility?.organizationId,
          facilityId: context.facilityId,
          action: 'ehr.order-route.attestation-text.read',
          resourceType: 'order-route-attestation-text',
          resourceId: row.version,
          outcome: 'success',
          purposeOfUse: context.purposeOfUse,
          details: { kind, version: row.version },
        });
        return { kind, version: row.version, text: row.text };
      });
    } catch (error) {
      throw orderRouteProblem(error, 'staff');
    }
  }

  /** The patient's orders sent to other facilities, newest first (C5, §5). */
  async patientList(request: HidRequest) {
    const authorization = await this.authorizeSelf(request);
    try {
      return await this.database.withPatientTransaction(authorization, request.correlationId, async (client) => {
        const items = await this.patientRoutes(client);
        await this.patientAudit(client, request, authorization.patientId, 'ehr.order-route.patient-list', undefined,
          { resultCount: items.length });
        return { items };
      });
    } catch (error) {
      throw orderRouteProblem(error, 'patient');
    }
  }

  /** The patient's Stop of a route before acceptance (C6), answered with the route as C5 lists it. */
  async patientStop(request: HidRequest, routeId: string, expectedVersion: number) {
    const authorization = await this.authorizeSelf(request);
    try {
      return await this.database.withPatientTransaction(authorization, request.correlationId, async (client) => {
        const row = await this.single<StopRow>(client, 'select * from ehr.patient_stop_order_route($1,$2)',
          [routeId, expectedVersion], 'ORDER_ROUTE_NOT_FOUND', 'patient');
        const route = (await this.patientRoutes(client)).find((item) => item.id === routeId);
        await this.patientAudit(client, request, authorization.patientId, 'ehr.order-route.patient-withdraw', routeId,
          { routeId, state: row.state, version: Number(row.row_version) });
        return { route: route ?? stoppedRoute(routeId, row) };
      });
    } catch (error) {
      throw orderRouteProblem(error, 'patient');
    }
  }

  private async patientRoutes(client: PoolClient): Promise<PatientOrderRoute[]> {
    const rows = await this.rows(client, 'select * from ehr.patient_list_order_routes()', [], 'ORDER_ROUTE_NOT_FOUND',
      'patient');
    return rows.map((row) => patientOrderRoute(row));
  }

  /** The session's patient, re-confirmed by Identity (as PatientRecordsService.authorizeSelf). */
  private async authorizeSelf(request: HidRequest) {
    const actor = request.actor;
    if (actor?.kind !== 'patient' || !actor.patientId || !actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
    }
    const authorization = await this.identity.authorizeSelf(request);
    if (authorization.patientId !== actor.patientId || authorization.accountId !== actor.accountId
      || authorization.subject !== actor.subject || authorization.sessionId !== actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
    }
    return authorization;
  }

  private patientAudit(client: PoolClient, request: HidRequest, patientId: string, action: string,
    resourceId: string | undefined, details: Readonly<Record<string, unknown>>) {
    const actor = request.actor!;
    return this.audit.recordWithClient(client, {
      correlationId: request.correlationId,
      actorType: 'patient',
      actorSubject: actor.subject,
      actorAccountId: actor.accountId,
      patientId,
      action,
      resourceType: 'order-route',
      resourceId,
      outcome: 'success',
      purposeOfUse: 'patient-self',
      details,
    });
  }

  /** Rows of a command; its refusals answered as order-route problems (inside the transaction). */
  private async rows(client: PoolClient, sql: string, values: readonly unknown[],
    notFound: 'ORDER_NOT_FOUND' | 'ORDER_ROUTE_NOT_FOUND', scope: OrderRouteScope = 'staff'): Promise<Record<string, unknown>[]> {
    try {
      const result = await client.query<Record<string, unknown>>(sql, [...values]);
      return result.rows;
    } catch (error) {
      throw orderRouteProblem(error, scope, notFound);
    }
  }

  private async single<Row extends QueryResultRow>(client: PoolClient, sql: string, values: readonly unknown[],
    notFound: 'ORDER_NOT_FOUND' | 'ORDER_ROUTE_NOT_FOUND', scope: OrderRouteScope = 'staff'): Promise<Row> {
    const [row] = await this.rows(client, sql, values, notFound, scope);
    if (!row) throw orderRouteUnavailable();
    return row as Row;
  }
}

/** Every staff order-route route runs under direct care only, never break-glass (PRIV P10). */
export function requireDirectCare(context: DataAccessContext): void {
  if (context.purposeOfUse !== 'direct-care') {
    throw new DomainProblem(403, 'PERMISSION_DENIED', 'Orders between facilities need direct care, never emergency access');
  }
}

function stoppedRoute(routeId: string, row: StopRow): Pick<PatientOrderRoute, 'id' | 'version' | 'effectiveState' | 'actions'> {
  return { id: routeId, version: Number(row.row_version), effectiveState: row.effective_state ?? row.state, actions: [] };
}
