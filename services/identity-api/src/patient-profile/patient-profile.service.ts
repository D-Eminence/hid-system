import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requirePatient } from '../auth/patient-self.service';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { activeEnrollments } from './patient-contact-reader';
import { PatientProfileCrypto } from './patient-profile-crypto';
import { inspectProfilePhoto } from './profile-photo';
import { patientCommandProblem } from './patient-profile-problems';

export interface ProfileDetails {
  hospitalCurrentlyUsing: string | null;
  hmoName: string | null;
  rowVersion: number;
}

export interface ProfilePhoto {
  mediaType: 'image/jpeg' | 'image/png';
  bytes: Buffer;
}

interface DetailsRow {
  hospital_currently_using: string | null;
  hmo_name: string | null;
  row_version: string;
  saved?: boolean;
  outcome?: 'saved' | 'conflict';
}

/** At most 120 characters, none of them a control character (sign-up's rule for the hospital). */
const DETAIL_TEXT = /^[^\p{Cc}]{1,120}$/u;

/**
 * A profile text value as the patient typed it: trimmed, blank as null; more
 * than 120 characters or a control character is refused.
 */
export function profileDetailText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw detailsInvalid(field);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!DETAIL_TEXT.test(trimmed)) throw detailsInvalid(field);
  return trimmed;
}

function detailsInvalid(field: string): DomainProblem {
  return new DomainProblem(400, 'PROFILE_DETAILS_INVALID', 'Use at most 120 characters, without control characters.',
    [{ field, messages: ['Use at most 120 characters, without control characters.'] }]);
}

/**
 * The hospital the patient uses now, their HMO and their photo (0094). Each
 * command runs in the patient's session (identity.patient_self_session) and
 * records its own audit row; reads of the details are audited here, reads
 * of the photo are not (the header shows it on every page; a refusal is
 * still recorded by @AuditFailuresOnly).
 */
@Injectable()
export class PatientProfileService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService,
    private readonly crypto: PatientProfileCrypto) {}

  /**
   * The saved details, or, before the patient saved any, the hospital they
   * declared at sign-up (rowVersion 0; the first save creates the row).
   */
  async details(request: HidRequest): Promise<ProfileDetails> {
    const actor = requirePatient(request.actor);
    try {
      return await this.database.withSystemTransaction(request.correlationId, async (client) => {
        await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
        const row = (await client.query<DetailsRow>(
          'select hospital_currently_using, hmo_name, row_version::text, saved '
          + 'from identity.read_my_profile_details($1, $2)', [actor.subject, actor.sessionId])).rows[0];
        if (!row) throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient access is unavailable');
        const hospital = row.saved ? row.hospital_currently_using : await this.declaredHospital(client, actor);
        await this.audit.recordWithClient(client, {
          correlationId: request.correlationId, actorType: 'patient', actorSubject: actor.subject,
          actorAccountId: actor.accountId, patientId: actor.patientId, action: 'identity.patient.self.profile-details',
          resourceType: 'patient-profile-details', outcome: 'success', purposeOfUse: 'patient-self',
          sourceIp: request.ip, userAgent: request.header('user-agent'),
        });
        return { hospitalCurrentlyUsing: hospital ?? null, hmoName: row.hmo_name ?? null,
          rowVersion: Number(row.row_version) };
      });
    } catch (error) {
      throw patientCommandProblem(error);
    }
  }

  async saveDetails(request: HidRequest, input: { hospitalCurrentlyUsing?: unknown; hmoName?: unknown;
    expectedVersion: number }): Promise<ProfileDetails> {
    const actor = requirePatient(request.actor);
    const hospital = profileDetailText(input.hospitalCurrentlyUsing, 'hospitalCurrentlyUsing');
    const hmo = profileDetailText(input.hmoName, 'hmoName');
    let row: DetailsRow | undefined;
    try {
      row = await this.database.withSystemTransaction(request.correlationId, async (client) => {
        await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
        return (await client.query<DetailsRow>(
          'select outcome, hospital_currently_using, hmo_name, row_version::text '
          + 'from identity.save_my_profile_details($1, $2, $3, $4, $5)',
          [actor.subject, actor.sessionId, input.expectedVersion, hospital, hmo])).rows[0];
      });
    } catch (error) {
      throw patientCommandProblem(error);
    }
    if (!row) throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient access is unavailable');
    if (row.outcome === 'conflict') {
      throw new DomainProblem(409, 'VERSION_CONFLICT', 'Your details changed elsewhere. Reload them and try again.');
    }
    return { hospitalCurrentlyUsing: row.hospital_currently_using ?? null, hmoName: row.hmo_name ?? null,
      rowVersion: Number(row.row_version) };
  }

  async savePhoto(request: HidRequest, input: { mediaType: unknown; data: unknown }): Promise<{ hasPhoto: true }> {
    const actor = requirePatient(request.actor);
    const photo = inspectProfilePhoto(input.mediaType, input.data);
    this.crypto.assertConfigured();
    const ciphertext = this.crypto.encryptPhoto(actor.patientId, photo.sha256, photo.bytes);
    let saved: boolean | undefined;
    try {
      saved = await this.database.withSystemTransaction(request.correlationId, async (client) => {
        await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
        return (await client.query<{ saved: boolean }>(
          'select identity.set_my_profile_photo($1, $2, $3, $4, $5, $6, $7, $8, $9) as saved',
          [actor.subject, actor.sessionId, ciphertext, photo.mediaType, photo.sha256, photo.bytes.length,
            photo.width, photo.height, this.crypto.keyVersion])).rows[0]?.saved;
      });
    } catch (error) {
      throw patientCommandProblem(error);
    }
    if (saved !== true) throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient access is unavailable');
    return { hasPhoto: true };
  }

  async photo(request: HidRequest): Promise<ProfilePhoto> {
    const actor = requirePatient(request.actor);
    let row: { ciphertext: Buffer; media_type: 'image/jpeg' | 'image/png'; sha256: string; key_version: string }
      | undefined;
    try {
      row = await this.database.withSystemTransaction(request.correlationId, async (client) => {
        await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
        return (await client.query<NonNullable<typeof row>>(
          'select ciphertext, media_type, sha256, key_version from identity.read_my_profile_photo($1, $2)',
          [actor.subject, actor.sessionId])).rows[0];
      });
    } catch (error) {
      throw patientCommandProblem(error);
    }
    if (!row) throw new DomainProblem(404, 'PHOTO_NOT_FOUND', 'No photo is saved on your profile');
    const bytes = this.crypto.decryptPhoto(actor.patientId, row.sha256, row.key_version, row.ciphertext);
    return { mediaType: row.media_type, bytes };
  }

  async removePhoto(request: HidRequest): Promise<{ hasPhoto: false }> {
    const actor = requirePatient(request.actor);
    try {
      await this.database.withSystemTransaction(request.correlationId, async (client) => {
        await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
        await client.query('select identity.remove_my_profile_photo($1, $2)', [actor.subject, actor.sessionId]);
      });
    } catch (error) {
      throw patientCommandProblem(error);
    }
    return { hasPhoto: false };
  }

  /** The hospital a sign-up declared, from its encrypted profile (0092), or null. */
  private async declaredHospital(client: PoolClient, actor: { subject: string; sessionId: string; patientId: string })
    : Promise<string | null> {
    const signup = (await activeEnrollments(client, actor)).find((enrollment) => !enrollment.nin_route);
    if (!signup?.profile_ciphertext) return null;
    const json = this.crypto.decryptEnrollment(signup.id, 'profile', signup.key_version, signup.profile_ciphertext);
    if (!json) return null;
    try {
      const value = (JSON.parse(json) as { hospitalCurrentlyUsing?: unknown }).hospitalCurrentlyUsing;
      return typeof value === 'string' && value.trim() === value && DETAIL_TEXT.test(value) ? value : null;
    } catch {
      return null;
    }
  }
}
