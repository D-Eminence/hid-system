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
