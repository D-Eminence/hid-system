import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService, type AuditEventInput } from '../audit/audit.service';
import { keepsFacilityChoice } from '../auth/facility-selection';
import { OPEN_PATIENT_HOURS, OPEN_PATIENT_INVALID, OPEN_PATIENT_UNAVAILABLE_EVENT, openPatientEnabled } from '../auth/open-patient';
import { DomainProblem } from '../common/problem';
import type { ActorContext, DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import { ninStatusOf, patientHasVerifiedNinSql, type NinStatus } from '../identity/nin-status';
import { isDatabaseError } from '../patient-safety/database-error';

/** The two purposes a patient can be opened with: break-glass opens with `emergency`. */
export type OpenPatientPurpose = 'direct-care' | 'emergency';
export const OPEN_PATIENT_PURPOSES: readonly OpenPatientPurpose[] = ['direct-care', 'emergency'];

export const OPEN_PATIENT_MESSAGES = {
  notAllowed: "You don't have access to this patient's records now. Ask for their Access PIN or send an access request.",
  purposeRequired: 'Choose why you are opening this record.',
  unavailable: 'Something went wrong on our side. Please try again.',
  signInAgain: 'Please sign in again.',
  facilityDenied: 'You are not working at this facility.',
} as const;

/** The card a restore carries: a 0132 search card's fields, with no full Health ID and no matchRef. */
export interface OpenPatientCard {
  fullName: string;
  sex: string | null;
  dateOfBirth: string | null;
  healthIdLast4: string | null;
  ninStatus: NinStatus;
}

export type OpenPatientRestore =
  | { state: 'restored'; patientId: string; purpose: OpenPatientPurpose; expiresAt: string; card: OpenPatientCard }
  | { state: 'ended' | 'expired' | 'unavailable' };

/** Who is asking, as the routes and the session read know it. */
export interface OpenPatientRequest {
  correlationId: string;
  sourceIp?: string;
  userAgent?: string;
}

/**
 * The stored row, read through the presented session only while it is a live
 * staff session of the account (0129's read): a signed-out, revoked or expired
 * sign-in never reads its open patient again.
 */
export const OPEN_PATIENT_READ_SQL = `select open_patient.patient_id::text, open_patient.purpose,
       open_patient.facility_id::text, open_patient.expires_at, open_patient.row_version::text,
       open_patient.expires_at <= clock_timestamp() as expired
  from auth.sessions session
  join auth.session_open_patient open_patient
    on open_patient.family_id = session.family_id and open_patient.account_id = session.account_id
 where session.id = $1
   and session.account_id = $2
   and session.session_kind = 'staff'
   and session.revoked_at is null
   and session.expires_at > clock_timestamp()
   and session.absolute_expires_at > clock_timestamp()`;

/**
 * The presented session, locked FOR SHARE while it is a live staff session of
 * the account (0129's store): sign-out, rotation and revocation each either
 * wait for this transaction or have ended the session first.
 */
export const OPEN_PATIENT_PRESENTED_SQL = `select session.family_id::text, session.absolute_expires_at
  from auth.sessions session
 where session.id = $1
   and session.account_id = $2
   and session.session_kind = 'staff'
   and session.revoked_at is null
   and session.expires_at > clock_timestamp()
   and session.absolute_expires_at > clock_timestamp()
   for share`;

/**
 * One row per sign-in: a new set replaces the old one. The set time is taken
 * once, and the row ends at the earlier of 8 hours later and the sign-in's own
 * end; a sign-in ending at that very moment stores nothing.
 */
export const OPEN_PATIENT_STORE_SQL = `insert into auth.session_open_patient
       (family_id, account_id, facility_id, membership_id, patient_id, purpose, set_at, expires_at)
select $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, moment.at,
       least(moment.at + make_interval(hours => ${OPEN_PATIENT_HOURS}), $7::timestamptz)
  from (select clock_timestamp() as at) moment
 where $7::timestamptz > moment.at
on conflict (family_id) do update
   set facility_id = excluded.facility_id, membership_id = excluded.membership_id,
       patient_id = excluded.patient_id, purpose = excluded.purpose,
       set_at = excluded.set_at, expires_at = excluded.expires_at,
       row_version = auth.session_open_patient.row_version + 1
returning expires_at`;

/** The user's clear: the presented session's family, of the same account, whatever its state. */
export const OPEN_PATIENT_CLEAR_SQL = `delete from auth.session_open_patient open_patient
  using auth.sessions session
 where session.id = $1
   and session.account_id = $2
   and open_patient.family_id = session.family_id
   and open_patient.account_id = session.account_id
returning open_patient.patient_id::text`;

/**
 * An `ended` or `expired` read clears the row it read, and only that version:
 * a set from another tab since then is kept.
 */
export const OPEN_PATIENT_CLEAR_READ_SQL = `delete from auth.session_open_patient open_patient
  using auth.sessions session
 where session.id = $1
   and session.account_id = $2
   and open_patient.family_id = session.family_id
   and open_patient.account_id = session.account_id
   and open_patient.row_version = $3::bigint`;

/**
 * The card, read as the member at the reported facility with the stored
 * purpose, so identity.patients' row-level security admits the patient only
 * under the same consent rule as the access check that has just allowed it.
 * An inactive patient has no card (the read is `ended`).
 */
export const OPEN_PATIENT_CARD_SQL = `select patient_row.full_name, patient_row.gender as sex,
       patient_row.dob::text as date_of_birth, right(patient_row.hid_code, 4) as health_id_last4,
       ${patientHasVerifiedNinSql('patient_row.id')} as nin_verified
  from identity.patients patient_row
 where patient_row.id = $1
   and patient_row.status = 'active'`;

interface StoredRow {
  patient_id: string;
  purpose: string;
  facility_id: string;
  expires_at: Date | string;
  row_version: string;
  expired: boolean;
}

interface CardRow {
  full_name: string | null;
  sex: string | null;
  date_of_birth: string | null;
  health_id_last4: string | null;
  nin_verified: boolean | null;
}

type StaffSignIn = ActorContext & { sessionId: string };

/**
 * SX-8 (0140): the patient a staff sign-in has open, kept across a reload.
 * The row grants nothing. It is stored only after the read_records access
 * check (IdentityService.precheck: no "Your records were opened" notice, no
 * access-history entry) allows it, and every session read that finds it
 * checks again before sending a card.
 */
@Injectable()
export class OpenPatientService {
  private readonly logger = new Logger(OpenPatientService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly identity: IdentityService,
    private readonly audit: AuditService,
  ) {}

  /** Whether this actor's session read may carry `openPatient` at all. */
  reportsFor(actor: ActorContext): actor is StaffSignIn {
    return openPatientEnabled() && keepsFacilityChoice(actor) && actor.facility !== undefined;
  }

  /**
   * POST /auth/open-patient. The caller is a staff session of an Identity
   * sign-in at its X-Facility-ID facility (SecurityGuard). A refused and an
   * unknown patient get the same 403, so the route cannot test whether a UUID
   * exists; nothing is stored for either.
   */
  async set(actor: StaffSignIn, patientId: string, purpose: OpenPatientPurpose, request: OpenPatientRequest) {
    const facility = actor.facility!;
    const context = this.context(actor, purpose, request.correlationId);
    let allowed: boolean;
    try {
      allowed = (await this.identity.precheck(patientId, 'read_records', purpose, context)).allowed;
    } catch {
      this.logger.warn({ event: OPEN_PATIENT_UNAVAILABLE_EVENT, operation: 'check' });
      await this.auditQuietly(this.event(actor, request, 'auth.open-patient.set', 'failure', patientId, purpose,
        { reason: 'unavailable' }));
      throw new DomainProblem(503, 'DEPENDENCY_UNAVAILABLE', OPEN_PATIENT_MESSAGES.unavailable);
    }
    if (!allowed) {
      await this.audit.record(this.event(actor, request, 'auth.open-patient.set', 'denied', patientId, purpose,
        { reason: 'not_allowed' }));
      throw new DomainProblem(403, 'OPEN_PATIENT_NOT_ALLOWED', OPEN_PATIENT_MESSAGES.notAllowed);
    }
    let outcome: { state: 'kept'; expiresAt: Date } | 'session_ended' | 'refused';
    try {
      outcome = await this.database.withSystemTransaction(request.correlationId, async (client) => {
        const presented = await client.query<{ family_id: string; absolute_expires_at: Date }>(OPEN_PATIENT_PRESENTED_SQL,
          [actor.sessionId, actor.accountId]);
        const session = presented.rows[0];
        if (presented.rowCount !== 1 || !session) return 'session_ended' as const;
        const stored = await client.query<{ expires_at: Date }>(OPEN_PATIENT_STORE_SQL, [session.family_id, actor.accountId,
          facility.id, facility.membershipId, patientId, purpose, session.absolute_expires_at]);
        const expiresAt = stored.rows[0]?.expires_at;
        if (stored.rowCount !== 1 || !expiresAt) return 'session_ended' as const;
        await this.audit.recordWithClient(client, this.event(actor, request, 'auth.open-patient.set', 'success',
          patientId, purpose, { expiresAt: new Date(expiresAt).toISOString() }));
        return { state: 'kept' as const, expiresAt: new Date(expiresAt) };
      });
    } catch (error) {
      if (isDatabaseError(error) && error.code === '23514' && error.message === OPEN_PATIENT_INVALID) {
        outcome = 'refused';
      } else {
        this.logger.warn({ event: OPEN_PATIENT_UNAVAILABLE_EVENT, operation: 'store' });
        throw new DomainProblem(503, 'DEPENDENCY_UNAVAILABLE', OPEN_PATIENT_MESSAGES.unavailable);
      }
    }
    if (outcome === 'session_ended') {
      throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', OPEN_PATIENT_MESSAGES.signInAgain);
    }
    if (outcome === 'refused') {
      // 0140's guard: the membership, facility, account or sign-in ended after
      // the request was authorized (0129's admission).
      await this.auditQuietly(this.event(actor, request, 'auth.open-patient.set', 'denied', patientId, purpose,
        { reason: 'facility_access_denied' }));
      throw new DomainProblem(403, 'FACILITY_ACCESS_DENIED', OPEN_PATIENT_MESSAGES.facilityDenied);
    }
    return { openPatient: { state: outcome.state, patientId, expiresAt: outcome.expiresAt.toISOString() } };
  }

  /** POST /auth/open-patient/clear: safe to repeat; one audit row each time. */
  async clear(actor: StaffSignIn, request: OpenPatientRequest) {
    try {
      await this.database.withSystemTransaction(request.correlationId, async (client) => {
        const cleared = await client.query<{ patient_id: string }>(OPEN_PATIENT_CLEAR_SQL, [actor.sessionId, actor.accountId]);
        const patientId = cleared.rows[0]?.patient_id;
        await this.audit.recordWithClient(client, this.event(actor, request, 'auth.open-patient.clear', 'success',
          patientId, undefined, { cleared: patientId !== undefined }));
      });
    } catch {
      this.logger.warn({ event: OPEN_PATIENT_UNAVAILABLE_EVENT, operation: 'clear' });
      throw new DomainProblem(503, 'DEPENDENCY_UNAVAILABLE', OPEN_PATIENT_MESSAGES.unavailable);
    }
    return { openPatient: null };
  }

  /**
   * GET /auth/session's `openPatient` for a staff sign-in reported at
   * `actor.facility`. Undefined (the field is absent) when nothing is stored
   * or it was kept at another facility. Never throws: a failed read, check,
   * card read or audit row answers 'unavailable' with no card.
   */
  async restore(actor: StaffSignIn, request: OpenPatientRequest): Promise<OpenPatientRestore | undefined> {
    const facility = actor.facility!;
    let stored: StoredRow | undefined;
    try {
      stored = (await this.database.query<StoredRow>(OPEN_PATIENT_READ_SQL, [actor.sessionId, actor.accountId])).rows[0];
    } catch {
      this.logger.warn({ event: OPEN_PATIENT_UNAVAILABLE_EVENT, operation: 'read' });
      return { state: 'unavailable' };
    }
    if (!stored || stored.facility_id !== facility.id) return undefined;
    const purpose = stored.purpose as OpenPatientPurpose;
    if (!OPEN_PATIENT_PURPOSES.includes(purpose)) return undefined;
    const patientId = stored.patient_id;
    if (stored.expired === true) return this.endRead(actor, request, stored, 'expired');

    const context = this.context(actor, purpose, request.correlationId);
    let card: OpenPatientCard | undefined;
    try {
      const decision = await this.identity.precheck(patientId, 'read_records', purpose, context);
      if (decision.allowed) card = await this.card(patientId, context);
    } catch {
      this.logger.warn({ event: OPEN_PATIENT_UNAVAILABLE_EVENT, operation: 'check' });
      await this.auditQuietly(this.event(actor, request, 'auth.open-patient.restore', 'failure', patientId, purpose,
        { state: 'unavailable' }));
      return { state: 'unavailable' };
    }
    if (!card) return this.endRead(actor, request, stored, 'ended');
    const expiresAt = new Date(stored.expires_at).toISOString();
    try {
      await this.audit.record(this.event(actor, request, 'auth.open-patient.restore', 'success', patientId, purpose,
        { state: 'restored' }));
    } catch {
      // No card leaves without its audit row.
      this.logger.warn({ event: OPEN_PATIENT_UNAVAILABLE_EVENT, operation: 'audit' });
      return { state: 'unavailable' };
    }
    return { state: 'restored', patientId, purpose, expiresAt, card };
  }

  /** An `ended` or `expired` read: the row read is cleared with its audit row; a failure answers 'unavailable'. */
  private async endRead(actor: StaffSignIn, request: OpenPatientRequest, stored: StoredRow,
    state: 'ended' | 'expired'): Promise<OpenPatientRestore> {
    try {
      await this.database.withSystemTransaction(request.correlationId, async (client: PoolClient) => {
        await client.query(OPEN_PATIENT_CLEAR_READ_SQL, [actor.sessionId, actor.accountId, stored.row_version]);
        await this.audit.recordWithClient(client, this.event(actor, request, 'auth.open-patient.restore', 'success',
          stored.patient_id, stored.purpose, { state }));
      });
    } catch {
      this.logger.warn({ event: OPEN_PATIENT_UNAVAILABLE_EVENT, operation: 'clear' });
      return { state: 'unavailable' };
    }
    return { state };
  }

  private async card(patientId: string, context: DataAccessContext): Promise<OpenPatientCard | undefined> {
    const row = await this.database.withTransaction(context, async (client) =>
      (await client.query<CardRow>(OPEN_PATIENT_CARD_SQL, [patientId])).rows[0], { readOnly: true });
    if (!row || typeof row.full_name !== 'string') return undefined;
    return {
      fullName: row.full_name,
      sex: row.sex ?? null,
      dateOfBirth: row.date_of_birth ?? null,
      healthIdLast4: row.health_id_last4 ?? null,
      ninStatus: ninStatusOf(row.nin_verified),
    };
  }

  /** The member at the reported facility, with the purpose the patient was opened with. */
  private context(actor: StaffSignIn, purpose: OpenPatientPurpose, correlationId: string): DataAccessContext {
    return { actor, facilityId: actor.facility!.id, membershipId: actor.facility!.membershipId, correlationId,
      purposeOfUse: purpose };
  }

  private event(actor: StaffSignIn, request: OpenPatientRequest, action: string, outcome: 'success' | 'denied' | 'failure',
    patientId: string | undefined, purpose: string | undefined, details: Record<string, unknown>): AuditEventInput {
    return {
      correlationId: request.correlationId,
      actorType: 'staff',
      actorSubject: actor.subject,
      actorAccountId: actor.accountId,
      actorMembershipId: actor.facility?.membershipId,
      organizationId: actor.facility?.organizationId,
      facilityId: actor.facility?.id,
      ...(patientId ? { patientId } : {}),
      action,
      resourceType: 'session',
      resourceId: actor.sessionId,
      outcome,
      ...(purpose ? { purposeOfUse: purpose } : {}),
      sourceIp: request.sourceIp,
      userAgent: request.userAgent,
      details,
    };
  }

  /** A failure's own audit row never replaces the answer it explains. */
  private async auditQuietly(event: AuditEventInput): Promise<void> {
    try {
      await this.audit.record(event);
    } catch {
      this.logger.warn({ event: OPEN_PATIENT_UNAVAILABLE_EVENT, operation: 'audit' });
    }
  }
}
