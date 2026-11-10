import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService, type HealthIdPatient } from '../identity/identity.service';
import type { CreateVisitDto } from './dto/create-visit.dto';
import type { LinkPreviewDto } from './dto/link-preview.dto';
import { findVisibleCase, reserveHealthIdCheck } from './link-preview-attempts';
import {
  caseVisit, VISIT_COLUMNS, type OutreachCaseVisit, type OutreachLinkPreview, type VisitRow,
} from './outreach-visit.types';

/**
 * Visits on a registration case and the Health ID link preview (0115). The
 * routes reach this service only while OUTREACH_VISITS_ENABLED is on
 * (VisitsEnabledGuard). Audit rows carry ids only.
 */
@Injectable()
export class OutreachVisitsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
  ) {}

  async list(caseId: string, context: DataAccessContext): Promise<{ items: readonly OutreachCaseVisit[] }> {
    return this.database.withTransaction(context, async (client) => {
      const registration = await findVisibleCase(client, caseId, context);
      const result = await client.query<VisitRow>(`select ${VISIT_COLUMNS}
        from outreach.registration_case_visits where registration_case_id=$1 and facility_id=$2
        order by occurred_on desc,created_at desc,id desc limit 100`, [caseId, context.facilityId]);
      await this.audit.recordWithClient(client, context, 'outreach.registration-case.visit.list', caseId,
        registration.resolved_patient_id ?? undefined);
      return { items: result.rows.map(caseVisit) };
    });
  }

  async create(caseId: string, input: CreateVisitDto, idempotencyKey: string,
    context: DataAccessContext): Promise<{ visit: OutreachCaseVisit }> {
    // The digest names its fields: a field added later does not change it.
    const normalized = { kind: input.kind, occurredOn: input.occurredOn, followUpOn: input.followUpOn ?? null,
      referredTo: input.referredTo ?? null, notes: input.notes ?? null };
    const digest = requestDigest('outreach.registration-case.visit.create', { caseId, ...normalized });
    try {
      return await this.database.withTransaction(context, async (client) => {
        const registration = await findVisibleCase(client, caseId, context);
        const replay = await client.query<VisitRow>(`select ${VISIT_COLUMNS}
          from outreach.registration_case_visits where recorded_by_account_id=$1 and facility_id=$2
            and idempotency_key=$3`, [context.actor.accountId, context.facilityId, idempotencyKey]);
        const previous = replay.rows[0];
        if (previous) {
          if (previous.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT',
            'The Idempotency-Key belongs to a different Outreach request');
          return { visit: caseVisit(previous) };
        }
        const inserted = await client.query<VisitRow>(`insert into outreach.registration_case_visits (
          registration_case_id,facility_id,kind,occurred_on,follow_up_on,referred_to,notes,
          recorded_by_account_id,recorded_by_membership_id,idempotency_key,request_sha256
        ) values ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11) returning ${VISIT_COLUMNS}`,
        [caseId, context.facilityId, normalized.kind, normalized.occurredOn, normalized.followUpOn,
          normalized.referredTo, normalized.notes, context.actor.accountId, context.membershipId,
          idempotencyKey, digest]);
        const row = inserted.rows[0];
        if (!row) throw new Error('Outreach visit insert returned no row');
        await this.audit.recordWithClient(client, context, 'outreach.registration-case.visit.create', caseId,
          registration.resolved_patient_id ?? undefined);
        return { visit: caseVisit(row) };
      }, { isolationLevel: 'SERIALIZABLE' });
    } catch (error) {
      const code = sqlState(error);
      // A concurrent identical request is retried and replayed; a duplicate
      // that remains is a conflict.
      if (code === '23505') throw new DomainProblem(409, 'OUTREACH_VISIT_CONFLICT',
        'This Outreach visit was already recorded');
      if (code === '23514') {
        const field = visitCheckField(error);
        if (field) throw new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
          [{ field: field.field, messages: [field.message] }]);
      }
      throw error;
    }
  }

  /**
   * Who a Health ID belongs to, for a pending case the caller may see. Each
   * preview is counted first (20 an hour per member at a facility), then
   * Identity resolves it with the caller's own authorization (read_records),
   * then canLink answers whether the write_records check the link makes
   * would pass. Nothing from the preview is kept or trusted by the link.
   */
  async linkPreview(caseId: string, input: LinkPreviewDto, context: DataAccessContext): Promise<OutreachLinkPreview> {
    await this.database.withTransaction(context, (client) => reserveHealthIdCheck(client, caseId, context),
      { isolationLevel: 'SERIALIZABLE' });
    let patient: HealthIdPatient;
    try {
      patient = await this.identity.lookupByHealthId(input.healthId, context);
    } catch (error) {
      // A refused check is audited too, with the case id only (no patient).
      const outcome = error instanceof DomainProblem ? REFUSED_PREVIEW_OUTCOME[error.code] : undefined;
      if (outcome) await this.database.withTransaction(context, (client) => this.audit.recordWithClient(client,
        context, 'outreach.registration-case.link-preview', caseId, undefined, outcome));
      throw error;
    }
    const canLink = await this.identity.canLinkPatient(patient.patientId, context);
    await this.database.withTransaction(context, (client) => this.audit.recordWithClient(client, context,
      'outreach.registration-case.link-preview', caseId, patient.patientId));
    return { patient: { fullName: patient.fullName, dateOfBirth: patient.dateOfBirth,
      healthIdLast4: patient.healthIdLast4 }, canLink };
  }
}

const REFUSED_PREVIEW_OUTCOME: Readonly<Record<string, 'denied' | 'failure'>> = {
  OUTREACH_HEALTH_ID_NOT_FOUND: 'failure',
  OUTREACH_PATIENT_ACCESS_REQUIRED: 'denied',
};

/**
 * The field a CHECK failure on a visit belongs to, by constraint name. The
 * Lagos-date trigger raises 23514 with no constraint. Any other CHECK is not
 * a field the client sent and is left as a server error.
 */
const VISIT_CHECKS: Readonly<Record<string, { field: string; message: string }>> = {
  registration_case_visits_kind_check: { field: 'kind', message: 'kind must be one of visit, referral, follow_up' },
  registration_case_visits_occurred_on_check: { field: 'occurredOn',
    message: 'occurredOn must be a date (YYYY-MM-DD) on or after 2020-01-01' },
  registration_case_visits_follow_up_on_check: { field: 'followUpOn',
    message: 'followUpOn must be a date (YYYY-MM-DD) after occurredOn' },
  registration_case_visits_referred_to_check: { field: 'referredTo',
    message: 'referredTo must be 2 to 160 characters with no control characters' },
  registration_case_visits_notes_check: { field: 'notes',
    message: 'notes must be at most 1000 characters; line breaks are allowed but no other control characters' },
};

export function visitCheckField(error: unknown): { field: string; message: string } | undefined {
  const constraint = typeof error === 'object' && error !== null && 'constraint' in error
    ? (error as { constraint?: unknown }).constraint : undefined;
  if (typeof constraint === 'string' && constraint.length > 0) return VISIT_CHECKS[constraint];
  return { field: 'occurredOn', message: 'occurredOn must be a date (YYYY-MM-DD) that is not after today in Lagos' };
}

function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code) : undefined;
}
