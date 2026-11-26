import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { AcceptEhrPrescriptionDto } from './dto/accept-ehr-prescription.dto';
import type { AcceptWorkItemDto } from './dto/accept-work-item.dto';
import type { ReverseDispensingDto } from './dto/dispensing.dto';
import { IMPORT_PAGE_DEFAULT, type ListImportedMedicationsQueryDto, type OcrMedicationImportBatchDto,
  type OcrMedicationImportDto } from './dto/ocr-medication-import.dto';
import { PharmacyOrderRouteAccess, basisDetails, type ResourceBasis } from './order-route-access';
import { PharmacyOrderRouteCards, type OrderRouteCard, type WorkItemRoutePatient } from './order-route-cards';
import { OWN_WORK_PATIENT_CARDS_OFF, PharmacyOwnWorkPatientCards } from './own-work-patient-cards';
import { OWN_WORK_OFF, PharmacyOwnWork, type OwnWorkState, type OwnWorkWithdrawnReason } from './own-work-access';
import { workListSince } from './work-list-window';
import { PRESCRIPTION_DETAILS_OFF, PharmacyPrescriptionDetails,
  type WorkItemDispensingDetails } from './prescription-dispensing-details';
import { CHANGES_AFTER_DISPENSING_OFF, PharmacyChangesAfterDispensing,
  type ChangedAfterDispensing } from './changes-after-dispensing';
import { DISPENSING_KEY_CONSTRAINT, FILL_KEY_CONSTRAINT, PharmacyRefills, REFILLS_OFF, type CreateDispensingInput,
  type WorkItemRefills, dispensingDigestInput, dispensingKeyConflict, dispensingKeyTaken, fillNumberChanged,
  noRefillsLeft, notLatestFill, refillRefusal, refillsNotRecorded, requestedFill } from './prescription-refills';

interface WorkItemRow extends QueryResultRow {
  id: string; patient_id: string; facility_id: string; ordering_facility_id: string;
  source_ehr_prescription_id: string; source_ehr_prescription_version: string;
  source_encounter_id: string; source_status: 'active'; status: 'accepted';
  medication_code_system: string | null; medication_code: string | null; medication_display: string;
  dose_quantity: string | null; dose_unit: string | null; route_code: string | null;
  frequency: string; instructions: string; starts_on: string | null; ends_on: string | null;
  prescribed_by: string; prescribed_at: Date; accepted_by: string; accepted_by_membership_id: string; accepted_at: Date;
  row_version: string; created_at: Date; request_sha256?: string;
  dispensing_id?: string | null; dispensing_status?: 'dispensed' | null;
  reversal_id?: string | null;
  /** Set when the work item came from another facility's order route (P4c). */
  order_route_id?: string | null;
  /** ORD-12 (0154): the latest fill's number and time, and how many fills the item has (reversed ones included). */
  dispensing_fill_number?: number | string | null;
  last_filled_at?: Date | null;
  fills_recorded?: number | string | null;
}

interface DispensingRow extends QueryResultRow {
  id: string; work_item_id: string; work_item_version: string; patient_id: string; facility_id: string;
  medication_code_system: string | null; medication_code: string | null; medication_display: string;
  quantity_dispensed: string; quantity_unit: string; status: 'dispensed'; dispensed_by: string;
  dispensed_at: Date; row_version: string; created_at: Date; request_sha256?: string;
  reversal_id?: string | null; reversed_at?: Date | null;
  /** 0154: 1 for the first fill, 2 and above for refills. */
  fill_number?: number | string | null;
  /** DISPENSING_REPLAY_QUERY: recorded under this member's Idempotency-Key here. */
  by_key?: boolean;
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

/**
 * A work item, once, whatever its number of fills (ORD-12, 0154: one
 * dispensing per fill, so a plain join would answer the item once per fill):
 * its latest fill (the highest fill number) as `dispensing_id`,
 * `dispensing_status` and `reversal_id` (that fill's reversal), with its
 * number and time, and `fills_recorded`, how many fills it has, a reversed
 * fill included. One probe of 0154's key per item; one reversal per
 * dispensing (0023), so the reversal join adds no rows. Unconditional: it
 * does not depend on PRESCRIPTION_REFILLS_ENABLED, because a fill recorded
 * while the setting was on stays when it is turned off. It needs 0154's
 * `fill_number` (0154 comes before this image; once any refill is recorded,
 * pharmacy-api must not roll back below it). Exported for the tests.
 */
export const WORK_ITEM_SELECT = `select w.*,d.id::text as dispensing_id,d.status as dispensing_status,
  r.id::text as reversal_id,d.fill_number as dispensing_fill_number,d.dispensed_at as last_filled_at,
  coalesce(d.fills_recorded,0) as fills_recorded from pharmacy.work_items w
  left join lateral (select df.id,df.status,df.fill_number,df.dispensed_at,(count(*) over ())::integer as fills_recorded
    from pharmacy.dispensings df where df.work_item_id=w.id order by df.fill_number desc limit 1) d on true
  left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id`;

/**
 * Which rows the list reaches (owner decision Q123 A): open work of any age,
 * and done work received (`accepted_at`) on or after the Lagos midnight that
 * starts the day in `$1` (YYYY-MM-DD, workListSince()). The same for both list
 * queries, after every other filter and before the order and the limit.
 */
const WORK_LIST_WINDOW = `(o.open_work or w.accepted_at >= ($1::date::timestamp at time zone 'Africa/Lagos'))`;

/**
 * Open work first, oldest first, then done work, newest first; 200 rows. The same for both list queries. Among the
 * open work, items waiting for their first fill (oldest received first) come before items with a refill open
 * (ORD-12), so a pharmacy with many refills open still sees every new prescription first; the refills in `$2`'s
 * order, 0154's open refills' (the refill that opened first first). With refills off no item has a refill open.
 */
const WORK_LIST_ORDER = `order by o.open_work desc,o.refill_open asc,case when o.refill_open then array_position($2::uuid[],w.id) end asc,
  case when o.open_work then w.accepted_at end asc,case when o.open_work then null else w.accepted_at end desc,
  case when o.open_work then w.id end asc,case when o.open_work then null else w.id end desc limit 200`;

/**
 * The work list (200 rows, as before): open work of any age, and done work
 * received on or after the day in `$1` (WORK_LIST_WINDOW, Q123 A). A work
 * item is open while it has no dispensing, or (ORD-12, refills on) while it is
 * one of `$2`, the own items 0154's open refills
 * (pharmacy.open_refill_work_items) names; `$2` is empty while refills are
 * off. A reversed dispensing counts as done unless a
 * refill is open: a reversed fill still counts as a fill (0154), so a reversed
 * item with no refill open cannot be dispensed again and would otherwise stay
 * at the top for good (owner, 2026-11-02). Open work comes first, oldest
 * first, so new and waiting prescriptions always show however much is done,
 * and done work fills the rest, newest first. Before, the oldest 200 rows the
 * member could read were answered whatever their state, so a busy pharmacy
 * stopped seeing new work. One row per work item, whatever its number of
 * fills (WORK_ITEM_SELECT). Exported for the tests.
 *
 * Cost. With OWN_WORK_PATIENT_CARD_ENABLED on, each list load also calls
 * pharmacy.work_item_patient_cards (0124) once for its own rows, at most 200,
 * as a statement of its own. Under a NOBYPASSRLS owner, as in production,
 * each of those rows pays the work items' read policy and then the same
 * consent test again (0124's header, D5): 0.6-1.0 s for 200 rows, against
 * about 0.6 s for this query (PostgreSQL 16, a shared 4-CPU 2.8 GHz Xeon). So
 * the setting roughly doubles the list's database time. With
 * PRESCRIPTION_DISPENSING_DETAILS_ENABLED on, it also calls
 * pharmacy.work_item_prescription_details (0125) once for the same own rows,
 * a statement of its own; under a NOBYPASSRLS owner each row then pays the
 * work items' read policy, the consent test and the snapshot table's read
 * policy once (the reader joins the snapshot by its key, so the prescription
 * history does not add to it): 1.0-1.7 s for 200 rows, against 0.4-0.7 s for
 * reading the same rows under row-level security (INTERFACE_CONTRACT.md §46).
 * With PRESCRIPTION_REFILLS_ENABLED on (ORD-12, 0154), each list load also
 * asks pharmacy.open_refill_work_items once before this query, under its own
 * 3-second limit (OPEN_REFILLS_TIMEOUT_MS, kept as a guard), and
 * pharmacy.work_item_refills once after it, for the own rows shown (at most
 * 200), under the same limit (a session on consent alone pays the consent
 * test about 3 times an item there: about 0.8-0.9 s for 200 own items it may
 * read). Both read ehr.prescriptions under 0154's refill scan marker (the
 * clinical owner's D8, 24 November 2026), so that table's read policies no
 * longer run per row under a NOBYPASSRLS owner (about 10 ms a row before).
 * The open refills read the facility's prescriptions that allow refills and
 * were written in the last 365 Lagos days: under a NOBYPASSRLS owner, every
 * one of them, ended or not, the last day checked on each (about 10
 * microseconds a row; only an owner that bypasses row-level security leaves
 * the ended ones out inside the index), and a prescription leaves the set on
 * its refills' last day at the latest (D9), so their cost no longer grows
 * with the facility's history. They ask the work items' read policies only of
 * the due items they answer (at most 200 passing), so their cost does not
 * grow with how many refills are open at once; what grows is the work items'
 * and the fills' own row-level security on the live refill prescriptions,
 * about 0.15 ms each for a pharmacist on the own-work basis (a clinician or a
 * nurse, who may list on consent alone, pays the consent test there instead,
 * about 1.5-3.9 ms each: OPEN_REFILLS_TIMEOUT_MS). The whole request
 * (listWorkItems, every reader on, a pharmacist),
 * measured on 20,000 own items, 11 loads, under a NOSUPERUSER NOBYPASSRLS
 * owner: with 200 refills open at once 3.7-4.3 s (8.2-9.8 s before D8; the
 * open refills 0.07-0.10 s, this query 2.8-3.4 s, the per-item reader
 * 0.06-0.08 s, 0133's states 0.37-0.51 s, the audit rows 0.11-0.20 s, the
 * rest under 0.05 s each: that fixture gave 0124's and 0125's readers almost
 * nothing to answer, so add their costs above where they do); with 2,000
 * open at once 3.9-4.3 s (the open refills 0.32-0.37 s), with 10,000
 * 5.0-5.5 s (1.49-1.67 s), no load past the 3-second limit; under a
 * superuser owner 2.9-3.4 s at each. The
 * setting goes on only after the whole request is measured at the hospital's
 * numbers and the cost accepted in writing, and both staff front ends are
 * ready (INTERFACE_CONTRACT.md, ORD-12, "Before the setting goes on").
 */
export const WORK_LIST_QUERY = `${WORK_ITEM_SELECT}
  cross join lateral (select d.id is null or w.id=any($2::uuid[]) as open_work,
    d.id is not null and w.id=any($2::uuid[]) as refill_open) o
  where ${WORK_LIST_WINDOW}
  ${WORK_LIST_ORDER}`;

/**
 * The work list on a schema with 0133 (D14, owner's Q121 A): WORK_LIST_QUERY,
 * except for this facility's own items that can no longer be dispensed here,
 * which pharmacy.own_withdrawn_work_items() names (called once, as a
 * materialized CTE; ids and reasons only, for a member holding
 * pharmacy.work-item.read here). An own item sent to another facility's
 * pharmacy before it was dispensed (`sent_elsewhere`) is left out before the
 * 200-row limit: it is that pharmacy's work now. An own item whose automatic
 * send was withdrawn (`changed`) stays listed, marked, but counts as done
 * work, newest first, never as open work at the top: it can never be
 * dispensed, and would otherwise fill the oldest open slots for good. A
 * route-backed item is never matched (the reader names own items only, and
 * the join asks for no order route). The projection, the window (so a
 * withdrawn item received before `$1` is left out like other done work), the
 * order and the limit are WORK_LIST_QUERY's, and so is `$2` (ORD-12: an
 * own item with a refill open is open work). Exported for the tests.
 */
export const WORK_LIST_QUERY_0133 = `with withdrawn as materialized (select x.work_item_id, x.withdrawn_reason
    from pharmacy.own_withdrawn_work_items() x)
  ${WORK_ITEM_SELECT}
  left join withdrawn x on x.work_item_id=w.id and w.order_route_id is null
  cross join lateral (select (d.id is null and x.work_item_id is null) or w.id=any($2::uuid[]) as open_work,
    d.id is not null and w.id=any($2::uuid[]) as refill_open) o
  where x.withdrawn_reason is distinct from 'sent_elsewhere'
    and ${WORK_LIST_WINDOW}
  ${WORK_LIST_ORDER}`;

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

/**
 * A dispensing request's replay (ORD-12): what this member's Idempotency-Key
 * recorded here ($1 facility, $2 account, $3 key; 0023's key), `by_key`, and
 * the fill this request asks to record ($4 work item, $5 fill number; 0154's
 * key). At most two rows, the key's first. Exported for the tests.
 */
export const DISPENSING_REPLAY_QUERY = `select d.*,r.id::text as reversal_id,r.reversed_at,
  (d.facility_id=$1 and d.dispensed_by=$2 and d.idempotency_key=$3) as by_key
  from pharmacy.dispensings d left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id
  where (d.facility_id=$1 and d.dispensed_by=$2 and d.idempotency_key=$3) or (d.work_item_id=$4 and d.fill_number=$5)
  order by by_key desc`;

/** The fill this request records ($17, 0154), after today's columns. Exported for the tests. */
export const INSERT_DISPENSING = `insert into pharmacy.dispensings (
        id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
        medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
        reason,idempotency_key,request_sha256,correlation_id,fill_number
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`;

/**
 * ORD-12: whether the item has a fill after this one ($1 work item, $2 fill
 * number): only the latest fill can be reversed. Exported for the tests.
 */
export const LATER_FILL_QUERY = `select exists (select 1 from pharmacy.dispensings df
  where df.work_item_id=$1 and df.fill_number>$2) as later`;

/**
 * ORD-4: where a work item is in this pharmacy's own steps, as the list, a
 * single read and the accept route answer it (`pharmacyStep`):
 * - received: this facility's own item, sent automatically when its
 *   prescription was activated (0133), that no pharmacist has accepted yet;
 * - accepted: a pharmacist here accepted it, and it is not dispensed;
 * - dispensed, dispensing_reversed: as `dispensing` says.
 * `status: 'accepted'` and `acceptedAt` keep their meaning ("the pharmacy has
 * it", "when it arrived"); `withdrawn` stays a separate flag.
 */
export type PharmacyStep = 'received' | 'accepted' | 'dispensed' | 'dispensing_reversed';

/**
 * How an item came to be accepted: 'accept' (POST .../accept), 'dispensing'
 * (its first dispensing accepted a received item), 'order_route' (another
 * facility's prescription, accepted with its route: the work item's own
 * accepted_by and accepted_at, 0086) or 'hand_off' (an own item a pharmacist
 * brought in by hand, accept-ehr-prescription: the same, from the work item).
 */
export type PharmacistAcceptedWith = 'accept' | 'dispensing' | 'order_route' | 'hand_off';

export interface PharmacistAcceptance {
  acceptedAt: Date;
  acceptedByMembershipId: string;
  acceptedWith: PharmacistAcceptedWith;
}

/** The answer of POST .../accept: 201 when this call recorded the acceptance (`alreadyAccepted: false`), else 200. */
export interface WorkItemAcceptanceAnswer {
  workItemId: string;
  pharmacyStep: PharmacyStep;
  pharmacistAcceptance: PharmacistAcceptance;
  alreadyAccepted: boolean;
}

/**
 * The reason pharmacy.work_item_events carries on ORD-4's `pharmacist_accepted`
 * event (event_version 2). The acceptance takes no typed reason (FR-1, Q105),
 * so the text is fixed, the same for the accept route and for a dispensing
 * (`accepted_with` on the acceptance row tells the two apart), and 0144's
 * pharmacy.validate_work_item_event() refuses any other (23514). Change both
 * together, or neither. Exported for the tests.
 */
export const PHARMACIST_ACCEPTED_REASON = 'Accepted by the pharmacist';

/**
 * ORD-4: the acceptance this member's Idempotency-Key already recorded here,
 * if any (0023's key rule, one row per facility, account and key, unique on
 * the table): its work item and request digest only. The stored acceptance
 * itself is read through pharmacy.own_work_item_steps. Exported for the tests.
 */
export const ACCEPTANCE_BY_KEY_QUERY = `select work_item_id::text as work_item_id, request_sha256
  from pharmacy.work_item_acceptances where facility_id=$1 and accepted_by=$2 and idempotency_key=$3`;

/**
 * ORD-4: one acceptance per work item (work_item_id unique), insert-only;
 * pharmacy.validate_work_item_acceptance() checks it against the session, the
 * item (own, sent automatically, its claim live and undispensed, the send not
 * withdrawn) and 0101's source check, read FOR SHARE. $7 is 'accept' or
 * 'dispensing'. Exported for the tests.
 */
export const INSERT_ACCEPTANCE = `insert into pharmacy.work_item_acceptances (
    id,work_item_id,patient_id,facility_id,accepted_by,accepted_by_membership_id,accepted_with,
    idempotency_key,request_sha256,correlation_id
  ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  returning accepted_at,accepted_by_membership_id::text as accepted_by_membership_id,accepted_with`;

/**
 * ORD-4: the work item's history gains one `pharmacist_accepted` event
 * (event_version 2, so unique(work_item_id, event_version) keeps it to one),
 * in the acceptance's transaction, written as `prescription_accepted` (version
 * 1) is: the session's account and membership as the actor, the fixed reason.
 * Exported for the tests.
 */
export const INSERT_PHARMACIST_ACCEPTED_EVENT = `insert into pharmacy.work_item_events (
    work_item_id,patient_id,facility_id,event_version,event_type,actor_id,actor_membership_id,reason,correlation_id
  ) values ($1,$2,$3,2,'pharmacist_accepted',$4,$5,$6,$7)`;

interface AcceptanceKeyRow extends QueryResultRow { work_item_id: string; request_sha256: string }

interface AcceptanceRow extends QueryResultRow {
  accepted_at: Date; accepted_by_membership_id: string; accepted_with: 'accept' | 'dispensing';
}

// Work items, dispensings, reversals and imports are insert-only: a trigger
// refuses every UPDATE and DELETE (0023), and the runtime role has no UPDATE
// on them, so it cannot lock them (42501). The commands take no row locks of
// their own; since 0100 an acceptance's validator, and since 0101 a
// same-facility dispensing's, holds its EHR prescription FOR SHARE until
// commit, so the EHR cannot change it under the acceptance or the dispensing.
// Unique constraints allow one own work item and at most one route-backed item
// per prescription (0133), one dispensing per work item and fill number (0154;
// one per work item before it), one reversal per dispensing, one import per
// publication and one row per idempotency key; the SERIALIZABLE transaction cancels the loser of a
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
 *
 * Since 0133 (D14, owner's Q121 A) the database raises the same message, with
 * DETAIL 'sent_elsewhere', for an own item whose prescription was sent to
 * another facility's pharmacy before it was dispensed, whichever image asks.
 * That one answers its own detail and the problem member `withdrawnReason`.
 * There is no check before the insert: the database decides, free of races.
 */
function sameFacilityDispensingRefusal(error: unknown): DomainProblem | undefined {
  const { code, message, detail } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown;
    message?: unknown; detail?: unknown };
  if (code !== '23514' || message !== 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE') return undefined;
  return notDispensable(detail === 'sent_elsewhere' ? 'sent_elsewhere' : undefined);
}

/**
 * ORD-4: an own item that can no longer be dispensed here is not accepted
 * either. The accept route answers it as a dispensing is answered: before
 * the insert from the steps reader's withdrawn flag, with the reason; at the
 * insert from the acceptance trigger's 23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE
 * (0101's source check, read FOR SHARE), whose DETAIL 'sent_elsewhere' or
 * 'changed' (a withdrawn automatic send) answers that reason, as the reader
 * would have, and any other DETAIL ('not_claimed': dispensed meanwhile) or
 * none answers without one. The trigger's other 23514 refusals ('Pharmacist
 * acceptance does not match its work item and actor context';
 * PHARMACY_WORK_ITEM_NOT_SENT_AUTOMATICALLY, DETAIL 'order_route' or
 * 'hand_off') are passed on: the route's own checks before the insert rule
 * them out (the session is the row's; a route-backed or handed-in item is
 * answered from its row and never inserted).
 */
function acceptanceRefusedByTrigger(error: unknown): DomainProblem | undefined {
  const { code, message, detail } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown;
    message?: unknown; detail?: unknown };
  if (code !== '23514' || message !== 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE') return undefined;
  return notDispensable(detail === 'sent_elsewhere' || detail === 'changed' ? detail : undefined);
}

function notDispensable(reason?: OwnWorkWithdrawnReason): DomainProblem {
  if (reason === 'sent_elsewhere') {
    return new DomainProblem(409, 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE',
      'This prescription was sent to another pharmacy, so it can no longer be dispensed here', undefined,
      { extensions: { withdrawnReason: 'sent_elsewhere' } });
  }
  if (reason === 'changed') {
    return new DomainProblem(409, 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE', 'This prescription can no longer be dispensed here',
      undefined, { extensions: { withdrawnReason: 'changed' } });
  }
  return new DomainProblem(409, 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE', 'This prescription can no longer be dispensed here');
}

/**
 * ORD-4 on a schema without its table or reader (42P01, 42883): the accept
 * route answers 503 with words for the person, kept on the 5xx answer.
 */
function acceptanceUnavailable(): DomainProblem {
  return new DomainProblem(503, 'PHARMACY_ACCEPTANCE_UNAVAILABLE',
    'Accepting is not available right now. Please try again.', undefined, { exposeDetail: true });
}

function acceptanceSchemaMissing(error: unknown): boolean {
  const code = sqlState(error);
  return code === '42P01' || code === '42883';
}

/**
 * 0144's unique (facility_id, accepted_by, idempotency_key) on
 * pharmacy.work_item_acceptances, by the name PostgreSQL gave it (0144's
 * post-check pins the index, and its suite the 23505 that names it).
 */
const ACCEPTANCE_KEY_CONSTRAINT = 'work_item_acceptances_facility_id_accepted_by_idempotency_k_key';

/**
 * ORD-4: the acceptance insert met a row already stored under this member's
 * key at this facility (23505 on that key; not on the work item's own unique
 * key, which is the race of two accepts of one item).
 */
function acceptanceKeyTaken(error: unknown): boolean {
  const { code, constraint } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown;
    constraint?: unknown };
  return code === '23505' && constraint === ACCEPTANCE_KEY_CONSTRAINT;
}

/** ORD-4: this member's key at this facility recorded another request (the hand-off's message, reused). */
function acceptanceKeyConflict(): DomainProblem {
  return new DomainProblem(409, 'IDEMPOTENCY_CONFLICT',
    'Prescription acceptance conflicts with existing Pharmacy work');
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
  private readonly logger = new Logger(PharmacyService.name);

  constructor(private readonly database: DatabaseService, private readonly identity: IdentityService,
    private readonly audit: AuditService, private readonly routeAccess: PharmacyOrderRouteAccess,
    private readonly routeCards: PharmacyOrderRouteCards,
    private readonly ownPatients: PharmacyOwnWorkPatientCards = OWN_WORK_PATIENT_CARDS_OFF,
    private readonly prescriptionDetails: PharmacyPrescriptionDetails = PRESCRIPTION_DETAILS_OFF,
    private readonly ownWork: PharmacyOwnWork = OWN_WORK_OFF,
    // Q132 A (0148): the notice on a dispensed item whose prescription changed afterwards. Last and off by
    // default, so every `new PharmacyService(...)` in the specs is unchanged. @Optional because Nest resolves
    // every constructor parameter by its type and ignores the default: a testing module built before Q132
    // (two specs build the service through Nest with a provider for each parameter they knew) has no
    // provider for it, and Nest then passes undefined, which takes the default. PharmacyModule always
    // provides it on (no environment setting, 0133 D12's rule); a test pins that.
    @Optional() private readonly dispensedChanges: PharmacyChangesAfterDispensing = CHANGES_AFTER_DISPENSING_OFF,
    // ORD-12 (0154): recording refills, behind PRESCRIPTION_REFILLS_ENABLED; last, optional and off by default for the
    // same reasons. PharmacyModule provides it from the setting. One row per item, the replay and the latest-fill
    // reversal rule do not depend on it.
    @Optional() private readonly refills: PharmacyRefills = REFILLS_OFF) {}

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
        // 0133: a replay answers an own item as the single-item read does, withdrawn (changed, or
        // sent elsewhere: D14) when it was (no flag when it cannot be read).
        const states = existing.order_route_id ? undefined
          : await this.ownWork.states(client, [existing.id], context.correlationId, 'flag');
        // Q132 A: and, once dispensed, its change after dispensing, as the read answers it (ehr-api passes the
        // answer through unchanged). In practice a replay seldom carries one: any change raises the
        // prescription's row_version, which the digest covers, so a hand-off after a change is the 409 above;
        // only api-client's single immediate retry could meet a notice. The list and the read carry it. The
        // transaction is SERIALIZABLE: a 40001 from the reader is passed on, and DatabaseService runs the whole
        // replay again.
        const changed = existing.dispensing_id
          ? await this.dispensedChanges.changes(client, [existing.id], context.correlationId) : undefined;
        return this.projectWorkItem(existing, undefined, undefined, undefined, states?.get(existing.id),
          changed?.get(existing.id));
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
   * work, newest first, 200 rows in all (WORK_LIST_QUERY). Open work of any
   * age is listed; done work only if received on or after `since`, the Lagos
   * day 90 days before today (Q123 A), which the answer carries. With 0133 (WORK_LIST_QUERY_0133, in a savepoint) an own
   * item sent to another facility's pharmacy is left out and an own item
   * withdrawn on a change counts as done work; on a schema without 0133's
   * reader (42883) the savepoint is rolled back and WORK_LIST_QUERY answers.
   * A route-backed row carries its route card and,
   * while the route allows a read, its patient (C18). This facility's own row
   * carries its patient while OWN_WORK_PATIENT_CARD_ENABLED is on and the
   * member may read it (0124); off, it carries none. While
   * PRESCRIPTION_DISPENSING_DETAILS_ENABLED is on, an own row also carries
   * the prescriber's priority, strength, form, duration and quantity to
   * dispense (0125; no audit row: no new person is shown). To a member who may
   * receive prescriptions from other facilities, the answer says whether this
   * facility receives them now and whether any wait or are held here (item 4,
   * 0089; read in the transaction after the audit rows, left out when it
   * cannot be read), and that this backend serves the late correction
   * (`lateCorrection: true`, D17) and "We can't complete this order"
   * (`cannotComplete: true`, D18). The answer also says whether orders
   * between facilities and work on them are on (FEAS R4, V11). Q132 A
   * (0148): a dispensed row whose prescription was changed afterwards
   * carries `changedAfterDispensing` (projectWorkItem); a change does not
   * move the row (it keeps its place in the done work, by the day it was
   * received, Q123 A).
   *
   * ORD-12 (0154): one row per item, whatever its number of fills, setting on
   * or off (WORK_ITEM_SELECT). While PRESCRIPTION_REFILLS_ENABLED is on, the
   * list first asks 0154's open refills which own items have a refill open
   * now (PharmacyRefills.openForList, at most 200, however many items were
   * filled after them), and those are open work of any age, after the items
   * waiting for their first fill; each own row then carries `refills` (0154's
   * per-item reader, asked once, for the own rows shown), and each row
   * `dispensing.fillNumber` and `lastFilledAt` once dispensed. Both readers
   * run under their own time limit (OPEN_REFILLS_TIMEOUT_MS, a guard), and
   * past it the list answers without them rather than not at all. When either reader fails, the answer says `refillsUnavailable: true`
   * (logged as an error), so a due refill missing from the open work is shown
   * as such ("Refills could not be loaded"). Both readers write 0154's refill
   * scan marker (D8), so this transaction is READ COMMITTED and read-write
   * (DatabaseService's default; never readOnly: a READ ONLY one would refuse
   * them, 25006). Off, nothing is asked and nothing added.
   */
  async listWorkItems(context: DataAccessContext) {
    const since = workListSince();
    const page = await this.database.withTransaction(context, async (client) => {
      // ORD-12: the own items with a refill open, asked before the rows are chosen (nothing while refills are off),
      // under their own time limit; if they cannot be read the list says so (refillsUnavailable).
      const openRefills = await this.refills.openForList(client, context.correlationId);
      const result = await this.workList(client, since, openRefills.ids);
      await this.audit.recordWithClient(client, context, 'pharmacy.work-item.list', {
        resourceType: 'pharmacy-work-item-collection', resourceId: context.facilityId,
      }, { returnedCount: result.rows.length });
      const cards = await this.routeCards.cards(client, result.rows.filter((row) => row.order_route_id).map((row) => row.id),
        context.correlationId);
      const ownIds = result.rows.filter((row) => !row.order_route_id).map((row) => row.id);
      const own = await this.ownPatients.patients(client, ownIds, context.correlationId);
      // 0133: why each own row is seen (consent or own-work) and whether its automatic send was
      // withdrawn; undefined without 0133. A failure fails the list: its audit rows need the basis.
      const states = await this.ownWork.states(client, ownIds, context.correlationId, 'audit');
      await this.auditShownPatients(client, context, result.rows, cards, own, states);
      const details = await this.prescriptionDetails.details(client, ownIds, context.correlationId);
      // Q132 A (0148): each dispensed row's change after dispensing, own and route-backed alike (a reversed
      // dispensing included: the claim keeps its first dispensing). Asked once, for dispensed rows only, after
      // the audit rows (the notice shows no new person, so it adds none); a failure answers no notice.
      const changed = await this.dispensedChanges.changes(client, result.rows.filter((row) => row.dispensing_id)
        .map((row) => row.id), context.correlationId);
      // ORD-12 (refills on): 0154's per-item reader for the own rows shown, and only those (no audit row: no new
      // person is shown); a failure leaves `refills` out, and the list says refillsUnavailable.
      const refills = await this.refills.read(client, ownIds, context.correlationId);
      const receiving = await this.routeCards.receiving(client, context);
      return { items: result.rows.map((row) => this.projectWorkItem(row, cards.get(row.id), own.get(row.id),
        this.prescriptionDetails.forRow(row, details.get(row.id)), states?.get(row.id), changed.get(row.id),
        this.refills.forRow(row, refills?.get(row.id)))), since,
        ...receiving,
        ...this.routeCards.lateCorrection(context), ...this.routeCards.cannotComplete(context),
        ...this.refills.listFlag(openRefills, refills) };
    });
    return { ...page, ...(await this.routeCards.flags()) };
  }

  /**
   * The list's rows (`since`: workListSince(); `refillOpen`: ORD-12's own items with a refill open, empty while
   * refills are off). With the own-work reader on, 0133's query, in a
   * savepoint: a schema without 0133's reader (42883) rolls back to it and
   * answers today's query. Any other failure, a serialization failure or
   * deadlock among them, is passed on (DatabaseService runs a cancelled
   * SERIALIZABLE transaction again): the list never answers an item that can
   * no longer be dispensed here as open work because the reader failed.
   */
  private async workList(client: PoolClient, since: string, refillOpen: readonly string[]) {
    const values = [since, refillOpen];
    if (!this.ownWork.enabled) return client.query<WorkItemRow>(WORK_LIST_QUERY, values);
    await client.query('savepoint pharmacy_work_list');
    try {
      const result = await client.query<WorkItemRow>(WORK_LIST_QUERY_0133, values);
      await client.query('release savepoint pharmacy_work_list');
      return result;
    } catch (error) {
      if (sqlState(error) !== '42883') throw error;
      await client.query('rollback to savepoint pharmacy_work_list');
      return client.query<WorkItemRow>(WORK_LIST_QUERY, values);
    }
  }

  /**
   * Who saw which patient on the work list (P4c): a route-backed row's card
   * shows the patient's name, sex, date of birth and Health ID ending, so one
   * row per patient shown, naming the patient, with the work items and routes
   * (ids only, §12) and basis 'order-route', in the list's transaction (no
   * answer without its audit). Rows without a patient on the card name no
   * one; the collection row above stays as it was.
   *
   * This facility's own work: with 0133 (`states` read), every own row is
   * recorded, whether or not its patient card is shown (0124's
   * OWN_WORK_PATIENT_CARD_ENABLED): one row per patient and basis, with the
   * work items (ids only) and the basis 0133 gives ('consent', or 'own-work'
   * for the facility's pharmacy staff without a personal grant), which the
   * patient's access log shows as a view. A row 0133 no longer returns (a
   * grant that ended between the two statements) keeps 'consent', the basis
   * the list's read had. Without 0133 (`states` undefined) only a row whose
   * patient is shown is recorded, with basis 'consent', as 0124 did; a
   * member then sees own rows under consent only.
   */
  private async auditShownPatients(client: PoolClient, context: DataAccessContext, rows: readonly WorkItemRow[],
    cards: ReadonlyMap<string, OrderRouteCard>, own: ReadonlyMap<string, WorkItemRoutePatient>,
    states: ReadonlyMap<string, OwnWorkState> | undefined) {
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
    const ownShown = new Map<string, { patientId: string; basis: 'consent' | 'own-work'; first: WorkItemRow;
      workItemIds: string[] }>();
    for (const row of rows) {
      if (row.order_route_id) continue;
      const basis = states ? states.get(row.id)?.basis ?? 'consent' : own.has(row.id) ? 'consent' : undefined;
      if (!basis) continue;
      const key = `${row.patient_id}:${basis}`;
      const entry = ownShown.get(key) ?? { patientId: row.patient_id, basis, first: row, workItemIds: [] };
      entry.workItemIds.push(row.id);
      ownShown.set(key, entry);
    }
    for (const entry of ownShown.values()) {
      await this.audit.recordWithClient(client, context, 'pharmacy.work-item.list', {
        patientId: entry.patientId, resourceType: 'pharmacy-work-item', resourceId: entry.first.id,
      }, { basis: entry.basis, workItemIds: entry.workItemIds });
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
      // Own work (0124, OWN_WORK_PATIENT_CARD_ENABLED): its patient, read after
      // the read row above, which already names the patient.
      const own = row.order_route_id ? undefined
        : await this.ownPatients.patients(client, [row.id], context.correlationId);
      // Its prescription details (0125, PRESCRIPTION_DISPENSING_DETAILS_ENABLED).
      const details = row.order_route_id ? undefined
        : await this.prescriptionDetails.details(client, [row.id], context.correlationId);
      // 0133: whether its automatic send was withdrawn (no flag when it cannot be read).
      const states = row.order_route_id ? undefined
        : await this.ownWork.states(client, [row.id], context.correlationId, 'flag');
      // Q132 A (0148): once dispensed, own or route-backed, its change after dispensing (no notice when it
      // cannot be read). The read's audit row above already names the item and the patient.
      const changed = row.dispensing_id
        ? await this.dispensedChanges.changes(client, [row.id], context.correlationId) : undefined;
      // ORD-12 (refills on): an own item's refills (0154's reader; none when it cannot be read). The reader writes
      // 0154's scan marker, so this transaction stays read-write (READ COMMITTED, DatabaseService's default).
      const refills = row.order_route_id ? undefined : await this.refills.read(client, [row.id], context.correlationId);
      return this.projectWorkItem(row, cards?.get(row.id), own?.get(row.id),
        this.prescriptionDetails.forRow(row, details?.get(row.id)), states?.get(row.id), changed?.get(row.id),
        this.refills.forRow(row, refills?.get(row.id)));
    });
  }

  /**
   * ORD-4: a pharmacist accepts a work item before dispensing it
   * (POST pharmacy/work-items/:workItemId/accept), in one SERIALIZABLE
   * transaction, with the checks in dispense()'s order:
   * - the item: one this session cannot see answers as a dispensing does (a
   *   route-backed item hidden by its route: 423 paused or 409 closed; else
   *   404);
   * - the write: own-work, the member's own consent, or the order route, as
   *   for a dispensing; an emergency session is refused (403), break-glass by
   *   Identity's decision or not: an acceptance is direct care only, and
   *   0144's trigger refuses any other purpose;
   * - 412 when the version differs from the one the pharmacist saw;
   * - 409 IDEMPOTENCY_CONFLICT when this member's key recorded an acceptance
   *   for another request (also when row-level security now hides that
   *   acceptance from the member, so only the insert finds it: see there);
   * - an item already accepted answers 200 with that acceptance and
   *   `alreadyAccepted: true`, writing nothing but its audit row: a stored
   *   acceptance (by this route or a dispensing), a route-backed item
   *   (accepted with its route) or an own item handed in by hand;
   * - an own item sent automatically and dispensed before ORD-4, with no
   *   acceptance, is 409 PHARMACY_WORK_ITEM_ALREADY_DISPENSED;
   * - one withdrawn before it was dispensed is 409
   *   PHARMACY_PRESCRIPTION_NOT_DISPENSABLE with its withdrawnReason;
   * - else the acceptance and its event are written (the database checks the
   *   item again, read FOR SHARE) and the answer is 201.
   * Every answer has its audit row in the transaction, naming the patient,
   * with the outcome, the way it was accepted and the basis. A racing second
   * accept is cancelled by the database (23505 or 40001) and DatabaseService
   * runs it again, when it answers 200 with the winner's acceptance. On a
   * schema without the table or the reader (42P01, 42883) the answer is 503
   * PHARMACY_ACCEPTANCE_UNAVAILABLE.
   */
  async acceptWorkItem(context: DataAccessContext, workItemId: string, input: AcceptWorkItemDto, key: string):
  Promise<WorkItemAcceptanceAnswer> {
    const digest = requestDigest('pharmacy.work-item.pharmacist-accept', { workItemId, ...input });
    // The inserts that met this member's key although the key lookup found no
    // row for it, counted over every run of this request (see the insert).
    let unreadableKeys = 0;
    return this.database.withTransaction(context, async (client) => {
      const work = (await client.query<WorkItemRow>(`${WORK_ITEM_SELECT} where w.id=$1`, [workItemId])).rows[0];
      if (!work) return this.routeAccess.hiddenWorkItem(client, workItemId, 'write_records', workItemNotFound);
      const basis = await this.routeAccess.authorize(client, context, 'work_item', work.id, work.patient_id, 'write_records');
      if (context.purposeOfUse !== 'direct-care') throw new DomainProblem(403, 'PHARMACY_ACCESS_DENIED',
        'Break-glass authorization cannot mutate Pharmacy records');
      if (Number(work.row_version) !== input.expectedWorkItemVersion) throw new DomainProblem(412,
        'PHARMACY_WORK_ITEM_VERSION_CONFLICT', 'Dispensing must bind to the exact accepted work-item version');
      const keyed = (await client.query<AcceptanceKeyRow>(ACCEPTANCE_BY_KEY_QUERY,
        [context.facilityId, context.actor.accountId, key]).catch((error: unknown) => {
        throw acceptanceSchemaMissing(error) ? acceptanceUnavailable() : error;
      })).rows[0];
      if (keyed && keyed.request_sha256 !== digest) throw acceptanceKeyConflict();
      const answered = async (pharmacistAcceptance: PharmacistAcceptance, created: boolean) => {
        await this.audit.recordWithClient(client, context, 'pharmacy.work-item.pharmacist-accept', {
          patientId: work.patient_id, resourceType: 'pharmacy-work-item', resourceId: work.id,
        }, { outcome: created ? 'accepted' : 'already_accepted', acceptedWith: pharmacistAcceptance.acceptedWith,
          ...acceptanceBasis(basis) });
        return { workItemId: work.id, pharmacyStep: created ? 'accepted' as const : stepOf(work, pharmacistAcceptance),
          pharmacistAcceptance, alreadyAccepted: !created };
      };
      // Another facility's prescription was accepted with its route: nothing to record.
      if (work.order_route_id) return answered(fromWorkItem(work, 'order_route'), false);
      const state = await this.ownWork.steps(client, [work.id], context.correlationId);
      if (!state) throw acceptanceUnavailable();
      const steps = state.get(work.id)?.steps;
      if (!steps) throw new DomainProblem(403, 'PHARMACY_ACCESS_DENIED', 'Pharmacy access is not authorized');
      if (steps.acceptance) return answered({ ...steps.acceptance }, false);
      if (!steps.sentAutomatically) return answered(fromWorkItem(work, 'hand_off'), false);
      if (work.dispensing_id) throw new DomainProblem(409, 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED',
        'A full dispensing is already recorded for this work item; partial dispensing is not supported');
      const withdrawn = state.get(work.id)!;
      if (withdrawn.withdrawn) throw notDispensable(withdrawn.withdrawnReason ?? 'changed');
      const accepted = await this.insertAcceptance(client, context, work, 'accept', key, digest)
        .catch((error: unknown) => {
          // The key lookup reads under row-level security, the unique key
          // sees every row. So an insert can meet this member's key that the
          // lookup did not find, for one of two reasons. A request with this
          // key committed while this one ran: the first time, the 23505 goes
          // on to DatabaseService's retry, whose run reads that row and
          // answers it (409 above, or 200 from the steps reader for this
          // same request). Or the row is hidden from this member (the
          // patient's consent grant ended, or the patient set a deny
          // directive): the retry still cannot read it. That row is another
          // request's: an acceptance of this item would already have been
          // answered above from the steps reader, since 0144 gives an
          // acceptance its item's read rules (the dispensing's policies) and
          // this member reads the item. So it is the contract's 409
          // IDEMPOTENCY_CONFLICT, not the 500 a second 23505 would become.
          if (acceptanceKeyTaken(error) && (unreadableKeys += 1) > 1) throw acceptanceKeyConflict();
          throw (acceptanceSchemaMissing(error) ? acceptanceUnavailable() : acceptanceRefusedByTrigger(error)) ?? error;
        });
      return answered(accepted, true);
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  /**
   * ORD-4: the acceptance row and its `pharmacist_accepted` event, by the
   * session's account and membership, in the caller's transaction.
   */
  private async insertAcceptance(client: PoolClient, context: DataAccessContext, work: WorkItemRow,
    acceptedWith: 'accept' | 'dispensing', key: string, digest: string): Promise<PharmacistAcceptance> {
    const inserted = (await client.query<AcceptanceRow>(INSERT_ACCEPTANCE, [randomUUID(), work.id, work.patient_id,
      work.facility_id, context.actor.accountId, context.membershipId, acceptedWith, key, digest,
      context.correlationId])).rows[0];
    if (!inserted) throw acceptanceUnavailable();
    await client.query(INSERT_PHARMACIST_ACCEPTED_EVENT, [work.id, work.patient_id, work.facility_id,
      context.actor.accountId, context.membershipId, PHARMACIST_ACCEPTED_REASON, context.correlationId]);
    return { acceptedAt: inserted.accepted_at, acceptedByMembershipId: inserted.accepted_by_membership_id,
      acceptedWith: inserted.accepted_with };
  }

  /**
   * ORD-4: a dispensing of a `received` item accepts it first, in the
   * dispensing's transaction, before the dispensing's insert (the claim is
   * still undispensed, as the acceptance trigger requires), by the
   * dispensing pharmacist, with the dispensing's key and digest. Only an own
   * item that the steps reader says was sent automatically, has no
   * acceptance and is not withdrawn, and only in direct care (the trigger
   * refuses any other purpose). Nothing here ever refuses a dispensing:
   * a schema without ORD-4 (42P01, 42883), a reader or insert that fails, or
   * an acceptance recorded meanwhile (23505) rolls its savepoint back and the
   * dispensing goes on, decided by its own checks as before. A serialization
   * failure or deadlock is passed on, so DatabaseService runs the whole
   * dispensing again (whose replay then answers before reaching here, so a
   * retried dispensing records no second acceptance). True when it was
   * recorded.
   */
  private async acceptWithDispensing(client: PoolClient, context: DataAccessContext, work: WorkItemRow, key: string,
    digest: string): Promise<boolean> {
    if (work.order_route_id || !this.ownWork.enabled || context.purposeOfUse !== 'direct-care') return false;
    let state: OwnWorkState | undefined;
    try {
      state = (await this.ownWork.steps(client, [work.id], context.correlationId))?.get(work.id);
    } catch (error) {
      if (mustRetry(error)) throw error;
      return false;
    }
    if (!state?.steps?.sentAutomatically || state.steps.acceptance || state.withdrawn) return false;
    await client.query('savepoint pharmacy_dispensing_acceptance');
    try {
      await this.insertAcceptance(client, context, work, 'dispensing', key, digest);
      await client.query('release savepoint pharmacy_dispensing_acceptance');
      return true;
    } catch (error) {
      if (mustRetry(error)) throw error;
      await client.query('rollback to savepoint pharmacy_dispensing_acceptance');
      if (!acceptanceSchemaMissing(error)) this.logger.warn({ message: 'The acceptance was not recorded with the dispensing',
        sqlState: sqlState(error), correlationId: context.correlationId });
      return false;
    }
  }

  /**
   * A dispensing: one fill of a work item (ORD-12, 0154), in one SERIALIZABLE
   * transaction, in this order:
   * - the item (one row whatever its fills, WORK_ITEM_SELECT): one this
   *   session cannot see answers as before (a route-backed item hidden by its
   *   route: 423 paused or 409 closed; else 404); the write's basis; 412 when
   *   the version differs from the one the pharmacist saw;
   * - the fill asked for: the body's `fillNumber`, the first fill when it
   *   carries none (a body can carry it only while PRESCRIPTION_REFILLS_ENABLED
   *   is on, CreateDispensingBodyPipe);
   * - the replay (DISPENSING_REPLAY_QUERY), by this member's Idempotency-Key
   *   or by the item and the fill asked for, against the request's digest
   *   (dispensingDigestInput: today's for a first fill): the same request
   *   answers the recorded fill (201, nothing written). Otherwise this
   *   member's key recorded another request: 409
   *   PHARMACY_WORK_ITEM_ALREADY_DISPENSED for a first fill (as today),
   *   IDEMPOTENCY_CONFLICT for a refill; or the fill was recorded by another
   *   request: 409 PHARMACY_WORK_ITEM_ALREADY_DISPENSED for a first fill (as
   *   today), PHARMACY_FILL_NUMBER_CHANGED for a refill. So a second press, or
   *   a retry with a new key, of the same fill replays it and never records
   *   another; on an item with refills, a first fill without `fillNumber`
   *   replays fill 1 as before;
   * - the fill asked for must be the fills recorded plus one: else 409
   *   PHARMACY_WORK_ITEM_ALREADY_DISPENSED for a first fill, and
   *   PHARMACY_FILL_NUMBER_CHANGED with `fillsRecorded` for a refill (the
   *   database refuses such a refill too, 0154's REFILL_NOT_NEXT_FILL, which
   *   is answered the same way);
   * - a refill while refills are off: 409 PHARMACY_REFILLS_NOT_AVAILABLE (no
   *   HTTP body can ask it then); on an item from another facility's order
   *   route: 409 PHARMACY_NO_REFILLS_LEFT (one fill);
   * - only a first fill accepts a received item (ORD-4); a refill never does;
   * - the insert names the fill number; the database decides the rest
   *   (0154): past 1 + the prescription's refills, 409 PHARMACY_NO_REFILLS_LEFT;
   *   after the refills' last day (the Lagos day; the earliest of its end date,
   *   the day it was written plus (refills + 2) fills' durations, and that day
   *   plus 365: the clinical owner's D9), 409
   *   PHARMACY_REFILL_PRESCRIPTION_ENDED with `refillsEndedOn`, that day;
   *   when the refill's day would come after that day (a late fill: the
   *   interval from the latest fill ends past the last day), the same 409
   *   PHARMACY_REFILL_PRESCRIPTION_ENDED with `refillsEndedOn`, the last day
   *   (today or later; "end on <day>, before this refill would be due"), not
   *   TOO_SOON; otherwise, before the refill interval has
   *   passed (the Lagos day of the latest fill not reversed plus 3/4 of the
   *   prescription's duration), 409 PHARMACY_REFILL_TOO_SOON with
   *   `refillOpensOn`, the day it opens (no override: a clinician writes a new
   *   prescription); changed, held, stopped or sent
   *   elsewhere, 409 PHARMACY_PRESCRIPTION_NOT_DISPENSABLE as before. Two
   *   requests for the same fill at once: the loser meets 0154's key (23505)
   *   or a serialization failure (40001) and DatabaseService runs it again,
   *   when the replay above answers it. Should a run meet a key again (the
   *   winner hidden from this member by row-level security), it is a 409 as
   *   the replay would answer it, never the 500 a second 23505 would be;
   * - the outbox row MedicationDispensed for every fill, naming `fillNumber`
   *   for a refill only (a first fill's payload is today's; the
   *   event-dispatcher that takes `fillNumber` is released first), and the
   *   audit row, with `fillNumber` for a refill.
   */
  async dispense(context: DataAccessContext, workItemId: string, input: CreateDispensingInput, key: string) {
    const fill = requestedFill(input);
    const digest = requestDigest('pharmacy.dispensing.create', { workItemId, ...dispensingDigestInput(input) });
    const alreadyDispensed = () => new DomainProblem(409, 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED',
      'A full dispensing is already recorded for this work item; partial dispensing is not supported');
    // The inserts that met 0154's key or this member's key, counted over every run of this request.
    let fillKeyTaken = 0;
    let memberKeyTaken = 0;
    return this.database.withTransaction(context, async (client) => {
      const work = (await client.query<WorkItemRow>(`${WORK_ITEM_SELECT} where w.id=$1`,
        [workItemId])).rows[0];
      if (!work) return this.routeAccess.hiddenWorkItem(client, workItemId, 'write_records', workItemNotFound);
      const basis = await this.routeAccess.authorize(client, context, 'work_item', work.id, work.patient_id, 'write_records');
      if (Number(work.row_version) !== input.expectedWorkItemVersion) throw new DomainProblem(412,
        'PHARMACY_WORK_ITEM_VERSION_CONFLICT', 'Dispensing must bind to the exact accepted work-item version');
      const fillsRecorded = Number(work.fills_recorded ?? 0);
      const taken = () => (fill === 1 ? alreadyDispensed() : fillNumberChanged(fillsRecorded));
      const found = (await client.query<DispensingRow>(DISPENSING_REPLAY_QUERY,
        [context.facilityId, context.actor.accountId, key, workItemId, fill])).rows;
      const keyed = found.find((row) => row.by_key === true);
      if (keyed) {
        if (keyed.request_sha256 === digest) return this.projectDispensing(keyed);
        throw fill === 1 ? alreadyDispensed() : dispensingKeyConflict();
      }
      const recorded = found.find((row) => row.by_key !== true);
      if (recorded) {
        if (recorded.request_sha256 === digest) return this.projectDispensing(recorded);
        throw taken();
      }
      if (fill !== fillsRecorded + 1) throw taken();
      if (fill > 1 && !this.refills.enabled) throw refillsNotRecorded();
      if (fill > 1 && work.order_route_id) throw noRefillsLeft();
      // ORD-4: a received item is accepted by its first fill; never a reason to refuse it.
      const acceptedWithDispensing = fill === 1 ? await this.acceptWithDispensing(client, context, work, key, digest)
        : false;
      const inserted = await client.query<DispensingRow>(INSERT_DISPENSING,
        [randomUUID(), work.id, input.expectedWorkItemVersion, work.patient_id, work.facility_id,
          work.medication_code_system, work.medication_code, work.medication_display,
          input.quantityDispensed, input.quantityUnit, context.actor.accountId, context.membershipId,
          input.reason, key, digest, context.correlationId, fill])
        .catch((error: unknown) => {
          // The first 23505 goes on to DatabaseService's retry, whose run answers it above; a second is a 409.
          if (dispensingKeyTaken(error, FILL_KEY_CONSTRAINT) && (fillKeyTaken += 1) > 1) throw taken();
          if (dispensingKeyTaken(error, DISPENSING_KEY_CONSTRAINT) && (memberKeyTaken += 1) > 1) {
            throw fill === 1 ? alreadyDispensed() : dispensingKeyConflict();
          }
          throw refillRefusal(error)
            ?? (work.order_route_id ? routedDispensingRefusal(error) : sameFacilityDispensingRefusal(error)) ?? error;
        });
      const row = inserted.rows[0];
      if (!row) throw new DomainProblem(503, 'PHARMACY_DISPENSING_NOT_CREATED',
        'Pharmacy could not record the dispensing');
      await this.outbox(client, 'MedicationDispensed', 'medication-dispensing', row.id,
        row.facility_id, row.patient_id, context.correlationId,
        { dispensingId: row.id, workItemId: row.work_item_id, status: 'dispensed', ...(fill > 1 ? { fillNumber: fill } : {}) });
      await this.audit.recordWithClient(client, context, 'pharmacy.dispensing.create', {
        patientId: row.patient_id, resourceType: 'medication-dispensing', resourceId: row.id,
      }, { workItemId: row.work_item_id, workItemVersion: Number(row.work_item_version), status: 'dispensed',
        ...(fill > 1 ? { fillNumber: fill } : {}), ...basisDetails(basis),
        ...(acceptedWithDispensing ? { acceptedWithDispensing: true } : {}) });
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

  /**
   * A dispensing's reversal, as before, with one rule more (ORD-12, 0154,
   * setting on or off): only the item's latest fill can be reversed. A
   * reversal of an earlier fill, once its replay is ruled out, is 409
   * PHARMACY_DISPENSING_NOT_LATEST_FILL, so the item's `dispensing` (its latest
   * fill) always says whether the fill the pharmacist sees was reversed. A
   * refill recorded while this runs makes one of the two SERIALIZABLE
   * transactions fail (40001), and DatabaseService runs it again.
   */
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
      const later = (await client.query<{ later: boolean }>(LATER_FILL_QUERY,
        [dispensing.work_item_id, Number(dispensing.fill_number ?? 1)])).rows[0];
      if (later?.later) throw notLatestFill();
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
   * its route card, and its patient only while the route allows a read. This
   * facility's own one carries its patient when 0124's reader gave one
   * (OWN_WORK_PATIENT_CARD_ENABLED on, and the member may read it), where a
   * route-backed one carries its card. The list and a single work item pass
   * an own row's prescription details (0125, PRESCRIPTION_DISPENSING_DETAILS_ENABLED
   * on): its medication gains `strength` and `doseForm`, and the item
   * `priority`, `duration`, `quantityToDispense` and `quantityUnit`, each only
   * when there is a value, after today's fields. An own item withdrawn before
   * it was dispensed carries `withdrawn: true` and its `withdrawnReason`:
   * 'changed' when its automatic send was withdrawn (0133: the prescription
   * was held, cancelled, entered in error, edited or resumed after it was
   * sent, by whoever changed it), 'sent_elsewhere' when the prescription was
   * sent to another facility's pharmacy (D14, owner's Q121 A). Dispensing it
   * is refused (409 PHARMACY_PRESCRIPTION_NOT_DISPENSABLE). `withdrawnReason`
   * never comes without `withdrawn`.
   *
   * ORD-4: `pharmacyStep` and `pharmacistAcceptance` follow `dispensing`. A
   * route-backed item carries them always, from its own row (accepted with
   * its route). An own item carries them only when ORD-4's steps reader
   * answered it (`ownState.steps`): on a schema without it, or when the
   * reader could not be read, neither is answered, never a guessed step.
   *
   * Q132 A (0148): a dispensed item (reversed or not) whose prescription the
   * prescribing team changed after its first dispensing carries
   * `changedAfterDispensing: { change, changedAt, changeCount }` as its last
   * field: the latest shown change's code and time, and how many shown
   * changes there were. `change` is left out when the database answered a
   * code this image does not know. It is answered only next to a dispensing
   * (`row.dispensing_id`), so it never stands next to `dispensing: null`, nor
   * next to `withdrawn`, which exists only before a dispensing. It adds no
   * prescription id, version or encounter: a route-backed item still carries
   * none of the other facility's ids (PRIV P4.3). The item's step stays
   * `dispensed` or `dispensing_reversed`; `status`, `acceptedAt`, `version`
   * and `dispensing` keep their meaning.
   *
   * ORD-12 (0154): `dispensing` is the item's latest fill, and `reversed`
   * that fill's (so `pharmacyStep` keeps its meaning), setting on or off.
   * While PRESCRIPTION_REFILLS_ENABLED is on, `dispensing` also carries its
   * `fillNumber`; a dispensed item carries `lastFilledAt` (the latest fill's
   * time); and the list and a single read pass `refills` (PharmacyRefills),
   * after the item's other fields and before `changedAfterDispensing`. No
   * prescription id, version or count from the other facility is added to a
   * route-backed item: its `refills` says none allowed, one fill at most.
   */
  private projectWorkItem(row: WorkItemRow, card?: OrderRouteCard, ownPatient?: WorkItemRoutePatient,
    details?: WorkItemDispensingDetails, ownState?: OwnWorkState, changed?: ChangedAfterDispensing,
    refills?: WorkItemRefills) {
    const source = row.order_route_id ? {} : { sourceEhrPrescriptionId: row.source_ehr_prescription_id,
      sourceEncounterId: row.source_encounter_id };
    const route = row.order_route_id
      ? (card ? { orderRoute: card.orderRoute, ...(card.patient ? { patient: card.patient } : {}) } : {})
      : (ownPatient ? { patient: ownPatient } : {});
    return { id: row.id, patientId: row.patient_id, facilityId: row.facility_id, ...source,
      sourceEhrPrescriptionVersion: Number(row.source_ehr_prescription_version),
      status: 'accepted' as const, ...route,
      medication: { codeSystem: row.medication_code_system, code: row.medication_code,
        display: row.medication_display, ...(details?.strength ? { strength: details.strength } : {}),
        ...(details?.doseForm ? { doseForm: details.doseForm } : {}) },
      doseQuantity: row.dose_quantity === null ? null : Number(row.dose_quantity),
      doseUnit: row.dose_unit, routeCode: row.route_code, frequency: row.frequency,
      instructions: row.instructions, acceptedAt: row.accepted_at, version: Number(row.row_version),
      dispensing: row.dispensing_id ? { id: row.dispensing_id, status: row.dispensing_status,
        reversed: Boolean(row.reversal_id),
        ...(this.refills.enabled ? { fillNumber: Number(row.dispensing_fill_number ?? 1) } : {}) } : null,
      ...pharmacySteps(row, ownState),
      ...(details?.priority ? { priority: details.priority } : {}),
      ...(details?.duration ? { duration: details.duration } : {}),
      ...(details?.quantityToDispense === undefined ? {}
        : { quantityToDispense: details.quantityToDispense, quantityUnit: details.quantityUnit }),
      ...(ownState?.withdrawn ? { withdrawn: true,
        ...(ownState.withdrawnReason ? { withdrawnReason: ownState.withdrawnReason } : {}) } : {}),
      ...(this.refills.enabled && row.dispensing_id && row.last_filled_at ? { lastFilledAt: row.last_filled_at } : {}),
      ...(refills ? { refills } : {}),
      ...(row.dispensing_id && changed ? { changedAfterDispensing: {
        ...(changed.change ? { change: changed.change } : {}), changedAt: changed.changedAt,
        changeCount: changed.changeCount } } : {}) };
  }

  private projectDispensing(row: DispensingRow) {
    return { id: row.id, workItemId: row.work_item_id, patientId: row.patient_id,
      facilityId: row.facility_id, status: row.status, effectiveStatus: row.reversal_id ? 'reversed' : 'dispensed',
      medication: { codeSystem: row.medication_code_system, code: row.medication_code,
        display: row.medication_display }, quantityDispensed: Number(row.quantity_dispensed),
      quantityUnit: row.quantity_unit, dispensedAt: row.dispensed_at,
      reversalId: row.reversal_id ?? null, version: Number(row.row_version),
      // ORD-12 (refills on): which fill this is (0154; a dispensing recorded before 0154 is the first).
      ...(this.refills.enabled ? { fillNumber: Number(row.fill_number ?? 1) } : {}) };
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

function sqlState(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

function workItemNotFound(): DomainProblem {
  return new DomainProblem(404, 'PHARMACY_WORK_ITEM_NOT_FOUND', 'Pharmacy work item was not found');
}

function mustRetry(error: unknown): boolean {
  const code = sqlState(error);
  return code === '40001' || code === '40P01';
}

/** The acceptance read from the work item itself: a route-backed item, or an own item handed in by hand. */
function fromWorkItem(row: WorkItemRow, acceptedWith: 'order_route' | 'hand_off'): PharmacistAcceptance {
  return { acceptedAt: row.accepted_at, acceptedByMembershipId: row.accepted_by_membership_id, acceptedWith };
}

/** The step of an item with this acceptance (or none): its dispensing first. */
function stepOf(row: WorkItemRow, acceptance: PharmacistAcceptance | null): PharmacyStep {
  if (row.reversal_id) return 'dispensing_reversed';
  if (row.dispensing_id) return 'dispensed';
  return acceptance ? 'accepted' : 'received';
}

/**
 * ORD-4's two fields for a work item, or none: a route-backed item from its
 * row; an own item from the steps reader (a stored acceptance; else, not sent
 * automatically, handed in by hand, from its row; else none yet), and
 * nothing when the reader did not answer it.
 */
function pharmacySteps(row: WorkItemRow, ownState: OwnWorkState | undefined):
{ pharmacyStep?: PharmacyStep; pharmacistAcceptance?: PharmacistAcceptance | null } {
  let acceptance: PharmacistAcceptance | null;
  if (row.order_route_id) acceptance = fromWorkItem(row, 'order_route');
  else if (!ownState?.steps) return {};
  else if (ownState.steps.acceptance) acceptance = { ...ownState.steps.acceptance };
  else acceptance = ownState.steps.sentAutomatically ? null : fromWorkItem(row, 'hand_off');
  return { pharmacyStep: stepOf(row, acceptance), pharmacistAcceptance: acceptance };
}

/**
 * The basis on the pharmacist-accept audit row, as 0133 records bases on
 * the work list: always named ('consent', 'own-work', or 'order-route' with
 * its route).
 */
function acceptanceBasis(basis: ResourceBasis): Record<string, string> {
  return { basis: 'consent', ...basisDetails(basis) };
}
