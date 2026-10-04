import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { ClinicalRepository } from '../shared/clinical.repository';

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
      const value = await this.read(client, authorization.patientId);
      await this.audit.recordWithClient(client, {
        correlationId: request.correlationId, actorType: 'patient', actorSubject: actor.subject,
        actorAccountId: actor.accountId, patientId: authorization.patientId,
        action: 'ehr.patient.self.records.read', resourceType: 'patient-record-summary', outcome: 'success',
        purposeOfUse: 'patient-self', details: { encounterCount: value.encounters.length, noteCount: value.notes.length },
      });
      return value;
    });
  }

  emergency(patientId: string, context: DataAccessContext) {
    return this.clinical.run(context, patientId, 'read_records', {
      action: 'ehr.emergency.records.read', resourceType: 'patient-record-summary', breakGlassOnly: true,
    }, async (client) => ({ value: await this.read(client, patientId, context.facilityId) }));
  }

  emergencyEncounter(patientId: string, encounterId: string, context: DataAccessContext) {
    return this.clinical.run(context, patientId, 'read_records', {
      action: 'ehr.emergency.encounter.read', resourceType: 'emergency-encounter-chart',
      resourceId: encounterId, breakGlassOnly: true,
    }, async (client) => {
      const [encounter, notes, vitals, diagnoses, prescriptions, labRequests] = await Promise.all([
        client.query(`select id, encounter_type as "encounterType", started_at as "startedAt",
          ended_at as "endedAt", chief_complaint as "chiefComplaint"
          from ehr.encounters where id=$1 and patient_id=$2 and facility_id=$3 and status='completed'`,
        [encounterId, patientId, context.facilityId]),
        client.query(`select n.id,n.note_type as "noteType",n.title,r.content,n.signed_at as "signedAt"
          from ehr.clinical_notes n join ehr.clinical_note_revisions r
            on r.clinical_note_id=n.id and r.revision_no=n.current_revision_no
            and r.patient_id=n.patient_id and r.facility_id=n.facility_id
          where n.encounter_id=$1 and n.patient_id=$2 and n.facility_id=$3
            and n.status in ('signed','amended')
          order by n.signed_at desc,n.id desc limit 25`, [encounterId, patientId, context.facilityId]),
        client.query(`select v.id,v.recorded_at as "recordedAt",
          coalesce(c.replacement_values->>'height_cm',v.height_cm::text) as "heightCm",
          coalesce(c.replacement_values->>'weight_kg',v.weight_kg::text) as "weightKg",
          coalesce(c.replacement_values->>'temperature_c',v.temperature_c::text) as "temperatureC",
          coalesce(c.replacement_values->>'pulse_bpm',v.pulse_bpm::text) as "pulseBpm",
          coalesce(c.replacement_values->>'respiratory_rate',v.respiratory_rate::text) as "respiratoryRate",
          coalesce(c.replacement_values->>'systolic_mmhg',v.systolic_mmhg::text) as "systolicMmhg",
          coalesce(c.replacement_values->>'diastolic_mmhg',v.diastolic_mmhg::text) as "diastolicMmhg",
          coalesce(c.replacement_values->>'oxygen_saturation_percent',v.oxygen_saturation_percent::text) as "oxygenSaturationPercent"
          from ehr.vitals v left join lateral (
            select replacement_values from ehr.vital_corrections
            where vital_id=v.id and patient_id=v.patient_id and facility_id=v.facility_id
            order by correction_no desc limit 1
          ) c on true
          where v.encounter_id=$1 and v.patient_id=$2 and v.facility_id=$3
          order by v.recorded_at desc,v.id desc limit 25`, [encounterId, patientId, context.facilityId]),
        client.query(`select id,code_system as "codeSystem",code,display,
          clinical_status as "clinicalStatus",verification_status as "verificationStatus",
          onset_at as "onsetAt"
          from ehr.diagnoses where encounter_id=$1 and patient_id=$2 and facility_id=$3
            and clinical_status in ('active','recurrence','relapse')
            and verification_status in ('confirmed','provisional')
          order by created_at desc,id desc limit 25`, [encounterId, patientId, context.facilityId]),
        client.query(`select id,medication_display as "medicationDisplay",
          dose_quantity as "doseQuantity",dose_unit as "doseUnit",route_code as "routeCode",
          frequency,instructions,starts_on as "startsOn",ends_on as "endsOn",status
          from ehr.prescriptions where encounter_id=$1 and patient_id=$2 and facility_id=$3
            and status in ('active','on_hold','completed')
          order by created_at desc,id desc limit 25`, [encounterId, patientId, context.facilityId]),
        client.query(`select id,test_code_system as "testCodeSystem",test_code as "testCode",
          test_display as "testDisplay",priority,status
          from ehr.lab_requests where encounter_id=$1 and patient_id=$2 and facility_id=$3
            and status in ('active','completed')
          order by created_at desc,id desc limit 25`, [encounterId, patientId, context.facilityId]),
      ]);
      return {
        value: { encounter: encounter.rows[0], notes: notes.rows, vitals: vitals.rows,
          diagnoses: diagnoses.rows, prescriptions: prescriptions.rows, labRequests: labRequests.rows,
          limitPerSection: 25 },
        details: { noteCount: notes.rows.length, vitalCount: vitals.rows.length,
          diagnosisCount: diagnoses.rows.length, prescriptionCount: prescriptions.rows.length,
          labRequestCount: labRequests.rows.length },
      };
    }, async (client) => {
      const match = await client.query(
        `select 1 from ehr.encounters
         where id=$1 and patient_id=$2 and facility_id=$3 and status='completed' limit 1`,
        [encounterId, patientId, context.facilityId],
      );
      return (match.rowCount ?? 0) > 0;
    });
  }

  private async read(client: PoolClient, patientId: string, facilityId?: string) {
    const values = facilityId ? [patientId, facilityId] : [patientId];
    const facility = facilityId ? ' and facility_id=$2' : '';
    const encounters = await client.query(`select id,facility_id as "facilityId",encounter_type as "encounterType",
      status,started_at as "startedAt",ended_at as "endedAt" from ehr.encounters
      where patient_id=$1 and status='completed'${facility} order by started_at desc,id desc limit 50`,values);
    const notes = await client.query(`select n.id,n.encounter_id as "encounterId",n.facility_id as "facilityId",
      n.note_type as "noteType",n.title,n.status,n.current_revision_no as "revisionNo",r.content,n.signed_at as "signedAt"
      from ehr.clinical_notes n join ehr.clinical_note_revisions r
        on r.clinical_note_id=n.id and r.revision_no=n.current_revision_no
        and r.patient_id=n.patient_id and r.facility_id=n.facility_id
      where n.patient_id=$1 and n.status in ('signed','amended')${facilityId ? ' and n.facility_id=$2' : ''}
      order by n.signed_at desc,n.id desc limit 50`,values);
    return { encounters: encounters.rows, notes: notes.rows, limit: 50 };
  }
}
