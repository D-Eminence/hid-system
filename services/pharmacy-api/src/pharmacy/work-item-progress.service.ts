import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { WorkItemProgressDto } from './dto/work-item-progress.dto';

/**
 * Where a prescription is in this facility's own pharmacy (ORD-3):
 * - not_received: no work item here that the clinician may read;
 * - received: the pharmacy has it and has not dispensed it;
 * - dispensed: it was dispensed (dispensedAt);
 * - dispensing_reversed: it was dispensed and the dispensing was reversed.
 */
export type PharmacyProgressStatus = 'not_received' | 'received' | 'dispensed' | 'dispensing_reversed';

export interface PharmacyProgressItem {
  sourceEhrPrescriptionId: string;
  status: PharmacyProgressStatus;
  receivedAt: string | null;
  dispensedAt: string | null;
  reversedAt: string | null;
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
    private readonly audit: AuditService) {}

  async read(context: DataAccessContext, input: WorkItemProgressDto): Promise<{ items: PharmacyProgressItem[] }> {
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
      const found = new Map(rows.map((row) => [row.source_ehr_prescription_id.toLowerCase(), row]));
      return { items: input.sourceEhrPrescriptionIds.map((id) => project(id, found.get(id.toLowerCase()))) };
    });
  }
}

function project(id: string, row: ProgressRow | undefined): PharmacyProgressItem {
  if (!row) return { sourceEhrPrescriptionId: id, status: 'not_received', receivedAt: null, dispensedAt: null,
    reversedAt: null };
  const status: PharmacyProgressStatus = row.reversed_at ? 'dispensing_reversed'
    : row.dispensed_at ? 'dispensed' : 'received';
  return { sourceEhrPrescriptionId: id, status, receivedAt: iso(row.accepted_at),
    dispensedAt: iso(row.dispensed_at), reversedAt: iso(row.reversed_at) };
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
