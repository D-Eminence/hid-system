import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { ClinicalRepository } from '../shared/clinical.repository';
import { BLOOD_GROUPS, GENOTYPES, type BloodGroup, type Genotype, type SaveHealthProfileDto } from './health-profile.dto';

/** What the patient entered (0094), as both routes answer it. */
export interface ReportedHealthProfile {
  bloodGroup: BloodGroup | null;
  genotype: Genotype | null;
  allergies: string | null;
  currentMedications: string | null;
  chronicConditions: string | null;
  medicalNotes: string | null;
  updatedAt: string | null;
}

/** The patient's own read adds the version their next save sends. */
export interface OwnHealthProfile extends ReportedHealthProfile {
  rowVersion: number;
}

interface ProfileRow {
  outcome?: 'saved' | 'conflict';
  blood_group: string | null;
  genotype: string | null;
  allergies: string | null;
  current_medications: string | null;
  chronic_conditions: string | null;
  medical_notes: string | null;
  row_version: string | null;
  updated_at: Date | null;
}

const TEXT_FIELDS = ['allergies', 'currentMedications', 'chronicConditions', 'medicalNotes'] as const;
/** Control characters other than the newline (the table's CHECK). */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

/**
 * A text the patient typed: CRLF and CR read as a newline, trimmed, blank is
 * null; more than 1000 characters or another control character is refused.
 */
export function healthProfileText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(field);
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text === '') return null;
  if (Array.from(text).length > 1000 || CONTROL.test(text)) throw invalid(field);
  return text;
}

function invalid(field: string): DomainProblem {
  return new DomainProblem(400, 'HEALTH_PROFILE_INVALID', 'Use at most 1000 characters, without control characters.',
    [{ field, messages: ['Use at most 1000 characters, without control characters.'] }]);
}

const SELECT_PROFILE = `select blood_group, genotype, allergies, current_medications, chronic_conditions,
  medical_notes, row_version::text, updated_at from ehr.patient_reported_health_profiles where patient_id = $1`;

/**
 * The health information a patient enters about themself (0094):
 * ehr.patient_reported_health_profiles, apart from clinician records and from
 * the imported hid-1.0 profile. The patient reads and saves it in a fresh
 * patient-self transaction (authorized by Identity, as GET ehr/me/records);
 * a clinician reads it exactly as the chart's other reads are authorized and
 * audited (ClinicalRepository.run, read_records), as "ehr.record.read" on
 * resource type patient-reported-health-profile, which the patient's access
 * log (0093) shows as a view.
 */
@Injectable()
export class HealthProfileService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityApiService,
    private readonly audit: AuditService, private readonly clinical: ClinicalRepository) {}

  async own(request: HidRequest): Promise<OwnHealthProfile> {
    const authorization = await this.authorizeSelf(request);
    const actor = request.actor!;
    return this.database.withPatientTransaction(authorization, request.correlationId, async (client) => {
      const row = (await client.query<ProfileRow>(SELECT_PROFILE, [authorization.patientId])).rows[0];
      await this.audit.recordWithClient(client, {
        correlationId: request.correlationId, actorType: 'patient', actorSubject: actor.subject,
        actorAccountId: actor.accountId, patientId: authorization.patientId,
        action: 'ehr.patient.self.health-profile.read', resourceType: 'patient-reported-health-profile',
        resourceId: authorization.patientId, outcome: 'success', purposeOfUse: 'patient-self',
      });
      return own(row);
    });
  }

  async save(request: HidRequest, input: SaveHealthProfileDto): Promise<OwnHealthProfile> {
    const bloodGroup = input.bloodGroup ?? null;
    const genotype = input.genotype ?? null;
    if (bloodGroup !== null && !BLOOD_GROUPS.includes(bloodGroup)) throw invalid('bloodGroup');
    if (genotype !== null && !GENOTYPES.includes(genotype)) throw invalid('genotype');
    const texts = TEXT_FIELDS.map((field) => healthProfileText(input[field], field));
    const authorization = await this.authorizeSelf(request);
    let row: ProfileRow | undefined;
    try {
      row = await this.database.withPatientTransaction(authorization, request.correlationId, async (client) =>
        (await client.query<ProfileRow>(
          'select outcome, blood_group, genotype, allergies, current_medications, chronic_conditions, medical_notes, '
          + 'row_version::text, updated_at from ehr.save_my_reported_health_profile($1, $2, $3, $4, $5, $6, $7)',
          [input.expectedVersion, bloodGroup, genotype, ...texts])).rows[0]);
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '42501') {
        throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
      }
      if (typeof error === 'object' && error !== null && ['22023', '23514'].includes(String((error as { code?: unknown }).code))) {
        throw new DomainProblem(400, 'HEALTH_PROFILE_INVALID', 'One or more health information values are invalid.');
      }
      throw error;
    }
    if (!row) throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
    if (row.outcome === 'conflict') {
      throw new DomainProblem(409, 'VERSION_CONFLICT', 'Your health information changed elsewhere. Reload it and try again.');
    }
    return own(row);
  }

  /** A clinician's read, with the patient's access currently granted (403 CONSENT_REQUIRED otherwise). */
  reported(patientId: string, context: DataAccessContext): Promise<ReportedHealthProfile> {
    return this.clinical.run(context, patientId, 'read_records', {
      action: 'ehr.record.read', resourceType: 'patient-reported-health-profile', resourceId: patientId,
    }, async (client: PoolClient) => {
      const { rowVersion: _rowVersion, ...value } = own((await client.query<ProfileRow>(SELECT_PROFILE, [patientId])).rows[0]);
      return { value, details: { entered: value.updatedAt !== null } };
    });
  }

  /** The session's patient, re-confirmed by Identity (as PatientRecordsService.authorizeSelf). */
  private async authorizeSelf(request: HidRequest) {
    const actor = request.actor;
    if (actor?.kind !== 'patient' || !actor.patientId || !actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
    }
    const authorization = await this.identity.authorizeSelf(request);
    if (authorization.patientId !== actor.patientId || authorization.accountId !== actor.accountId
      || authorization.subject !== actor.subject || authorization.sessionId !== actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
    }
    return authorization;
  }
}

function own(row: ProfileRow | undefined): OwnHealthProfile {
  return {
    bloodGroup: (row?.blood_group ?? null) as BloodGroup | null,
    genotype: (row?.genotype ?? null) as Genotype | null,
    allergies: row?.allergies ?? null,
    currentMedications: row?.current_medications ?? null,
    chronicConditions: row?.chronic_conditions ?? null,
    medicalNotes: row?.medical_notes ?? null,
    rowVersion: row?.row_version ? Number(row.row_version) : 0,
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}
