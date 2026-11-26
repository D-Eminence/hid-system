import { Injectable, Optional } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { CollectedFieldProtector, registrationCaseContactLabel } from '../identity/collected-field-protector';
import { PATIENT_PHONE_E164 } from '../identity/contact-lookup';

/** Route 11 (APPT-1, 0161; Q-APPT-7 A): one booked appointment on the printable call list. */
export interface AppointmentCallListItem {
  appointmentId: string;
  startsAt: string;
  clinicName: string | null;
  clinicianMembershipId: string | null;
  fullName: string;
  healthIdLast4: string;
  /** E.164, or null when this facility recorded no phone (or it cannot be read). */
  phone: string | null;
  /** Where the phone comes from: this facility's own record of the patient, or nothing. */
  phoneSource: 'facility_contact' | null;
}

interface CallListRow extends QueryResultRow {
  appointment_id: string;
  starts_at: Date;
  clinic_name: string | null;
  clinician_membership_id: string | null;
  full_name: string;
  health_id_last4: string;
  registration_case_id: string | null;
  phone_ciphertext: Buffer | null;
  key_version: string | null;
}

export const CALL_LIST_SQL = `select appointment_id::text, starts_at, clinic_name, clinician_membership_id::text,
  full_name, health_id_last4, registration_case_id::text, phone_ciphertext, key_version
  from identity.appointment_call_list($1::date, $2, $3)`;

export const CALL_LIST_MESSAGES = {
  notAvailable: 'Appointments are not available yet.',
  notAllowed: 'Only the front desk, clinicians and doctors of this facility can print the call list.',
} as const;

export function appointmentsEnabled(): boolean {
  return getEnvironment().APPOINTMENTS_ENABLED;
}

export function appointmentsNotAvailable(): DomainProblem {
  return new DomainProblem(503, 'APPOINTMENTS_NOT_AVAILABLE', CALL_LIST_MESSAGES.notAvailable);
}

/** The session's codes at this facility, checked before the database decides again (plain words, never "permission"). */
export function requireCallListAccess(request: HidRequest): void {
  if (!(request.actor?.permissions ?? []).includes('ehr.appointment.write')) {
    throw new DomainProblem(403, 'APPOINTMENT_NOT_ALLOWED', CALL_LIST_MESSAGES.notAllowed);
  }
}

/**
 * The printable call list (route 11). identity-api serves it because only
 * Identity holds the key of the phones the registration desk recorded (0114,
 * 0130): identity.appointment_call_list answers this facility's booked
 * appointments of one Lagos day with the newest unerased phone ciphertext this
 * facility recorded and its registration case (the associated data), audits
 * the list and each patient shown, and this decrypts the phone. No reason,
 * visit type or date of birth; never the patient's sign-in phone (Q-APPT-7 A).
 */
@Injectable()
export class AppointmentCallListService {
  private readonly protector: CollectedFieldProtector;

  constructor(private readonly database: DatabaseService, @Optional() protector?: CollectedFieldProtector) {
    this.protector = protector ?? new CollectedFieldProtector();
  }

  async list(context: DataAccessContext, day: string, clinicId: string | null, clinicianMembershipId: string | null):
    Promise<{ items: AppointmentCallListItem[] }> {
    let rows: CallListRow[];
    try {
      rows = await this.database.withTransaction(context, async (client) =>
        (await client.query<CallListRow>(CALL_LIST_SQL, [day, clinicId, clinicianMembershipId])).rows);
    } catch (error) {
      throw translate(error);
    }
    return { items: rows.map((row) => {
      const phone = this.phone(row);
      return {
        appointmentId: row.appointment_id,
        startsAt: new Date(row.starts_at).toISOString(),
        clinicName: row.clinic_name,
        clinicianMembershipId: row.clinician_membership_id,
        fullName: row.full_name,
        healthIdLast4: row.health_id_last4,
        phone,
        phoneSource: phone === null ? null : 'facility_contact',
      };
    }) };
  }

  private phone(row: CallListRow): string | null {
    if (!row.phone_ciphertext || !row.registration_case_id || !row.key_version) return null;
    try {
      const phone = this.protector.decrypt(registrationCaseContactLabel(row.registration_case_id, 'phone'),
        row.key_version, row.phone_ciphertext);
      return PATIENT_PHONE_E164.test(phone) ? phone : null;
    } catch {
      // A phone written under an older key: the desk sees no number rather than no list.
      return null;
    }
  }
}

export function translate(error: unknown): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  if (code === '42501') return new DomainProblem(403, 'APPOINTMENT_NOT_ALLOWED', CALL_LIST_MESSAGES.notAllowed);
  if (code === '22023' && message === 'APPOINTMENT_DIRECT_CARE_ONLY') {
    return new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'X-Purpose-Of-Use must be direct-care for appointments');
  }
  if (code === '22023') return new DomainProblem(400, 'VALIDATION_FAILED', 'Check the highlighted fields.');
  if (code === '42883' || code === '42P01') return appointmentsNotAvailable();
  return error;
}
