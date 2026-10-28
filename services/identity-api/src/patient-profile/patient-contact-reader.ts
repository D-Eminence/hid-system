import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PATIENT_PHONE_E164 } from '../identity/contact-lookup';
import { PatientProfileCrypto } from './patient-profile-crypto';

/** What GET identity/me adds (0094). */
export interface PatientContactFields {
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  hasPhoto: boolean;
}

export interface PatientContactActor {
  subject: string;
  sessionId: string;
  patientId: string;
}

interface SelfContactRow {
  email: string | null;
  email_verified: boolean;
  phone_ciphertext: Buffer | null;
  phone_lookup_hmac: string | null;
  phone_change_id: string | null;
  phone_change_key_version: string | null;
  has_photo: boolean;
}

/** The patient's active enrollment (sign-up or NIN route), as sign-up and the NIN route stored it. */
export interface ActiveEnrollmentRow {
  id: string;
  key_version: string;
  nin_route: boolean;
  contact_channel: 'phone' | 'email' | null;
  contact_ciphertext: Buffer | null;
  contact_lookup_hmac: string | null;
  contact_verified_at: Date | null;
  signup_phone_ciphertext: Buffer | null;
  signup_phone_lookup_hmac: string | null;
  profile_ciphertext: Buffer | null;
}

/**
 * The patient's own contacts for GET identity/me (0094), in the caller's
 * transaction: identity.patient_self_contact (bound to the live session)
 * answers the account email and the phone ciphertext; this decrypts the
 * phone with the scheme that wrote it: a 0094 contact change, or the
 * sign-up's declared phone, or the NIN route's verified phone contact. A
 * phone migrated from hid-1.0 is encrypted with the migration's key, which
 * Identity does not hold, so it reads as null until the patient changes it.
 * The phone is verified only while it is the NIN route's verified contact;
 * a sign-up's declared phone and a changed phone are not (production sends
 * no SMS).
 */
@Injectable()
export class PatientContactReader {
  constructor(private readonly crypto: PatientProfileCrypto) {}

  /** The caller set app.actor_subject to the patient's subject; it is the patient's subject again on return. */
  async read(client: PoolClient, actor: PatientContactActor): Promise<PatientContactFields | undefined> {
    const row = (await client.query<SelfContactRow>(
      'select email, email_verified, phone_ciphertext, phone_lookup_hmac, phone_change_id::text, '
      + 'phone_change_key_version, has_photo from identity.patient_self_contact($1, $2)',
      [actor.subject, actor.sessionId])).rows[0];
    if (!row) return undefined;
    const enrollments = row.phone_ciphertext ? await activeEnrollments(client, actor) : [];
    return {
      email: row.email ?? null,
      emailVerified: row.email_verified === true,
      phone: row.phone_ciphertext ? this.phone(row, enrollments) ?? null : null,
      phoneVerified: row.phone_lookup_hmac !== null && enrollments.some((enrollment) =>
        enrollment.contact_channel === 'phone' && enrollment.contact_verified_at !== null
        && enrollment.contact_lookup_hmac === row.phone_lookup_hmac),
      hasPhoto: row.has_photo === true,
    };
  }

  private phone(row: SelfContactRow, enrollments: readonly ActiveEnrollmentRow[]): string | undefined {
    const ciphertext = row.phone_ciphertext!;
    let phone: string | undefined;
    if (row.phone_change_id) {
      phone = this.crypto.decryptContact(row.phone_change_id, 'phone', row.phone_change_key_version, ciphertext);
    } else {
      for (const enrollment of enrollments) {
        if (enrollment.signup_phone_ciphertext?.equals(ciphertext)) {
          phone = this.crypto.decryptEnrollment(enrollment.id, 'phone', enrollment.key_version, ciphertext);
        } else if (enrollment.contact_channel === 'phone' && enrollment.contact_ciphertext?.equals(ciphertext)) {
          phone = this.crypto.decryptEnrollment(enrollment.id, 'contact', enrollment.key_version, ciphertext);
        }
        if (phone) break;
      }
    }
    return phone && PATIENT_PHONE_E164.test(phone) ? phone : undefined;
  }
}

/**
 * The patient's active enrollments. identity.public_patient_enrollments
 * answers system:auth only (forced RLS, 0051), so the read runs as
 * system:auth for the authenticated patient's own id, and the patient's
 * subject is set again before anything else runs; the caller uses the rows
 * only once the session-bound command has confirmed the patient.
 */
export async function activeEnrollments(client: PoolClient, actor: PatientContactActor): Promise<ActiveEnrollmentRow[]> {
  await client.query("select set_config('app.actor_subject','system:auth',true)");
  const rows = (await client.query<ActiveEnrollmentRow>(
    `select enrollment.id::text, enrollment.key_version, enrollment.nin_lookup_hmac is not null as nin_route,
            enrollment.contact_channel, enrollment.contact_ciphertext, enrollment.contact_lookup_hmac::text,
            enrollment.contact_verified_at, enrollment.signup_phone_ciphertext,
            enrollment.signup_phone_lookup_hmac::text, enrollment.profile_ciphertext
       from identity.public_patient_enrollments enrollment
      where enrollment.patient_id = $1 and enrollment.state = 'active'
      order by enrollment.activated_at, enrollment.id`, [actor.patientId])).rows;
  await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
  return rows;
}
