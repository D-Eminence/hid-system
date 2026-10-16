import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { MFA_RETRY_AFTER_SECONDS, MfaService } from '../auth/mfa/mfa.service';
import { requirePlatformAssurance } from '../auth/platform-assurance';
import type { SessionEventMetadata } from '../auth/token.service';
import { cursorTimestampSql, decodeCursor, encodeCursor } from '../common/cursor';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, RetryAfterProblem } from '../common/problem';
import type { PlatformAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { adminCommandError } from './admin-command-error';
import { platformAuditActor } from './admin-context';
import type { AttestClinicianApplicationDto, ApproveClinicianApplicationDto, ListClinicianApplicationsDto,
  RejectClinicianApplicationDto } from './dto/clinician-application-command.dto';
import type { PlatformAction } from './high-risk-policy';

const LIST_CURSOR = 'admin.clinician-applications';
/** C17 returns at most 50 rows. */
const LIST_MAX = 50;
const REGULATOR_NAMES: Readonly<Record<string, string>> = Object.freeze({
  MDCN: 'Medical and Dental Council of Nigeria', NMCN: 'Nursing and Midwifery Council of Nigeria',
});

interface ListRow extends QueryResultRow {
  id: string; state: string; version: string; submitted_at: Date; expires_at: Date; account_id: string;
  applicant_full_name: string; email: string; requested_role: string; regulator_code: string;
  issuing_authority: string; licence_number: string; licence_valid_until: string; facility_id: string;
  facility_name: string; organization_name: string; attested_by: string | null; attested_by_name: string | null;
  attested_at: Date | null; authenticator_ready: boolean; cursor_at: string;
}
interface AttestRow extends QueryResultRow {
  application_id: string; state: string; attestation_id: string; valid_until: Date | string;
  application_version: string | number; account_id: string; facility_id: string; role_code: string; replayed: boolean;
}
interface ApproveRow extends QueryResultRow {
  application_id: string; state: string; membership_id: string; account_id: string; facility_id: string;
  role_code: string; attestation_id: string; attested_by: string; application_version: string; replayed: boolean;
}
interface RejectRow extends QueryResultRow {
  application_id: string; state: string; decision_code: string; from_state: string; account_id: string;
  facility_id: string; further_applications_blocked: boolean; application_version: string; replayed: boolean;
}
interface AuditEvent { action: string; resourceType: string; resourceId: string; details: Record<string, unknown> }

/**
 * The verification queue and the two-administrator review of clinician
 * applications (ADR-066). Every command runs in one platform transaction that
 * re-checks the session and step-up for its action, then calls its SECURITY
 * DEFINER command, which repeats the permission, MFA, step-up, version,
 * reason and idempotency checks and enforces the two-person rule (the
 * approver is not the step-1 administrator; the grant is pinned to step 1's
 * attestation). Step 1 also verifies a live code from the applicant's own
 * authenticator in that transaction; a refused code is committed (it counts
 * against the applicant's 0088 failure budget) and then answered. So before
 * the code, step 1 refuses whatever it would refuse anyway (the pre-check:
 * the request's fields, the application, the key, the applicant account),
 * and, under both account locks, answers a concurrent request with the same
 * Idempotency-Key from its stored answer and checks the application again. A new
 * command (not a replay) writes its platform-scoped audit events in the same
 * transaction.
 */
@Injectable()
export class ClinicianApplicationAdminService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService,
    private readonly mfa: MfaService) {}

  /** A1: open applications oldest first; a named state newest first (overdue open ones count as expired). */
  async list(context: PlatformAccessContext, query: ListClinicianApplicationsDto) {
    const state = query.state ?? 'open';
    const limit = query.limit ?? 20;
    const filters = { state };
    const after = query.cursor ? decodeCursor(query.cursor, LIST_CURSOR, filters) : null;
    const fetch = Math.min(limit + 1, LIST_MAX);
    return this.database.withTransaction(context, async (client) => {
      try {
        const rows = (await client.query<ListRow>(
          `select id::text, state, version::text, submitted_at, expires_at, account_id::text, applicant_full_name,
                  email, requested_role, regulator_code, issuing_authority, licence_number,
                  licence_valid_until::text, facility_id::text, facility_name, organization_name,
                  attested_by::text, attested_by_name, attested_at, authenticator_ready,
                  ${cursorTimestampSql('submitted_at')} as cursor_at
             from identity.admin_list_clinician_applications($1, $2::timestamptz, $3::uuid, $4)`,
          [state, after?.at ?? null, after?.id ?? null, fetch])).rows;
        const page = rows.slice(0, limit);
        // A page of the 50-row maximum cannot look one row ahead: it offers a
        // next page whenever it is full, which may then be empty.
        const more = rows.length > limit || (fetch === limit && rows.length === limit);
        const last = page.at(-1);
        return {
          items: page.map((row) => ({
            applicationId: row.id, state: row.state, version: Number(row.version),
            submittedAt: new Date(row.submitted_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
            applicant: { accountId: row.account_id, fullName: row.applicant_full_name, email: row.email },
            profession: row.requested_role,
            regulator: { code: row.regulator_code, name: REGULATOR_NAMES[row.regulator_code] ?? row.issuing_authority },
            licenceNumber: row.licence_number, licenceValidUntil: row.licence_valid_until,
            facility: { id: row.facility_id, name: row.facility_name, organizationName: row.organization_name },
            authenticatorReady: row.authenticator_ready,
            step1: row.attested_by && row.attested_at
              ? { by: { accountId: row.attested_by, displayName: row.attested_by_name },
                at: new Date(row.attested_at).toISOString() }
              : null,
          })),
          nextCursor: more && last ? encodeCursor(LIST_CURSOR, filters, { at: last.cursor_at, id: last.id }) : null,
        };
      } catch (error) { throw adminCommandError(error); }
    }, { readOnly: true });
  }

  /** A2: one application with what both steps need (C18). */
  async detail(context: PlatformAccessContext, applicationId: string): Promise<Record<string, unknown>> {
    return this.database.withTransaction(context, async (client) => {
      try {
        const detail = (await client.query<{ detail: Record<string, unknown> }>(
          'select identity.admin_get_clinician_application($1) as detail', [applicationId])).rows[0]?.detail;
        if (!detail) throw this.unavailable();
        return detail;
      } catch (error) { throw adminCommandError(error); }
    }, { readOnly: true });
  }

  /**
   * A3, step 1. The authenticator code is not part of the request digest: a
   * replay returns the first answer without a new code.
   */
  async attest(context: PlatformAccessContext, applicationId: string, expectedVersion: number,
    input: AttestClinicianApplicationDto, idempotencyKey: string, event: SessionEventMetadata) {
    const validUntil = new Date(input.validUntil);
    if (Number.isNaN(validUntil.getTime())) {
      throw new DomainProblem(400, 'CLINICIAN_APPLICATION_COMMAND_INVALID', 'The application command is invalid');
    }
    const action: PlatformAction = 'platform.clinician-application.attest';
    const { authenticatorCode: _code, ...withoutCode } = input;
    const digest = requestDigest(`platform.clinician-application:${action}`,
      { applicationId, expectedVersion, ...withoutCode });
    const outcome = await this.database.withTransaction(context, async (client) => {
      try {
        await requirePlatformAssurance(client, context, action);
        const replay = await this.attestReplay(client, idempotencyKey, digest);
        if (replay) return replay;
        // Whatever step 1 would refuse is refused here, before the applicant's
        // code is checked (the request's own fields included): a wrong code
        // counts against the applicant.
        const applicant = await this.attestPrecheck(client, applicationId, expectedVersion, validUntil, input,
          idempotencyKey);
        if (applicant === context.actor.accountId) {
          throw new DomainProblem(403, 'WORKFORCE_SELF_CHANGE_DENIED',
            'Administrators cannot provision their own facility access');
        }
        // Under both account locks, again: a request with this key that
        // committed while this one waited is answered from its stored answer,
        // and an application that changed meanwhile is refused, before any code.
        await this.mfa.lockApplicantReview(client, { applicantAccountId: applicant,
          actorAccountId: context.actor.accountId! });
        const concurrent = await this.attestReplay(client, idempotencyKey, digest);
        if (concurrent) return concurrent;
        await this.attestPrecheck(client, applicationId, expectedVersion, validUntil, input, idempotencyKey);
        const confirmation = await this.mfa.confirmApplicantFactor(client,
          { applicantAccountId: applicant, actorAccountId: context.actor.accountId! }, input.authenticatorCode, event);
        if (confirmation.kind !== 'confirmed') return { kind: 'refused', refusal: confirmation.kind } as const;
        const row = this.single((await client.query<AttestRow>(
          'select * from identity.admin_attest_clinician_application($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [applicationId, expectedVersion, validUntil.toISOString(), input.evidenceReference,
            JSON.stringify(input.checklist), confirmation.factorId, input.reason.trim(), idempotencyKey, digest],
        )).rows);
        const validUntilText = new Date(row.valid_until).toISOString();
        await this.record(client, context, input.reason, row.replayed, [
          { action: 'admin.clinician-application.attested', resourceType: 'clinician-application',
            resourceId: row.application_id,
            details: { applicationId: row.application_id, accountId: row.account_id, facilityId: row.facility_id,
              attestationId: row.attestation_id, attestedRoles: [row.role_code], validUntil: validUntilText,
              factorId: confirmation.factorId, identityMethod: input.checklist.identityMethod,
              employmentChannel: input.checklist.employmentChannel } },
          { action: 'admin.workforce.credential.attested', resourceType: 'staff-credential-attestation',
            resourceId: row.attestation_id,
            details: { accountId: row.account_id, attestedRoles: [row.role_code], validUntil: validUntilText,
              verificationMethod: 'manual_review' } },
        ]);
        return { kind: 'answered', answer: this.attestAnswer(row) } as const;
      } catch (error) { throw adminCommandError(error); }
    });
    if (outcome.kind === 'refused') throw this.factorRefusal(outcome.refusal);
    return outcome.answer;
  }

  /** A4, step 2: a different Super Admin attaches the account and grants the role pinned to step 1. */
  async approve(context: PlatformAccessContext, applicationId: string, expectedVersion: number,
    input: ApproveClinicianApplicationDto, idempotencyKey: string) {
    const action: PlatformAction = 'platform.clinician-application.approve';
    const digest = requestDigest(`platform.clinician-application:${action}`, { applicationId, expectedVersion, ...input });
    return this.database.withTransaction(context, async (client) => {
      try {
        await requirePlatformAssurance(client, context, action);
        const row = this.single((await client.query<ApproveRow>(
          'select * from identity.admin_approve_clinician_application($1, $2, $3, $4, $5)',
          [applicationId, expectedVersion, input.reason.trim(), idempotencyKey, digest])).rows);
        await this.record(client, context, input.reason, row.replayed, [
          { action: 'admin.clinician-application.approved', resourceType: 'clinician-application',
            resourceId: row.application_id,
            details: { applicationId: row.application_id, accountId: row.account_id, facilityId: row.facility_id,
              membershipId: row.membership_id, roleCode: row.role_code, attestationId: row.attestation_id,
              attestedBy: row.attested_by } },
          { action: 'admin.workforce.membership.attached', resourceType: 'staff-membership',
            resourceId: row.membership_id,
            details: { accountId: row.account_id, facilityId: row.facility_id, accountCreated: false } },
          { action: 'admin.workforce.role.granted', resourceType: 'staff-membership', resourceId: row.membership_id,
            details: { facilityId: row.facility_id, roleCode: row.role_code, membershipActive: true,
              attestationId: row.attestation_id, renewed: false } },
        ]);
        return { applicationId: row.application_id, state: row.state, accountId: row.account_id,
          facilityId: row.facility_id, membershipId: row.membership_id, roleCode: row.role_code,
          attestationId: row.attestation_id, version: Number(row.application_version), replayed: row.replayed };
      } catch (error) { throw adminCommandError(error); }
    });
  }

  /** A5: rejects an open application with an applicant-facing code; nothing else changes. */
  async reject(context: PlatformAccessContext, applicationId: string, expectedVersion: number,
    input: RejectClinicianApplicationDto, idempotencyKey: string) {
    const action: PlatformAction = 'platform.clinician-application.reject';
    const digest = requestDigest(`platform.clinician-application:${action}`, { applicationId, expectedVersion, ...input });
    return this.database.withTransaction(context, async (client) => {
      try {
        await requirePlatformAssurance(client, context, action);
        const row = this.single((await client.query<RejectRow>(
          'select * from identity.admin_reject_clinician_application($1, $2, $3, $4, $5, $6)',
          [applicationId, expectedVersion, input.decisionCode, input.reason.trim(), idempotencyKey, digest])).rows);
        await this.record(client, context, input.reason, row.replayed, [
          { action: 'admin.clinician-application.rejected', resourceType: 'clinician-application',
            resourceId: row.application_id,
            details: { applicationId: row.application_id, accountId: row.account_id, facilityId: row.facility_id,
              decisionCode: row.decision_code, fromState: row.from_state,
              furtherApplicationsBlocked: row.further_applications_blocked } },
        ]);
        return { applicationId: row.application_id, state: row.state, decisionCode: row.decision_code,
          version: Number(row.application_version), replayed: row.replayed };
      } catch (error) { throw adminCommandError(error); }
    });
  }

  /** C19: the stored answer of an earlier step 1 with this key, as a replay. */
  private async attestReplay(client: PoolClient, idempotencyKey: string, digest: string) {
    const prior = (await client.query<{ prior: Record<string, unknown> | null }>(
      'select identity.admin_clinician_application_prior($1, $2, $3) as prior',
      ['workforce.clinician-application.attest', idempotencyKey, digest])).rows[0]?.prior;
    if (!prior) return null;
    return { kind: 'answered', answer: this.attestAnswer({ application_id: String(prior.applicationId),
      state: String(prior.state), attestation_id: String(prior.attestationId),
      valid_until: String(prior.validUntil), application_version: Number(prior.applicationVersion),
      account_id: String(prior.accountId), facility_id: String(prior.facilityId),
      role_code: String(prior.roleCode), replayed: true }) } as const;
  }

  /**
   * The step-1 pre-check: everything C20 refuses before it checks the factor
   * the code proves (the request's fields as C20 gets them, the application,
   * the key, the applicant account and staff record), before any code is
   * checked; the applicant's account otherwise.
   */
  private async attestPrecheck(client: PoolClient, applicationId: string, expectedVersion: number, validUntil: Date,
    input: AttestClinicianApplicationDto, idempotencyKey: string): Promise<string> {
    const applicant = (await client.query<{ account_id: string | null }>(
      'select identity.admin_clinician_application_attest_precheck($1, $2, $3, $4, $5, $6, $7)::text as account_id',
      [applicationId, expectedVersion, validUntil.toISOString(), input.evidenceReference, JSON.stringify(input.checklist),
        input.reason.trim(), idempotencyKey])).rows[0]?.account_id;
    if (!applicant) throw this.unavailable();
    return applicant;
  }

  private attestAnswer(row: AttestRow) {
    return { applicationId: row.application_id, state: row.state, attestationId: row.attestation_id,
      attestedRoles: [row.role_code], verificationMethod: 'manual_review' as const,
      validUntil: new Date(row.valid_until).toISOString(), version: Number(row.application_version),
      replayed: row.replayed };
  }

  private async record(client: PoolClient, context: PlatformAccessContext, reason: string, replayed: boolean,
    events: AuditEvent[]): Promise<void> {
    if (replayed) return;
    for (const event of events) {
      await this.audit.recordWithClient(client, { ...platformAuditActor(context), ...event, outcome: 'success',
        purposeOfUse: 'healthcare-operations', reason: reason.trim() });
    }
  }

  private factorRefusal(kind: 'invalid' | 'rate_limited' | 'no_factor'): DomainProblem {
    if (kind === 'rate_limited') {
      return new RetryAfterProblem(429, 'CLINICIAN_APPLICATION_AUTHENTICATOR_RATE_LIMITED',
        'Too many wrong codes for this applicant\'s authenticator; try again later', MFA_RETRY_AFTER_SECONDS);
    }
    if (kind === 'no_factor') {
      return new DomainProblem(409, 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED',
        'The applicant has no authenticator set up for this application');
    }
    return new DomainProblem(403, 'CLINICIAN_APPLICATION_AUTHENTICATOR_CODE_INVALID',
      'The applicant\'s authenticator code was not accepted');
  }

  private single<Row extends QueryResultRow>(rows: Row[]): Row {
    const row = rows[0];
    if (!row) throw this.unavailable();
    return row;
  }

  private unavailable(): DomainProblem {
    return new DomainProblem(503, 'ADMIN_COMMAND_UNAVAILABLE', 'The administration command could not be completed');
  }
}
