import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { ClinicalRepository } from '../shared/clinical.repository';
import { currentVitalJoin, currentVitalProjection, recordedVitalProjection } from '../vitals/vital-current-values';

/**
 * Categories released to the patient (INTERFACE_CONTRACT.md, "Patient sessions and self service"):
 * completed encounters and current signed/amended note revisions, the only categories with
 * patient-self row-level security policies (migration 0030). The service defines the release
 * set itself, so a later policy cannot widen the patient response on its own.
 */
export const PATIENT_RELEASED = ['encounters', 'notes'] as const;
/** Not released to the patient until the release decision; returned empty and named as withheld. */
export const PATIENT_WITHHELD = ['vitals', 'diagnoses', 'prescriptions', 'labRequests', 'documents'] as const;

/** Rows each summary section shows at most, newest first. */
export const SECTION_LIMITS = {
  encounters: 50, notes: 50, vitals: 100, diagnoses: 100, prescriptions: 100, labRequests: 100, documents: 100,
} as const;
type Section = keyof typeof SECTION_LIMITS;
/** The single `limit` existing clients read: the smallest section cap, the one encounters and notes have. */
const SUMMARY_LIMIT = 50;

interface SectionRows { rows: QueryResultRow[]; truncated: boolean }

@Injectable()
export class PatientRecordsService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityApiService,
    private readonly audit: AuditService, private readonly clinical: ClinicalRepository) {}

  async self(request: HidRequest) {
    const actor = request.actor;
    if (actor?.kind !== 'patient' || !actor.patientId || !actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
    }
    const authorization = await this.identity.authorizeSelf(request);
    if (authorization.patientId !== actor.patientId || authorization.accountId !== actor.accountId
      || authorization.subject !== actor.subject || authorization.sessionId !== actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
    }
    return this.database.withPatientTransaction(authorization, request.correlationId, async (client) => {
      const value = await this.readSelf(client, authorization.patientId);
      await this.audit.recordWithClient(client, {
        correlationId: request.correlationId, actorType: 'patient', actorSubject: actor.subject,
        actorAccountId: actor.accountId, patientId: authorization.patientId,
        action: 'ehr.patient.self.records.read', resourceType: 'patient-record-summary', outcome: 'success',
        purposeOfUse: 'patient-self', details: {
          encounterCount: value.encounters.length,
          noteCount: value.notes.length,
          withheldCategories: value.withheld,
        },
      });
      return value;
    });
  }

  emergency(patientId: string, context: DataAccessContext) {
    return this.clinical.run(context, patientId, 'read_records', {
      action: 'ehr.emergency.records.read', resourceType: 'patient-record-summary', breakGlassOnly: true,
    }, async (client) => {
      const value = await this.readEmergency(client, patientId, context.facilityId);
      // Counts only: what this read disclosed, recorded with the success audit in the same transaction.
      return {
        value,
        details: {
          encounterCount: value.encounters.length,
          noteCount: value.notes.length,
          vitalCount: value.vitals.length,
          correctedVitalCount: value.vitals.filter((vital) => Number(vital.currentCorrectionNo) > 0).length,
          diagnosisCount: value.diagnoses.length,
          prescriptionCount: value.prescriptions.length,
          labRequestCount: value.labRequests.length,
          documentCount: value.documents.length,
        },
      };
    });
  }

  /** The patient's own summary: the released categories only; the others are named as withheld. */
  private async readSelf(client: PoolClient, patientId: string) {
    const values = [patientId];
    const encounters = await this.section(client, 'encounters', encountersSql(''), values);
    const notes = await this.section(client, 'notes', notesSql(''), values);
    return {
      encounters: encounters.rows,
      notes: notes.rows,
      vitals: [],
      diagnoses: [],
      prescriptions: [],
      labRequests: [],
      documents: [],
      released: [...PATIENT_RELEASED],
      withheld: [...PATIENT_WITHHELD],
      limits: { encounters: SECTION_LIMITS.encounters, notes: SECTION_LIMITS.notes },
      truncated: { encounters: encounters.truncated, notes: notes.truncated },
      limit: SUMMARY_LIMIT,
    };
  }

  /** The break-glass summary of one facility. Which categories it returns is unchanged pending a decision. */
  private async readEmergency(client: PoolClient, patientId: string, facilityId: string) {
    const values = [patientId, facilityId];
    const encounters = await this.section(client, 'encounters', encountersSql(' and facility_id=$2'), values);
    const notes = await this.section(client, 'notes', notesSql(' and n.facility_id=$2'), values);

    const vitals = await this.section(client, 'vitals', `select v.id,v.encounter_id as "encounterId",
      v.facility_id as "facilityId",v.recorded_at as "recordedAt",v.source,
      ${currentVitalProjection('v', 'c')},
      ${recordedVitalProjection('v')},c.reason as "correctionReason"
      from ehr.vitals v ${currentVitalJoin('v', 'c')}
      where v.patient_id=$1 and v.facility_id=$2 order by v.recorded_at desc,v.id desc`, values);

    const diagnoses = await this.section(client, 'diagnoses', `select id,encounter_id as "encounterId",
      facility_id as "facilityId",code_system as "codeSystem",code,display,clinical_status as "clinicalStatus",
      verification_status as "verificationStatus",onset_at as "onsetAt",abatement_at as "abatementAt",notes
      from ehr.diagnoses where patient_id=$1 and facility_id=$2
      order by created_at desc,id desc`, values);

    const prescriptions = await this.section(client, 'prescriptions', `select id,encounter_id as "encounterId",
      facility_id as "facilityId",medication_code_system as "medicationCodeSystem",medication_code as "medicationCode",
      medication_display as "medicationDisplay",dose_quantity as "doseQuantity",dose_unit as "doseUnit",
      route_code as "routeCode",frequency,instructions,starts_on as "startsOn",ends_on as "endsOn",status
      from ehr.prescriptions where patient_id=$1 and facility_id=$2
      order by created_at desc,id desc`, values);

    const labRequests = await this.section(client, 'labRequests', `select id,encounter_id as "encounterId",
      facility_id as "facilityId",test_code_system as "testCodeSystem",test_code as "testCode",
      test_display as "testDisplay",priority,status,specimen_type_code as "specimenTypeCode",
      clinical_information as "clinicalInformation",external_order_reference as "externalOrderReference",
      created_at as "createdAt"
      from ehr.lab_requests where patient_id=$1 and facility_id=$2
      order by created_at desc,id desc`, values);

    // The effective status the staff list and download use: available only when the latest scan of the
    // exact stored object is clean (ehr.documents_effective, migration 0009).
    const documents = await this.section(client, 'documents', `select id,encounter_id as "encounterId",
      facility_id as "facilityId",original_file_name as "fileName",
      coalesce(detected_media_type,declared_media_type) as "mediaType",size_bytes as "sizeBytes",
      classification,status,scan_status as "scanStatus",created_at as "createdAt"
      from ehr.documents_effective where patient_id=$1 and facility_id=$2 and status='available'
      order by created_at desc,id desc`, values);

    return {
      encounters: encounters.rows,
      notes: notes.rows,
      vitals: vitals.rows,
      diagnoses: diagnoses.rows,
      prescriptions: prescriptions.rows,
      labRequests: labRequests.rows,
      documents: documents.rows,
      limits: { ...SECTION_LIMITS },
      truncated: {
        encounters: encounters.truncated,
        notes: notes.truncated,
        vitals: vitals.truncated,
        diagnoses: diagnoses.truncated,
        prescriptions: prescriptions.truncated,
        labRequests: labRequests.truncated,
        documents: documents.truncated,
      },
      limit: SUMMARY_LIMIT,
    };
  }

  /** Reads one row more than the section shows, so truncation is known rather than guessed. */
  private async section(client: PoolClient, name: Section, sql: string, values: readonly string[]): Promise<SectionRows> {
    const limit = SECTION_LIMITS[name];
    const result = await client.query(`${sql} limit ${limit + 1}`, [...values]);
    return { rows: result.rows.slice(0, limit), truncated: result.rows.length > limit };
  }
}

function encountersSql(facilityClause: string): string {
  return `select id,facility_id as "facilityId",encounter_type as "encounterType",
    status,started_at as "startedAt",ended_at as "endedAt" from ehr.encounters
    where patient_id=$1 and status='completed'${facilityClause} order by started_at desc,id desc`;
}

function notesSql(facilityClause: string): string {
  return `select n.id,n.encounter_id as "encounterId",n.facility_id as "facilityId",
    n.note_type as "noteType",n.title,n.status,n.current_revision_no as "revisionNo",r.content,n.signed_at as "signedAt"
    from ehr.clinical_notes n join ehr.clinical_note_revisions r
      on r.clinical_note_id=n.id and r.revision_no=n.current_revision_no
      and r.patient_id=n.patient_id and r.facility_id=n.facility_id
    where n.patient_id=$1 and n.status in ('signed','amended')${facilityClause}
    order by n.signed_at desc,n.id desc`;
}
