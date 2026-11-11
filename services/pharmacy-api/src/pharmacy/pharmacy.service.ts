import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { AcceptEhrPrescriptionDto } from './dto/accept-ehr-prescription.dto';
import type { CreateDispensingDto, ReverseDispensingDto } from './dto/dispensing.dto';
import { IMPORT_PAGE_DEFAULT, type ListImportedMedicationsQueryDto, type OcrMedicationImportBatchDto,
  type OcrMedicationImportDto } from './dto/ocr-medication-import.dto';
import { PharmacyOrderRouteAccess, basisDetails } from './order-route-access';
import { PharmacyOrderRouteCards, type OrderRouteCard } from './order-route-cards';

interface WorkItemRow extends QueryResultRow {
  id: string; patient_id: string; facility_id: string; ordering_facility_id: string;
  source_ehr_prescription_id: string; source_ehr_prescription_version: string;
  source_encounter_id: string; source_status: 'active'; status: 'accepted';
  medication_code_system: string | null; medication_code: string | null; medication_display: string;
  dose_quantity: string | null; dose_unit: string | null; route_code: string | null;
  frequency: string; instructions: string; starts_on: string | null; ends_on: string | null;
  prescribed_by: string; prescribed_at: Date; accepted_by: string; accepted_at: Date;
  row_version: string; created_at: Date; request_sha256?: string;
  dispensing_id?: string | null; dispensing_status?: 'dispensed' | null;
  reversal_id?: string | null;
  /** Set when the work item came from another facility's order route (P4c). */
  order_route_id?: string | null;
}

interface DispensingRow extends QueryResultRow {
  id: string; work_item_id: string; work_item_version: string; patient_id: string; facility_id: string;
  medication_code_system: string | null; medication_code: string | null; medication_display: string;
  quantity_dispensed: string; quantity_unit: string; status: 'dispensed'; dispensed_by: string;
  dispensed_at: Date; row_version: string; created_at: Date; request_sha256?: string;
  reversal_id?: string | null; reversed_at?: Date | null;
}

interface ReversalRow extends QueryResultRow {
  id: string; dispensing_id: string; dispensing_version: string; work_item_id: string;
  patient_id: string; facility_id: string; status: 'reversed'; reversed_by: string;
  reversed_at: Date; row_version: string; created_at: Date; request_sha256?: string;
}

interface ImportRow extends QueryResultRow {
  id: string; patient_id: string; facility_id: string; source_type: 'IMPORTED_MEDICATION_EVIDENCE';
  activity_status: 'unknown'; source_document_id: string; ocr_job_id: string; extraction_id: string;
  validation_id: string; validation_version: number; publication_id: string;
  medication_text: string; strength_text: string | null; dose_text: string | null;
  frequency_text: string | null; historical_context: string | null; reviewed_by: string;
  row_version: string; created_at: Date; request_sha256?: string;
}

const WORK_ITEM_SELECT = `select w.*,d.id::text as dispensing_id,d.status as dispensing_status,
  r.id::text as reversal_id from pharmacy.work_items w
  left join pharmacy.dispensings d on d.work_item_id=w.id
  left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id`;

/**
 * The work list (200 rows, as before). A work item is open while it has no
 * dispensing. A reversed dispensing counts as done: a work item takes one
 * dispensing only (0023), so a reversed item cannot be dispensed again and
 * would otherwise stay at the top for good (owner, 2026-11-02, until
 * dispensing again exists). Open work comes first, oldest
 * first, so new and waiting prescriptions always show however much is done,
 * and done work fills the rest, newest first. Before, the oldest 200 rows the
 * member could read were answered whatever their state, so a busy pharmacy
 * stopped seeing new work. One dispensing per work item and one reversal per
 * dispensing (0023), so the joins add no rows. Exported for the tests.
 */
export const WORK_LIST_QUERY = `${WORK_ITEM_SELECT}
  cross join lateral (select d.id is null as open_work) o
  order by o.open_work desc,case when o.open_work then w.accepted_at end asc,case when o.open_work then null else w.accepted_at end desc,
  case when o.open_work then w.id end asc,case when o.open_work then null else w.id end desc limit 200`;

/**
 * One patient's imported medication records at this facility, newest first:
 * $1 patient, $2 facility, $3 cursor (the last record id of the previous page,
 * or null), $4 rows to read. Row-level security (pharmacy_imports_read, 0023)
 * applies as well; the facility filter matches the
 * pharmacy_imported_medication_patient_idx index. A cursor that is not one of
 * this patient's records here answers an empty page. Exported for the tests.
 */
export const PATIENT_IMPORTS_QUERY = `select e.* from pharmacy.imported_medication_evidence e
  where e.patient_id=$1 and e.facility_id=$2
    and ($3::uuid is null or (e.created_at,e.id) < (select c.created_at,c.id
      from pharmacy.imported_medication_evidence c where c.id=$3 and c.patient_id=$1 and c.facility_id=$2))
  order by e.created_at desc,e.id desc limit $4`;

const DISPENSING_SELECT = `select d.*,r.id::text as reversal_id,r.reversed_at
  from pharmacy.dispensings d left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id`;

// Work items, dispensings, reversals and imports are insert-only: a trigger
// refuses every UPDATE and DELETE (0023), and the runtime role has no UPDATE
// on them, so it cannot lock them (42501). The commands take no row locks of
// their own; since 0100 an acceptance's validator, and since 0101 a
// same-facility dispensing's, holds its EHR prescription FOR SHARE until
// commit, so the EHR cannot change it under the acceptance or the dispensing.
// Unique constraints allow one work item per prescription, one dispensing per
// work item, one reversal per dispensing, one import per publication and one
// row per idempotency key; the SERIALIZABLE transaction cancels the loser of a
// race (40001 or 23505), and DatabaseService runs it again, when it replays
// the winner or refuses the request (Phase 4 Stage 9).

/**
 * The dispensing validator refuses a dispensing on an order route from
 * another facility that is not accepted, or past its work window, or whose
 * prescription changed (P4c, SPEC-FINAL §8.5, V9): 23514 on the insert of a
 * route-backed work item's dispensing, answered 409 as the website already
 * handles it (Operations.tsx). A serialization failure is passed on to
 * DatabaseService's retry. Same-facility work: sameFacilityDispensingRefusal.
 */
function routedDispensingRefusal(error: unknown): DomainProblem | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === '23514' ? notDispensable() : undefined;
}

/**
 * Since 0101 the dispensing validator refuses a same-facility work item whose
 * EHR prescription is missing, no longer active, or no longer at the version
 * Pharmacy accepted (cancelled, held, completed, entered in error or changed
 * after the acceptance): 23514 with the message
 * PRESCRIPTION_SOURCE_NOT_DISPENSABLE, answered 409 with the code the website
 * already handles (Operations.tsx, PharmacyRecord.tsx: "Not dispensable"). Only
 * that message: the validator's other 23514 refusals (the dispensing does not
 * match its work item or the session, 0077) pass on unchanged, and a
 * serialization failure goes to DatabaseService's retry.
 */
function sameFacilityDispensingRefusal(error: unknown): DomainProblem | undefined {
  const { code, message } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown };
  return code === '23514' && message === 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE' ? notDispensable() : undefined;
}

function notDispensable(): DomainProblem {
  return new DomainProblem(409, 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE', 'This prescription can no longer be dispensed here');
}

/**
 * The same-facility acceptance refusals pharmacy.validate_work_item raises
 * with 23514, by message, each answered with that message as its code:
 * - PRESCRIPTION_ROUTED (P4c, SPEC-FINAL §7.5): the prescription has a live
 *   route to another facility's pharmacy, 409 as the EHR answers it;
 * - from 0100, the work item must be exactly its ehr.prescriptions row, read
 *   FOR SHARE: none the session may read and write (404), not active (409), at
 *   another version, so it changed since it was read and the client reloads
 *   (409), or any field differs (422).
 * Any other error, the validator's other 23514 messages among them, is passed
 * on unchanged.
 */
const ACCEPTANCE_REFUSALS: Readonly<Record<string, { status: number; detail: string }>> = {
  PRESCRIPTION_ROUTED: { status: 409,
    detail: 'This prescription has been sent to another pharmacy; withdraw it there first' },
  PRESCRIPTION_SOURCE_NOT_FOUND: { status: 404,
    detail: 'The prescription was not found at this facility' },
  PRESCRIPTION_SOURCE_NOT_ACTIVE: { status: 409,
    detail: 'This prescription is no longer active, so Pharmacy did not accept it' },
  PRESCRIPTION_SOURCE_VERSION_MISMATCH: { status: 409,
    detail: 'This prescription changed since it was read; reload it and send it again' },
  PRESCRIPTION_SOURCE_MISMATCH: { status: 422,
    detail: 'The details sent do not match the prescription, so Pharmacy did not accept it' },
};

function acceptanceRefusal(error: unknown): DomainProblem | undefined {
  const { code, message } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown };
  if (code !== '23514' || typeof message !== 'string' || !Object.hasOwn(ACCEPTANCE_REFUSALS, message)) return undefined;
  const { status, detail } = ACCEPTANCE_REFUSALS[message]!;
  return new DomainProblem(status, message, detail);
}

@Injectable()
export class PharmacyService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityService,
    private readonly audit: AuditService, private readonly routeAccess: PharmacyOrderRouteAccess,
    private readonly routeCards: PharmacyOrderRouteCards) {}

  async acceptPrescription(context: DataAccessContext, input: AcceptEhrPrescriptionDto, key: string) {
    if (input.orderingFacilityId !== context.facilityId) throw new DomainProblem(403,
      'PHARMACY_CROSS_FACILITY_ACCEPTANCE_DENIED', 'Only same-facility Pharmacy acceptance is supported');
    if ((input.doseQuantity === undefined) !== (input.doseUnit === undefined)) throw new DomainProblem(400,
      'PHARMACY_DOSE_PAIR_REQUIRED', 'Dose quantity and dose unit must be supplied together');
    if ((input.medicationCodeSystem === undefined) !== (input.medicationCode === undefined)) {
      throw new DomainProblem(400, 'PHARMACY_MEDICATION_CODE_PAIR_REQUIRED',
        'Medication code system and code must be supplied together');
    }
    await this.authorize(input.patientId, context, 'write_records');
    const digest = requestDigest('pharmacy.work-item.accept-ehr-prescription', input);
    return this.database.withTransaction(context, async (client) => {
      const existing = (await client.query<WorkItemRow>(`${WORK_ITEM_SELECT}
        where (w.facility_id=$1 and w.accepted_by=$2 and w.idempotency_key=$3)
          or w.source_ehr_prescription_id=$4`,
      [context.facilityId, context.actor.accountId, key, input.sourceEhrPrescriptionId])).rows[0];
      if (existing) {
        if (existing.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT',
          'Prescription acceptance conflicts with existing Pharmacy work');
        return this.projectWorkItem(existing);
      }
      const inserted = await client.query<WorkItemRow>(`insert into pharmacy.work_items (
        id,patient_id,facility_id,ordering_facility_id,source_ehr_prescription_id,
        source_ehr_prescription_version,source_encounter_id,source_status,medication_code_system,
        medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
        starts_on,ends_on,prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,
        acceptance_reason,idempotency_key,request_sha256,correlation_id
      ) values ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
      returning *`, [randomUUID(), input.patientId, context.facilityId, input.orderingFacilityId,
        input.sourceEhrPrescriptionId, input.sourceEhrPrescriptionVersion, input.sourceEncounterId,
        input.medicationCodeSystem ?? null, input.medicationCode ?? null, input.medicationDisplay,
        input.doseQuantity ?? null, input.doseUnit ?? null, input.routeCode ?? null, input.frequency,
        input.instructions, input.startsOn ?? null, input.endsOn ?? null, input.prescribedBy,
        input.prescribedAt, context.actor.accountId, context.membershipId, input.acceptanceReason,
        key, digest, context.correlationId]).catch((error: unknown) => { throw acceptanceRefusal(error) ?? error; });
      const row = inserted.rows[0];
      if (!row) throw new DomainProblem(503, 'PHARMACY_WORK_ITEM_NOT_CREATED',
        'Pharmacy could not accept the prescription');
      await client.query(`insert into pharmacy.work_item_events (
        work_item_id,patient_id,facility_id,event_version,event_type,actor_id,actor_membership_id,reason,correlation_id
      ) values ($1,$2,$3,1,'prescription_accepted',$4,$5,$6,$7)`, [row.id, row.patient_id,
        row.facility_id, context.actor.accountId, context.membershipId, input.acceptanceReason,
        context.correlationId]);
      await this.outbox(client, 'PharmacyWorkItemCreated', 'pharmacy-work-item', row.id,
        row.facility_id, row.patient_id, context.correlationId, { workItemId: row.id,
          sourceEhrPrescriptionId: row.source_ehr_prescription_id,
          sourceEhrPrescriptionVersion: Number(row.source_ehr_prescription_version), status: 'accepted' });
      await this.audit.recordWithClient(client, context, 'pharmacy.work-item.accept', {
        patientId: row.patient_id, resourceType: 'pharmacy-work-item', resourceId: row.id,
      }, { sourceEhrPrescriptionId: row.source_ehr_prescription_id,
        sourceEhrPrescriptionVersion: Number(row.source_ehr_prescription_version), status: 'accepted' });
      return this.projectWorkItem(row);
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  /**
   * The work list. Row-level security shows this facility's rows the member
   * may read: under consent, or bound to an order route that allows a read
   * now (P4c, strict policy). Open work comes first, oldest first, then done
   * work, newest first, 200 rows in all (WORK_LIST_QUERY); the answer's shape
   * is unchanged. A route-backed row carries its route card and,
   * while the route allows a read, its patient (C18). To a member who may
   * receive prescriptions from other facilities, the answer says whether this
   * facility receives them now and whether any wait or are held here (item 4,
   * 0089; read in the transaction after the audit rows, left out when it
   * cannot be read), and that this backend serves the late correction
   * (`lateCorrection: true`, D17) and "We can't complete this order"
   * (`cannotComplete: true`, D18). The answer also says whether orders
   * between facilities and work on them are on (FEAS R4, V11).
   */
  async listWorkItems(context: DataAccessContext) {
    const page = await this.database.withTransaction(context, async (client) => {
      const result = await client.query<WorkItemRow>(WORK_LIST_QUERY);
      await this.audit.recordWithClient(client, context, 'pharmacy.work-item.list', {
        resourceType: 'pharmacy-work-item-collection', resourceId: context.facilityId,
      }, { returnedCount: result.rows.length });
      const cards = await this.routeCards.cards(client, result.rows.filter((row) => row.order_route_id).map((row) => row.id),
        context.correlationId);
      await this.auditShownPatients(client, context, result.rows, cards);
      const receiving = await this.routeCards.receiving(client, context);
      return { items: result.rows.map((row) => this.projectWorkItem(row, cards.get(row.id))), ...receiving,
        ...this.routeCards.lateCorrection(context), ...this.routeCards.cannotComplete(context) };
    });
    return { ...page, ...(await this.routeCards.flags()) };
  }

  /**
   * Who saw which patient on the work list (P4c): a route-backed row's card
   * shows the patient's name, sex, date of birth and Health ID ending, so one
   * row per patient shown, naming the patient, with the work items and routes
   * (ids only, §12) and basis 'order-route', in the list's transaction (no
   * answer without its audit). Rows without a patient on the card name no
   * one; the collection row above stays as it was.
   */
  private async auditShownPatients(client: PoolClient, context: DataAccessContext, rows: readonly WorkItemRow[],
    cards: ReadonlyMap<string, OrderRouteCard>) {
    const shown = new Map<string, { first: WorkItemRow; workItemIds: string[]; orderRouteIds: string[] }>();
    for (const row of rows) {
      const card = cards.get(row.id);
      if (!row.order_route_id || !card?.patient) continue;
      const entry = shown.get(row.patient_id) ?? { first: row, workItemIds: [], orderRouteIds: [] };
      entry.workItemIds.push(row.id);
      entry.orderRouteIds.push(card.orderRoute.id);
      shown.set(row.patient_id, entry);
    }
    for (const [patientId, entry] of shown) {
      await this.audit.recordWithClient(client, context, 'pharmacy.work-item.list', {
        patientId, resourceType: 'pharmacy-work-item', resourceId: entry.first.id,
      }, { basis: 'order-route', workItemIds: entry.workItemIds, orderRouteIds: entry.orderRouteIds });
    }
  }

  async getWorkItem(context: DataAccessContext, id: string) {
    return this.database.withTransaction(context, async (client) => {
      const row = (await client.query<WorkItemRow>(`${WORK_ITEM_SELECT} where w.id=$1`, [id])).rows[0];
      if (!row) return this.routeAccess.hiddenWorkItem(client, id, 'read_records', workItemNotFound);
      const basis = await this.routeAccess.authorize(client, context, 'work_item', row.id, row.patient_id, 'read_records');
      await this.audit.recordWithClient(client, context, 'pharmacy.work-item.read', {
        patientId: row.patient_id, resourceType: 'pharmacy-work-item', resourceId: row.id,
      }, basisDetails(basis));
      const cards = row.order_route_id ? await this.routeCards.cards(client, [row.id], context.correlationId) : undefined;
      return this.projectWorkItem(row, cards?.get(row.id));
    });
  }

  async dispense(context: DataAccessContext, workItemId: string, input: CreateDispensingDto, key: string) {
    return this.database.withTransaction(context, async (client) => {
      const work = (await client.query<WorkItemRow>(`${WORK_ITEM_SELECT} where w.id=$1`,
        [workItemId])).rows[0];
      if (!work) return this.routeAccess.hiddenWorkItem(client, workItemId, 'write_records', workItemNotFound);
      const basis = await this.routeAccess.authorize(client, context, 'work_item', work.id, work.patient_id, 'write_records');
      if (Number(work.row_version) !== input.expectedWorkItemVersion) throw new DomainProblem(412,
        'PHARMACY_WORK_ITEM_VERSION_CONFLICT', 'Dispensing must bind to the exact accepted work-item version');
      const digest = requestDigest('pharmacy.dispensing.create', { workItemId, ...input });
      const existing = (await client.query<DispensingRow>(`${DISPENSING_SELECT}
        where (d.facility_id=$1 and d.dispensed_by=$2 and d.idempotency_key=$3) or d.work_item_id=$4`,
      [context.facilityId, context.actor.accountId, key, workItemId])).rows[0];
      if (existing) {
        if (existing.request_sha256 === digest) return this.projectDispensing(existing);
        throw new DomainProblem(409, 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED',
          'A full dispensing is already recorded for this work item; partial dispensing is not supported');
      }
      const inserted = await client.query<DispensingRow>(`insert into pharmacy.dispensings (
        id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
        medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
        reason,idempotency_key,request_sha256,correlation_id
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
      [randomUUID(), work.id, input.expectedWorkItemVersion, work.patient_id, work.facility_id,
        work.medication_code_system, work.medication_code, work.medication_display,
        input.quantityDispensed, input.quantityUnit, context.actor.accountId, context.membershipId,
        input.reason, key, digest, context.correlationId])
        .catch((error: unknown) => {
          throw (work.order_route_id ? routedDispensingRefusal(error) : sameFacilityDispensingRefusal(error)) ?? error;
        });
      const row = inserted.rows[0];
      if (!row) throw new DomainProblem(503, 'PHARMACY_DISPENSING_NOT_CREATED',
        'Pharmacy could not record the dispensing');
      await this.outbox(client, 'MedicationDispensed', 'medication-dispensing', row.id,
        row.facility_id, row.patient_id, context.correlationId,
        { dispensingId: row.id, workItemId: row.work_item_id, status: 'dispensed' });
      await this.audit.recordWithClient(client, context, 'pharmacy.dispensing.create', {
        patientId: row.patient_id, resourceType: 'medication-dispensing', resourceId: row.id,
      }, { workItemId: row.work_item_id, workItemVersion: Number(row.work_item_version), status: 'dispensed',
        ...basisDetails(basis) });
      return this.projectDispensing(row);
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async getDispensing(context: DataAccessContext, id: string) {
    return this.database.withTransaction(context, async (client) => {
      const row = (await client.query<DispensingRow>(`${DISPENSING_SELECT} where d.id=$1`, [id])).rows[0];
      if (!row) throw new DomainProblem(404, 'PHARMACY_DISPENSING_NOT_FOUND', 'Dispensing was not found');
      const basis = await this.routeAccess.authorize(client, context, 'dispensing', row.id, row.patient_id, 'read_records');
      await this.audit.recordWithClient(client, context, 'pharmacy.dispensing.read', {
        patientId: row.patient_id, resourceType: 'medication-dispensing', resourceId: row.id,
      }, basisDetails(basis));
      return this.projectDispensing(row);
    });
  }

  async reverse(context: DataAccessContext, dispensingId: string, input: ReverseDispensingDto, key: string) {
    return this.database.withTransaction(context, async (client) => {
      const dispensing = (await client.query<DispensingRow>(`${DISPENSING_SELECT}
        where d.id=$1`, [dispensingId])).rows[0];
      if (!dispensing) throw new DomainProblem(404, 'PHARMACY_DISPENSING_NOT_FOUND',
        'Dispensing was not found');
      const basis = await this.routeAccess.authorize(client, context, 'dispensing', dispensing.id, dispensing.patient_id,
        'write_records');
      if (Number(dispensing.row_version) !== input.expectedDispensingVersion) throw new DomainProblem(412,
        'PHARMACY_DISPENSING_VERSION_CONFLICT', 'Reversal must bind to the exact dispensing version');
      const digest = requestDigest('pharmacy.dispensing.reverse', { dispensingId, ...input });
      const existing = (await client.query<ReversalRow>(`select * from pharmacy.dispensing_reversals
        where (facility_id=$1 and reversed_by=$2 and idempotency_key=$3) or dispensing_id=$4`,
      [context.facilityId, context.actor.accountId, key, dispensingId])).rows[0];
      if (existing) {
        if (existing.request_sha256 === digest) return this.projectReversal(existing);
        throw new DomainProblem(409, 'PHARMACY_DISPENSING_ALREADY_REVERSED',
          'This dispensing already has a preserved reversal');
      }
      const inserted = await client.query<ReversalRow>(`insert into pharmacy.dispensing_reversals (
        id,dispensing_id,dispensing_version,work_item_id,patient_id,facility_id,reversed_by,
        reversed_by_membership_id,reason,idempotency_key,request_sha256,correlation_id
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`, [randomUUID(),
        dispensing.id, input.expectedDispensingVersion, dispensing.work_item_id, dispensing.patient_id,
        dispensing.facility_id, context.actor.accountId, context.membershipId, input.reason,
        key, digest, context.correlationId]);
      const row = inserted.rows[0];
      if (!row) throw new DomainProblem(503, 'PHARMACY_REVERSAL_NOT_CREATED',
        'Pharmacy could not record the dispensing reversal');
      await this.outbox(client, 'MedicationDispensingReversed', 'medication-dispensing-reversal',
        row.id, row.facility_id, row.patient_id, context.correlationId,
        { reversalId: row.id, dispensingId: row.dispensing_id, workItemId: row.work_item_id, status: 'reversed' });
      await this.audit.recordWithClient(client, context, 'pharmacy.dispensing.reverse', {
        patientId: row.patient_id, resourceType: 'medication-dispensing-reversal', resourceId: row.id,
      }, { dispensingId: row.dispensing_id, dispensingVersion: Number(row.dispensing_version), status: 'reversed',
        ...basisDetails(basis) });
      return this.projectReversal(row);
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async createImport(context: DataAccessContext, input: OcrMedicationImportDto, key: string) {
    await this.authorize(input.patientId, context, 'write_records');
    const digest = requestDigest('pharmacy.imported-medication-evidence.create', input);
    return this.database.withTransaction(context, async (client) => {
      const existing = (await client.query<ImportRow>(`select * from pharmacy.imported_medication_evidence
        where (facility_id=$1 and created_by=$2 and idempotency_key=$3) or publication_id=$4`,
      [context.facilityId, context.actor.accountId, key, input.publicationId])).rows[0];
      if (existing) {
        if (existing.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was used for different imported medication evidence');
        return this.projectImport(existing);
      }
      const inserted = await client.query<ImportRow>(`insert into pharmacy.imported_medication_evidence (
        id,patient_id,facility_id,source_document_id,ocr_job_id,extraction_id,validation_id,
        validation_version,publication_id,medication_text,strength_text,dose_text,frequency_text,
        historical_context,reviewed_by,created_by,created_by_membership_id,idempotency_key,
        request_sha256,correlation_id
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      returning *`, [randomUUID(), input.patientId, context.facilityId, input.sourceDocumentId,
        input.ocrJobId, input.extractionId, input.validationId, input.validationVersion,
        input.publicationId, input.medicationText, input.strengthText ?? null, input.doseText ?? null,
        input.frequencyText ?? null, input.historicalContext ?? null, input.reviewedBy,
        context.actor.accountId, context.membershipId, key, digest, context.correlationId]);
      const row = inserted.rows[0];
      if (!row) throw new DomainProblem(503, 'PHARMACY_IMPORT_NOT_CREATED',
        'Imported medication evidence could not be created');
      await this.outbox(client, 'PharmacyImportedMedicationEvidenceCreated',
        'imported-medication-evidence', row.id, row.facility_id, row.patient_id, context.correlationId,
        { importedMedicationEvidenceId: row.id, sourceType: 'IMPORTED_MEDICATION_EVIDENCE',
          activityStatus: 'unknown' });
      await this.audit.recordWithClient(client, context, 'pharmacy.import.create', {
        patientId: row.patient_id, resourceType: 'pharmacy-imported-medication-evidence', resourceId: row.id,
      }, { publicationId: row.publication_id, sourceType: row.source_type, activityStatus: row.activity_status });
      return this.projectImport(row);
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  /**
   * Several medicines from one OCR review, each stored as its own row in one
   * SERIALIZABLE transaction: every row is written, or none is.
   *
   * pharmacy.imported_medication_evidence keeps publication_id unique (0023),
   * so a batch row stores a per-medicine id derived from the OCR publication
   * (batchPublicationId) and the idempotency key `<key>:mNN`. For batch rows,
   * publication_id is therefore not the ocr.publications id; validation_id,
   * which is one-to-one with the OCR publication, links every row of the batch.
   */
  async createImportBatch(context: DataAccessContext, input: OcrMedicationImportBatchDto, key: string) {
    await this.authorize(input.patientId, context, 'write_records');
    if (key.length > MAX_BATCH_KEY_LENGTH) {
      throw new DomainProblem(400, 'IDEMPOTENCY_KEY_REQUIRED',
        `Idempotency-Key for a batch must contain at most ${MAX_BATCH_KEY_LENGTH} characters`);
    }
    const digest = requestDigest('pharmacy.imported-medication-evidence.create-batch', input);
    const keys = input.medications.map((_item, index) => batchItemKey(key, index));
    const publicationIds = input.medications.map((_item, index) => batchPublicationId(input.publicationId, index));
    return this.database.withTransaction(context, async (client) => {
      const existing = (await client.query<ImportRow>(`select * from pharmacy.imported_medication_evidence
        where (facility_id=$1 and created_by=$2 and idempotency_key = any($3::text[]))
           or publication_id = any($4::uuid[]) or publication_id=$5
        order by idempotency_key`,
      [context.facilityId, context.actor.accountId, keys, publicationIds, input.publicationId])).rows;
      if (existing.length > 0) {
        const replay = existing.length === keys.length
          && existing.every((row, index) => row.request_sha256 === digest && row.idempotency_key === keys[index]
            && row.publication_id === publicationIds[index]);
        if (!replay) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key or publication was used for different imported medication evidence');
        return this.projectBatch(existing);
      }
      const rows: ImportRow[] = [];
      for (const [index, item] of input.medications.entries()) {
        const inserted = await client.query<ImportRow>(`insert into pharmacy.imported_medication_evidence (
          id,patient_id,facility_id,source_document_id,ocr_job_id,extraction_id,validation_id,
          validation_version,publication_id,medication_text,strength_text,dose_text,frequency_text,
          historical_context,reviewed_by,created_by,created_by_membership_id,idempotency_key,
          request_sha256,correlation_id
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        returning *`, [randomUUID(), input.patientId, context.facilityId, input.sourceDocumentId,
          input.ocrJobId, input.extractionId, input.validationId, input.validationVersion,
          publicationIds[index], item.medicationText, item.strengthText ?? null, item.doseText ?? null,
          item.frequencyText ?? null, item.historicalContext ?? null, input.reviewedBy,
          context.actor.accountId, context.membershipId, keys[index], digest, context.correlationId]);
        const row = inserted.rows[0];
        if (!row) throw new DomainProblem(503, 'PHARMACY_IMPORT_NOT_CREATED',
          'Imported medication evidence could not be created');
        await this.outbox(client, 'PharmacyImportedMedicationEvidenceCreated',
          'imported-medication-evidence', row.id, row.facility_id, row.patient_id, context.correlationId,
          { importedMedicationEvidenceId: row.id, sourceType: 'IMPORTED_MEDICATION_EVIDENCE',
            activityStatus: 'unknown' });
        await this.audit.recordWithClient(client, context, 'pharmacy.import.create', {
          patientId: row.patient_id, resourceType: 'pharmacy-imported-medication-evidence', resourceId: row.id,
        }, { publicationId: input.publicationId, validationId: row.validation_id, sourceType: row.source_type,
          activityStatus: row.activity_status, batchIndex: index + 1, batchSize: input.medications.length });
        rows.push(row);
      }
      return this.projectBatch(rows);
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  private projectBatch(rows: readonly ImportRow[]) {
    const items = rows.map((row) => this.projectImport(row));
    return { id: items[0]?.id, count: items.length, items };
  }

  async getImport(context: DataAccessContext, id: string) {
    return this.database.withTransaction(context, async (client) => {
      const row = (await client.query<ImportRow>(
        'select * from pharmacy.imported_medication_evidence where id=$1', [id])).rows[0];
      if (!row) throw new DomainProblem(404, 'PHARMACY_IMPORT_NOT_FOUND',
        'Imported medication evidence was not found');
      await this.authorize(row.patient_id, context, 'read_records');
      await this.audit.recordWithClient(client, context, 'pharmacy.import.read', {
        patientId: row.patient_id, resourceType: 'pharmacy-imported-medication-evidence', resourceId: row.id,
      });
      return this.projectImport(row);
    });
  }

  /**
   * One patient's imported medication records (OCR provenance included),
   * newest first, one bounded page. The same authorization as getImport:
   * Identity `read_records` for this patient at this facility under the
   * request's purpose, checked before any read, so a refusal reads and audits
   * nothing. One audit row naming the patient, with ids and counts only.
   */
  async listImports(context: DataAccessContext, query: ListImportedMedicationsQueryDto) {
    const limit = query.limit ?? IMPORT_PAGE_DEFAULT;
    await this.authorize(query.patientId, context, 'read_records');
    return this.database.withTransaction(context, async (client) => {
      const rows = (await client.query<ImportRow>(PATIENT_IMPORTS_QUERY,
        [query.patientId, context.facilityId, query.cursor ?? null, limit + 1])).rows;
      const page = rows.filter((row) => row.patient_id === query.patientId && row.facility_id === context.facilityId)
        .slice(0, limit);
      const nextCursor = rows.length > limit && page.length === limit ? page[page.length - 1]!.id : null;
      await this.audit.recordWithClient(client, context, 'pharmacy.import.list', {
        patientId: query.patientId, resourceType: 'pharmacy-imported-medication-evidence-collection',
        resourceId: query.patientId,
      }, { returnedCount: page.length, importIds: page.map((row) => row.id), paged: Boolean(query.cursor) });
      return { items: page.map((row) => this.projectImport(row)), nextCursor };
    });
  }

  private async authorize(patientId: string, context: DataAccessContext,
    scope: 'read_records' | 'write_records'): Promise<void> {
    const decision = await this.identity.authorize(patientId, scope, context);
    if (!decision.allowed || (scope === 'write_records' && decision.breakGlass)) {
      throw new DomainProblem(403, 'PHARMACY_ACCESS_DENIED',
        scope === 'write_records' && decision.breakGlass
          ? 'Break-glass authorization cannot mutate Pharmacy records'
          : 'Pharmacy access is not authorized');
    }
  }

  private outbox(client: PoolClient, eventType: string, aggregateType: string, aggregateId: string,
    facilityId: string, patientId: string, correlationId: string, payload: Record<string, unknown>) {
    return client.query(`insert into pharmacy.outbox_events (
      event_type,aggregate_type,aggregate_id,aggregate_version,facility_id,patient_id,correlation_id,payload
    ) values ($1,$2,$3,1,$4,$5,$6,$7::jsonb)`, [eventType, aggregateType, aggregateId,
      facilityId, patientId, correlationId, JSON.stringify(payload)]);
  }

  /**
   * A work item as Pharmacy answers it. A route-backed one (P4c) never carries
   * the other facility's prescription or encounter id (PRIV P4.3); it carries
   * its route card, and its patient only while the route allows a read.
   */
  private projectWorkItem(row: WorkItemRow, card?: OrderRouteCard) {
    const source = row.order_route_id ? {} : { sourceEhrPrescriptionId: row.source_ehr_prescription_id,
      sourceEncounterId: row.source_encounter_id };
    const route = row.order_route_id && card
      ? { orderRoute: card.orderRoute, ...(card.patient ? { patient: card.patient } : {}) } : {};
    return { id: row.id, patientId: row.patient_id, facilityId: row.facility_id, ...source,
      sourceEhrPrescriptionVersion: Number(row.source_ehr_prescription_version),
      status: 'accepted' as const, ...route,
      medication: { codeSystem: row.medication_code_system, code: row.medication_code,
        display: row.medication_display }, doseQuantity: row.dose_quantity === null ? null : Number(row.dose_quantity),
      doseUnit: row.dose_unit, routeCode: row.route_code, frequency: row.frequency,
      instructions: row.instructions, acceptedAt: row.accepted_at, version: Number(row.row_version),
      dispensing: row.dispensing_id ? { id: row.dispensing_id, status: row.dispensing_status,
        reversed: Boolean(row.reversal_id) } : null };
  }

  private projectDispensing(row: DispensingRow) {
    return { id: row.id, workItemId: row.work_item_id, patientId: row.patient_id,
      facilityId: row.facility_id, status: row.status, effectiveStatus: row.reversal_id ? 'reversed' : 'dispensed',
      medication: { codeSystem: row.medication_code_system, code: row.medication_code,
        display: row.medication_display }, quantityDispensed: Number(row.quantity_dispensed),
      quantityUnit: row.quantity_unit, dispensedAt: row.dispensed_at,
      reversalId: row.reversal_id ?? null, version: Number(row.row_version) };
  }

  private projectReversal(row: ReversalRow) {
    return { id: row.id, dispensingId: row.dispensing_id, workItemId: row.work_item_id,
      patientId: row.patient_id, facilityId: row.facility_id, status: row.status,
      reversedAt: row.reversed_at, version: Number(row.row_version) };
  }

  private projectImport(row: ImportRow) {
    return { id: row.id, patientId: row.patient_id, facilityId: row.facility_id,
      sourceType: row.source_type, activityStatus: row.activity_status,
      medicationText: row.medication_text, strengthText: row.strength_text,
      doseText: row.dose_text, frequencyText: row.frequency_text,
      historicalContext: row.historical_context, sourceDocumentId: row.source_document_id,
      ocrJobId: row.ocr_job_id, extractionId: row.extraction_id, validationId: row.validation_id,
      validationVersion: row.validation_version, publicationId: row.publication_id,
      version: Number(row.row_version), createdAt: row.created_at };
  }
}

/** Leaves room for ':mNN' within the 128 characters the idempotency_key CHECK allows (0023). */
export const MAX_BATCH_KEY_LENGTH = 120;

/** The idempotency key of medicine `index` (0-based) of a batch: `<key>:m01` ... `<key>:m50`. */
export function batchItemKey(key: string, index: number): string {
  return `${key}:m${String(index + 1).padStart(2, '0')}`;
}

/** Fixed namespace for the per-medicine publication ids of a batch. Never change it. */
const BATCH_PUBLICATION_NAMESPACE = '6f3b0c52-9d1e-4f7a-b8c2-5e4d3a2b1c0f';

/**
 * The publication_id stored on medicine `index` (0-based) of a batch: a UUID
 * version 5 (RFC 9562, SHA-1) of `<publicationId>:<NN>` in a fixed namespace,
 * so a replay derives the same ids.
 */
export function batchPublicationId(publicationId: string, index: number): string {
  const namespace = Buffer.from(BATCH_PUBLICATION_NAMESPACE.replace(/-/g, ''), 'hex');
  const name = Buffer.from(`${publicationId.toLowerCase()}:${String(index + 1).padStart(2, '0')}`, 'utf8');
  const bytes = createHash('sha1').update(Buffer.concat([namespace, name])).digest().subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function workItemNotFound(): DomainProblem {
  return new DomainProblem(404, 'PHARMACY_WORK_ITEM_NOT_FOUND', 'Pharmacy work item was not found');
}
