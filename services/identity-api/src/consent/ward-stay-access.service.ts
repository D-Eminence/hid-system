import { Injectable, Optional } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';

/** A row of identity.open_ward_stay (0173). */
interface WardStayRow extends QueryResultRow {
  outcome: 'opened' | 'refused' | 'not_found';
  consentGrantId: string | null;
  patientId: string | null;
  status: 'active' | null;
  expiresAt: Date | null;
  existingGrant: boolean;
}

export interface WardStayAccess {
  consentGrantId: string;
  patientId: string;
  status: 'active';
  expiresAt: Date;
  existingGrant: boolean;
  authorization: { basis: 'ward-stay'; scope: 'write_records'; purpose: 'direct-care' };
}

/** The answers' words (plain English; never the word "permission"). */
export const WARD_STAY_DETAIL = {
  notAvailable: 'Ward-team access is not switched on yet. Open the record the usual way.',
  refused: 'You are not on the ward team for this patient. Open the record the usual way.',
  notFound: 'This admission is not at this facility.',
  directCareOnly: 'Opening a patient\'s chart for their stay is for direct care only.',
} as const;

/**
 * ADT-1 route 23 (0173; owner decisions Q156 A and Q-ADT-15 A): "Open chart
 * for this stay". The database command decides (switched off until Rahman and
 * the DPO agree: WARD_STAY_ACCESS_NOT_AVAILABLE; then a nurse, clinician or
 * doctor on the ward team of an admitted patient here, without a deny
 * directive), writes the write grant for direct care tied to the admission
 * (authorization_method ward_stay, ended at discharge or 2 hours after the
 * patient leaves the member's ward, revocable by the patient) and its own
 * audit row for every answer it gives. A refusal raised before it answers is
 * audited here, since the database's row rolls back with it. While the
 * switch is off the screen offers the usual "Open this facility's patient"
 * (0131) instead.
 */
@Injectable()
export class WardStayAccessService {
  constructor(
    private readonly database: DatabaseService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  async open(context: DataAccessContext, admissionId: string): Promise<WardStayAccess> {
    let row: WardStayRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<WardStayRow>(
        `select outcome, consent_grant_id as "consentGrantId", subject_patient_id as "patientId",
           grant_status as status, expires_at as "expiresAt", existing_grant as "existingGrant"
         from identity.open_ward_stay($1::uuid)`, [admissionId])).rows[0]);
    } catch (error) {
      const problem = translate(error);
      if (problem instanceof DomainProblem && problem.getStatus() !== 503) await this.auditRefusal(context, problem.code, admissionId);
      throw problem;
    }
    if (!row || row.outcome === 'not_found') throw new DomainProblem(404, 'ADMISSION_NOT_FOUND', WARD_STAY_DETAIL.notFound);
    if (row.outcome !== 'opened' || !row.consentGrantId || !row.patientId || row.status !== 'active' || !row.expiresAt) {
      throw new DomainProblem(403, 'WARD_STAY_ACCESS_REFUSED', WARD_STAY_DETAIL.refused);
    }
    return {
      consentGrantId: row.consentGrantId,
      patientId: row.patientId,
      status: row.status,
      expiresAt: row.expiresAt,
      existingGrant: row.existingGrant === true,
      authorization: { basis: 'ward-stay', scope: 'write_records', purpose: 'direct-care' },
    };
  }

  private async auditRefusal(context: DataAccessContext, code: string, admissionId: string): Promise<void> {
    await this.audit?.record({
      correlationId: context.correlationId,
      actorType: 'staff',
      actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId,
      action: 'identity.ward-stay.open',
      resourceType: 'admission',
      resourceId: admissionId,
      outcome: 'denied',
      purposeOfUse: context.purposeOfUse,
      details: { code },
    });
  }
}

/** The command's own refusals, in plain words; anything else is passed on. */
export function translate(error: unknown): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  if ((code === '55000' && message === 'WARD_STAY_ACCESS_NOT_AVAILABLE') || code === '42883') {
    // Switched off (Q156 A), or an Identity build ahead of migration 0173.
    return new DomainProblem(503, 'WARD_STAY_ACCESS_NOT_AVAILABLE', WARD_STAY_DETAIL.notAvailable);
  }
  if (code === '42501') return new DomainProblem(403, 'WARD_STAY_ACCESS_REFUSED', WARD_STAY_DETAIL.refused);
  if (code === '22023') return new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', WARD_STAY_DETAIL.directCareOnly);
  return error;
}
