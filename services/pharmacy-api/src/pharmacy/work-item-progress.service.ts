import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { WorkItemProgressDto } from './dto/work-item-progress.dto';
import { OWN_WORK_OFF, PharmacyOwnWork, type OwnWorkState } from './own-work-access';

/**
 * Where a prescription is in this facility's own pharmacy (ORD-3):
 * - not_received: no work item here that the clinician may read;
 * - received: the pharmacy has it and has not dispensed it;
 * - accepted (ORD-4): a pharmacist here accepted it (acceptedAt), and it is
 *   not dispensed: by the accept route, or handed in by hand
 *   (accept-ehr-prescription), when it was accepted as it was made;
 * - dispensed: it was dispensed (dispensedAt);
 * - dispensing_reversed: it was dispensed and the dispensing was reversed;
 * - withdrawn (0133): sent by itself to the pharmacy, then held, cancelled,
 *   entered in error, edited or resumed before it was dispensed; the pharmacy
 *   holds the version sent, which it can no longer dispense;
 * - sent_elsewhere (0133 D14, owner's Q121 A): the pharmacy had it
 *   (receivedAt), and it was sent to another facility's pharmacy before it
 *   was dispensed; the item here is withdrawn and off the pharmacy's list.
 * withdrawn and sent_elsewhere are answered only to an ehr-api that reads
 * them (header X-HID-Own-Progress: 0133); see OWN_PROGRESS_HEADER. accepted
 * and acceptedAt only to one that also reads them (X-HID-Own-Progress-Accepted:
 * ord4); see OWN_PROGRESS_ACCEPTED_HEADER.
 */
export type PharmacyProgressStatus = 'not_received' | 'received' | 'accepted' | 'dispensed' | 'dispensing_reversed'
  | 'withdrawn' | 'sent_elsewhere';

/**
 * ehr-api sends this header, with OWN_PROGRESS_VERSION, when it reads
 * 'withdrawn' and 'sent_elsewhere' (0133). An ehr-api from before 0133 knows
 * four statuses and treats a whole answer with any other as unknown, so
 * without the header 'withdrawn' is answered 'received' (times kept) and
 * 'sent_elsewhere' 'not_received' (times null).
 */
export const OWN_PROGRESS_HEADER = 'x-hid-own-progress';
export const OWN_PROGRESS_VERSION = '0133';

/**
 * ORD-4: an ehr-api that reads 'accepted' and `acceptedAt` sends this header,
 * with OWN_PROGRESS_ACCEPTED_VERSION, beside OWN_PROGRESS_HEADER, which stays
 * exactly '0133' (a Release A pharmacy-api matches it exactly). Each value is
 * matched exactly, and the new statuses need both: without this one,
 * 'accepted' is answered 'received' (times kept) and `acceptedAt` is left
 * out, so an ehr-api from before ORD-4, which treats a whole answer with a
 * status it does not know as unknown, reads every answer as before. Either
 * image can then be deployed, or rolled back, first.
 */
export const OWN_PROGRESS_ACCEPTED_HEADER = 'x-hid-own-progress-accepted';
export const OWN_PROGRESS_ACCEPTED_VERSION = 'ord4';

export interface PharmacyProgressItem {
  sourceEhrPrescriptionId: string;
  status: PharmacyProgressStatus;
  receivedAt: string | null;
  dispensedAt: string | null;
  reversedAt: string | null;
  /**
   * ORD-4, only to a caller sending both headers: when a pharmacist here
   * accepted it, whatever the status now (also dispensed, withdrawn or sent
   * elsewhere), or null (none yet, or it cannot be read).
   */
  acceptedAt?: string | null;
}

interface ProgressRow extends QueryResultRow {
  work_item_id: string; source_ehr_prescription_id: string; accepted_at: Date;
  dispensed_at: Date | null; reversed_at: Date | null;
}

/**
 * This facility's own work items for the given EHR prescriptions of one
 * patient: $1 patient, $2 facility, $3 prescription ids. Work items on an
 * order route to another facility are not this facility's own and are left
 * out (their progress is on the route). Row-level security applies as well:
 * the clinician reads under their own consent grant (pharmacy.work_item_allows
 * and pharmacy.context_allows), never the pharmacist's. A work item takes one
 * dispensing and a dispensing one reversal (0023), so the joins add no rows.
 * Exported for the tests.
 */
export const WORK_ITEM_PROGRESS_QUERY = `select w.id::text as work_item_id,
  w.source_ehr_prescription_id::text as source_ehr_prescription_id, w.accepted_at,
  d.dispensed_at, r.reversed_at
  from pharmacy.work_items w
  left join pharmacy.dispensings d on d.work_item_id=w.id
  left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id
  where w.patient_id=$1::uuid and w.facility_id=$2::uuid and w.order_route_id is null
    and w.source_ehr_prescription_id=any($3::uuid[])`;

/**
 * ORD-3: a read-only progress answer for ehr-api, which shows the clinician
 * whether this facility's pharmacy received and dispensed each prescription.
 * Identity first decides the clinician's read of the patient (a refusal is
 * 403 and is audited); then one audit row names the patient, with the
 * prescriptions asked about and the work items found, in the read's
 * transaction (no answer without its audit row).
 */
@Injectable()
export class PharmacyWorkItemProgressService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityService,
    private readonly audit: AuditService, private readonly ownWork: PharmacyOwnWork = OWN_WORK_OFF) {}

  /**
   * `current`: the caller sent OWN_PROGRESS_HEADER (it reads 'withdrawn' and
   * 'sent_elsewhere'). `accepted`: it also sent OWN_PROGRESS_ACCEPTED_HEADER
   * (it reads 'accepted' and `acceptedAt`); taken only with `current`.
   */
  async read(context: DataAccessContext, input: WorkItemProgressDto, current = false, accepted = false):
  Promise<{ items: PharmacyProgressItem[] }> {
    // The clinician's browser request to ehr-api was a read (GET), and this
    // route only reads, so Identity is told GET: its delegated path then
    // checks a forwarded cookie without the browser-write Origin and CSRF
    // check (the website sends no CSRF token on a GET) and allows only
    // read_records, which is all this asks for. request.method here is the
    // POST of the internal ehr-api call, never the clinician's.
    const readContext: DataAccessContext = { ...context, requestMethod: 'GET' };
    const denied = (reason: string) => this.database.withTransaction(context, (client) => this.audit.recordWithClient(
      client, context, 'pharmacy.work-item.progress.read', { patientId: input.patientId,
        resourceType: 'pharmacy-work-item-collection', resourceId: context.facilityId },
      { requestedCount: input.sourceEhrPrescriptionIds.length, reason }, 'denied'));
    let decision: Awaited<ReturnType<IdentityService['authorize']>>;
    try {
      decision = await this.identity.authorize(input.patientId, 'read_records', readContext);
    } catch (error) {
      // Identity's own refusal (403) is a denied read of this patient, audited as one.
      if (error instanceof DomainProblem && error.getStatus() === 403) await denied('identity_refusal');
      throw error;
    }
    if (!decision.allowed) {
      await denied('identity_authorization');
      throw new DomainProblem(403, 'PHARMACY_ACCESS_DENIED', 'Pharmacy access is not authorized');
    }
    return this.database.withTransaction(context, async (client) => {
      const rows = (await client.query<ProgressRow>(WORK_ITEM_PROGRESS_QUERY,
        [input.patientId, context.facilityId, input.sourceEhrPrescriptionIds])).rows;
      await this.audit.recordWithClient(client, context, 'pharmacy.work-item.progress.read', {
        patientId: input.patientId, resourceType: 'pharmacy-work-item-collection', resourceId: context.facilityId,
      }, { requestedCount: input.sourceEhrPrescriptionIds.length, foundCount: rows.length,
        workItemIds: rows.map((row) => row.work_item_id), breakGlass: decision.breakGlass });
      // 0133: whether each item was withdrawn before it was dispensed, and why (no flag when it cannot be read);
      // ORD-4: in the same reader statement, its pharmacist's acceptance (none when it cannot be read).
      const states = await this.ownWork.states(client, rows.map((row) => row.work_item_id), context.correlationId, 'flag');
      const found = new Map(rows.map((row) => [row.source_ehr_prescription_id.toLowerCase(), row]));
      return { items: input.sourceEhrPrescriptionIds.map((id) => {
        const row = found.get(id.toLowerCase());
        return project(id, row, row ? states.get(row.work_item_id) : undefined, current, current && accepted);
      }) };
    });
  }
}

/**
 * The status, in this order: a reversal, a dispensing, sent elsewhere,
 * withdrawn, accepted (ORD-4), else received. To a caller without
 * OWN_PROGRESS_HEADER, 'withdrawn' is 'received' (times kept) and
 * 'sent_elsewhere' 'not_received' (times null), the statuses an ehr-api from
 * before 0133 knows. To a caller without both headers (`accepted` false),
 * 'accepted' is 'received' (times kept) and `acceptedAt` is left out; with
 * both, every item carries `acceptedAt`, null when there is none.
 */
function project(id: string, row: ProgressRow | undefined, state: OwnWorkState | undefined,
  current: boolean, accepted: boolean): PharmacyProgressItem {
  const notReceived: PharmacyProgressItem = { sourceEhrPrescriptionId: id, status: 'not_received', receivedAt: null,
    dispensedAt: null, reversedAt: null, ...(accepted ? { acceptedAt: null } : {}) };
  if (!row) return notReceived;
  const acceptedAt = acceptedTime(row, state);
  const status: PharmacyProgressStatus = row.reversed_at ? 'dispensing_reversed'
    : row.dispensed_at ? 'dispensed'
      : state?.withdrawn === true && state.withdrawnReason === 'sent_elsewhere' ? 'sent_elsewhere'
        : state?.withdrawn === true ? 'withdrawn'
          : acceptedAt !== null ? 'accepted' : 'received';
  if (!current && status === 'sent_elsewhere') return notReceived;
  const answered: PharmacyProgressStatus = (!current && status === 'withdrawn') || (!accepted && status === 'accepted')
    ? 'received' : status;
  return { sourceEhrPrescriptionId: id, status: answered, receivedAt: iso(row.accepted_at),
    dispensedAt: iso(row.dispensed_at), reversedAt: iso(row.reversed_at),
    ...(accepted ? { acceptedAt: iso(acceptedAt) } : {}) };
}

/**
 * ORD-4: when a pharmacist here accepted the item, from ORD-4's steps reader
 * only: its stored acceptance (the accept route, or its first dispensing);
 * else, for an item not sent automatically (handed in by a pharmacist by
 * hand), the time it was handed in; else, or when the reader did not answer
 * (a schema without it, or a failure), none, so it is never guessed.
 */
function acceptedTime(row: ProgressRow, state: OwnWorkState | undefined): Date | null {
  const steps = state?.steps;
  if (!steps) return null;
  if (steps.acceptance) return steps.acceptance.acceptedAt;
  return steps.sentAutomatically ? null : row.accepted_at;
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
