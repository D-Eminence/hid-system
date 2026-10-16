import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { STORAGE_PROVIDER, StoredObjectIntegrityError, type StorageProvider } from '../../storage/storage.types';
import { ClinicalRepository } from '../shared/clinical.repository';
import { PatientRecordRelease } from './patient-release';

/** Rows each emergency summary section shows at most, newest first. */
export const SECTION_LIMITS = {
  encounters: 50, notes: 50, vitals: 100, diagnoses: 100, prescriptions: 100, labRequests: 100, documents: 100,
} as const;
type Section = keyof typeof SECTION_LIMITS;
/** The single `limit` existing clients read: the smallest section cap, the one encounters and notes have. */
const SUMMARY_LIMIT = 50;

/**
 * The read permission each further emergency category needs: the one its own routes require (vitals,
 * diagnoses, prescriptions, lab-requests and document controllers). The summary route itself requires
 * the encounter and note reads, so those two are always read.
 */
export const EMERGENCY_CATEGORY_PERMISSIONS = {
  vitals: 'ehr.vital.read',
  diagnoses: 'ehr.diagnosis.read',
  prescriptions: 'ehr.prescription.read',
  labRequests: 'ehr.lab-request.read',
  documents: 'ehr.document.read',
} as const;
type EmergencyCategory = keyof typeof EMERGENCY_CATEGORY_PERMISSIONS;
const EMERGENCY_CATEGORIES = Object.keys(EMERGENCY_CATEGORY_PERMISSIONS) as EmergencyCategory[];
/** The audit count each further emergency category records when it is read. */
const EMERGENCY_COUNT_KEYS: Readonly<Record<EmergencyCategory, string>> = {
  vitals: 'vitalCount', diagnoses: 'diagnosisCount', prescriptions: 'prescriptionCount',
  labRequests: 'labRequestCount', documents: 'documentCount',
};

interface SectionRows { rows: QueryResultRow[]; truncated: boolean }

/** The stored document a patient download signs, as its read names the columns. */
interface PatientDocumentRow extends QueryResultRow {
  id: string;
  storageBucket: string;
  storageKey: string;
  objectVersionId: string;
  sha256Hex: string;
  sizeBytes: string;
  mediaType: string;
  fileName: string;
}

const DOCUMENT_NOT_AVAILABLE = () =>
  new DomainProblem(404, 'DOCUMENT_NOT_AVAILABLE', 'The document is not available');

@Injectable()
export class PatientRecordsService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityApiService,
    private readonly audit: AuditService, private readonly clinical: ClinicalRepository,
    private readonly release: PatientRecordRelease,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  /**
   * The patient's own summary: the release set (PatientRecordRelease), read in
   * the patient-self transaction Identity authorized for this session, with
   * its counts-only audit in the same transaction.
   */
  async self(request: HidRequest) {
    const { actor, authorization } = await this.authorizeOwnSession(request);
    return this.database.withPatientTransaction(authorization, request.correlationId, async (client) => {
      const value = await this.release.read(client, authorization.patientId);
      await this.audit.recordWithClient(client, {
        correlationId: request.correlationId, actorType: 'patient', actorSubject: actor.subject,
        actorAccountId: actor.accountId, patientId: authorization.patientId,
        action: 'ehr.patient.self.records.read', resourceType: 'patient-record-summary', outcome: 'success',
        purposeOfUse: 'patient-self', details: this.release.auditDetails(value),
      });
      return value;
    });
  }

  /**
   * A 60 s attachment URL for one of the patient's released documents (D7:
   * documents only with a patient download route). Every document the
   * patient may not download (documents not released, unknown, another
   * patient's, not attached to a completed encounter, not uploaded, not
   * scanned clean, restricted or internal, or in another bucket) answers the
   * same 404, so the route tells nothing about what exists. The audit row
   * commits before the stored object is checked and a URL is signed; a
   * failure after it is audited by the interceptor.
   */
  async downloadOwnDocument(request: HidRequest, documentId: string) {
    const actor = request.actor;
    if (actor?.kind !== 'patient' || !actor.patientId || !actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
    }
    if (!this.release.releases('documents')) throw DOCUMENT_NOT_AVAILABLE();
    const { authorization } = await this.authorizeOwnSession(request);
    const document = await this.database.withPatientTransaction(authorization, request.correlationId, async (client) => {
      // The documents policies admit a row only once the release set is bound.
      await this.release.bind(client);
      const result = await client.query<PatientDocumentRow>(
        `select d.id,d.storage_bucket as "storageBucket",d.storage_key as "storageKey",
           d.object_version_id as "objectVersionId",d.sha256_hex as "sha256Hex",d.size_bytes as "sizeBytes",
           coalesce(d.detected_media_type,d.declared_media_type) as "mediaType",d.original_file_name as "fileName"
         from ehr.documents_effective d
         join ehr.encounters e on e.id=d.encounter_id and e.patient_id=d.patient_id and e.facility_id=d.facility_id
         where d.id=$1 and d.patient_id=$2 and d.status='available' and d.scan_status='clean'
           and d.classification='phi' and e.status='completed'`,
        [documentId, authorization.patientId],
      );
      const row = result.rows[0];
      if (!row?.objectVersionId) throw DOCUMENT_NOT_AVAILABLE();
      if (row.storageBucket !== this.storageBucket()) throw DOCUMENT_NOT_AVAILABLE();
      await this.audit.recordWithClient(client, {
        correlationId: request.correlationId, actorType: 'patient', actorSubject: actor.subject,
        actorAccountId: actor.accountId, patientId: authorization.patientId,
        action: 'ehr.patient.self.document.download', resourceType: 'document', resourceId: row.id,
        outcome: 'success', purposeOfUse: 'patient-self',
        details: { mediaType: row.mediaType, sizeBytes: Number(row.sizeBytes) },
      });
      return row;
    });
    let stored;
    try {
      stored = await this.storage.inspectVersion(document.storageKey, document.objectVersionId);
    } catch (error) {
      if (error instanceof StoredObjectIntegrityError) {
        throw new DomainProblem(503, 'DOCUMENT_INTEGRITY_UNAVAILABLE', 'The document cannot be verified');
      }
      throw new DomainProblem(503, 'DOCUMENT_STORAGE_UNAVAILABLE', 'Document storage is unavailable');
    }
    if (stored.versionId !== document.objectVersionId || stored.sha256Hex !== document.sha256Hex
      || stored.sizeBytes !== Number(document.sizeBytes)) {
      throw new DomainProblem(503, 'DOCUMENT_INTEGRITY_UNAVAILABLE', 'The document cannot be verified');
    }
    try {
      return await this.storage.createDownload(document.storageKey, document.objectVersionId,
        { fileName: document.fileName, mediaType: document.mediaType });
    } catch {
      throw new DomainProblem(503, 'DOCUMENT_STORAGE_UNAVAILABLE', 'Document storage is unavailable');
    }
  }

  /**
   * The patient-self authorization of this request's own session: Identity
   * confirms it (cookie or bearer, ehr-api workload) and it must still name
   * the same patient, account, subject and session.
   */
  private async authorizeOwnSession(request: HidRequest) {
    const actor = request.actor;
    if (actor?.kind !== 'patient' || !actor.patientId || !actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
    }
    const authorization = await this.identity.authorizeSelf(request);
    if (authorization.patientId !== actor.patientId || authorization.accountId !== actor.accountId
      || authorization.subject !== actor.subject || authorization.sessionId !== actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
    }
    return { actor, authorization };
  }

  /** The configured bucket; storage that is not configured is unavailable, not a missing document. */
  private storageBucket(): string {
    try {
      return this.storage.bucket();
    } catch {
      throw new DomainProblem(503, 'DOCUMENT_STORAGE_UNAVAILABLE', 'Document storage is unavailable');
    }
  }

  emergency(patientId: string, context: DataAccessContext) {
    // A category the reader lacks the read permission for is not read: its own routes would refuse the
    // reader, and break-glass is not an authorization bypass. Unknown permissions withhold every one.
    const permissions: readonly string[] = context.actor?.permissions ?? [];
    const withheld = EMERGENCY_CATEGORIES.filter((category) =>
      !permissions.includes(EMERGENCY_CATEGORY_PERMISSIONS[category]));
    return this.clinical.run(context, patientId, 'read_records', {
      action: 'ehr.emergency.records.read', resourceType: 'patient-record-summary', breakGlassOnly: true,
    }, async (client) => {
      const value = await this.readEmergency(client, patientId, context.facilityId, withheld);
      // Counts only: what this read disclosed, recorded with the success audit in the same transaction.
      // A withheld category has no count, since it was never read; it is named instead.
      const details: Record<string, unknown> = {
        encounterCount: value.encounters.length,
        noteCount: value.notes.length,
      };
      for (const category of EMERGENCY_CATEGORIES) {
        if (withheld.includes(category)) continue;
        details[EMERGENCY_COUNT_KEYS[category]] = value[category].length;
      }
      details.withheldCategories = value.withheld;
      return { value, details };
    });
  }

  /**
   * The break-glass summary of one facility: every category the reader holds the read permission for.
   * Which categories it may contain at all is unchanged (all seven) pending a decision.
   */
  private async readEmergency(client: PoolClient, patientId: string, facilityId: string,
    withheld: readonly EmergencyCategory[]) {
    const values = [patientId, facilityId];
    const read = async (name: EmergencyCategory, sql: string): Promise<SectionRows | undefined> =>
      withheld.includes(name) ? undefined : this.section(client, name, sql, values);
    const encounters = await this.section(client, 'encounters', encountersSql(' and facility_id=$2'), values);
    const notes = await this.section(client, 'notes',
      notesSql(' and n.facility_id=$2', "e.status<>'entered_in_error'"), values);

    // Vitals as first recorded; corrections are not applied, pending the decision on correction semantics.
    // A vital entered in error is not a measurement of this patient and is left out (ENC-RETRACT-2, 0090).
    const vitals = await read('vitals', `select id,encounter_id as "encounterId",facility_id as "facilityId",
      recorded_at as "recordedAt",height_cm as "heightCm",weight_kg as "weightKg",
      temperature_c as "temperatureC",pulse_bpm as "pulseBpm",respiratory_rate as "respiratoryRate",
      systolic_mmhg as "systolicMmhg",diastolic_mmhg as "diastolicMmhg",
      oxygen_saturation_percent as "oxygenSaturationPercent",source
      from ehr.vitals where patient_id=$1 and facility_id=$2 and status='final'
      order by recorded_at desc,id desc`);

    const diagnoses = await read('diagnoses', `select id,encounter_id as "encounterId",
      facility_id as "facilityId",code_system as "codeSystem",code,display,clinical_status as "clinicalStatus",
      verification_status as "verificationStatus",onset_at as "onsetAt",abatement_at as "abatementAt",notes
      from ehr.diagnoses where patient_id=$1 and facility_id=$2
      order by created_at desc,id desc`);

    const prescriptions = await read('prescriptions', `select id,encounter_id as "encounterId",
      facility_id as "facilityId",medication_code_system as "medicationCodeSystem",medication_code as "medicationCode",
      medication_display as "medicationDisplay",dose_quantity as "doseQuantity",dose_unit as "doseUnit",
      route_code as "routeCode",frequency,instructions,starts_on as "startsOn",ends_on as "endsOn",status
      from ehr.prescriptions where patient_id=$1 and facility_id=$2
      order by created_at desc,id desc`);

    const labRequests = await read('labRequests', `select id,encounter_id as "encounterId",
      facility_id as "facilityId",test_code_system as "testCodeSystem",test_code as "testCode",
      test_display as "testDisplay",priority,status,specimen_type_code as "specimenTypeCode",
      clinical_information as "clinicalInformation",external_order_reference as "externalOrderReference",
      created_at as "createdAt"
      from ehr.lab_requests where patient_id=$1 and facility_id=$2
      order by created_at desc,id desc`);

    // The effective status the staff list and download use: available only when the latest scan of the
    // exact stored object is clean (ehr.documents_effective, migration 0009).
    const documents = await read('documents', `select id,encounter_id as "encounterId",
      facility_id as "facilityId",original_file_name as "fileName",
      coalesce(detected_media_type,declared_media_type) as "mediaType",size_bytes as "sizeBytes",
      classification,status,scan_status as "scanStatus",created_at as "createdAt"
      from ehr.documents_effective where patient_id=$1 and facility_id=$2 and status='available'
      order by created_at desc,id desc`);

    const sections: Readonly<Record<Section, SectionRows | undefined>> = {
      encounters, notes, vitals, diagnoses, prescriptions, labRequests, documents,
    };
    const released = (Object.keys(SECTION_LIMITS) as Section[]).filter((name) => sections[name]);
    return {
      encounters: encounters.rows,
      notes: notes.rows,
      vitals: vitals?.rows ?? [],
      diagnoses: diagnoses?.rows ?? [],
      prescriptions: prescriptions?.rows ?? [],
      labRequests: labRequests?.rows ?? [],
      documents: documents?.rows ?? [],
      released,
      withheld: [...withheld],
      limits: Object.fromEntries(released.map((name) => [name, SECTION_LIMITS[name]])),
      truncated: Object.fromEntries(released.map((name) => [name, sections[name]?.truncated ?? false])),
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

/**
 * Current signed or amended notes, with the status their encounter must have (PREC-NOTES): the patient
 * receives notes of completed encounters only (D7, as row-level security requires since 0084); the
 * emergency summary leaves out notes of an encounter entered in error, a wrong-patient retraction.
 */
function notesSql(facilityClause: string, encounterCondition: string): string {
  return `select n.id,n.encounter_id as "encounterId",n.facility_id as "facilityId",
    n.note_type as "noteType",n.title,n.status,n.current_revision_no as "revisionNo",r.content,n.signed_at as "signedAt"
    from ehr.clinical_notes n join ehr.clinical_note_revisions r
      on r.clinical_note_id=n.id and r.revision_no=n.current_revision_no
      and r.patient_id=n.patient_id and r.facility_id=n.facility_id
    join ehr.encounters e on e.id=n.encounter_id and e.patient_id=n.patient_id and e.facility_id=n.facility_id
    where n.patient_id=$1 and n.status in ('signed','amended') and ${encounterCondition}${facilityClause}
    order by n.signed_at desc,n.id desc`;
}
