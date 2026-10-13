import { Injectable } from '@nestjs/common';
import { IdentityApiClient,IdentityApiProblem } from '@hid/api-client';
import { AuditService } from '../audit/audit.service';
import { LabWorkloadIdentityService } from '../auth/lab-workload-identity.service';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';

export const PATIENT_LAB_QUERY = `select r.id, r.current_version::text||':'||rel.id::text version,t.name title,
 rel.released_at as "recordedAt",s.collected_at as "effectiveAt",
 jsonb_build_object('test',t.name,'codeSystem',t.code_system,'code',t.code,
 'specimen',s.specimen_type,'resultType',v.result_type,'numericValue',v.numeric_value::text,
 'textValue',v.text_value,'unit',v.unit,'referenceRange',v.reference_range,'recordedFlag',v.abnormal_flag,
 'revisionKind',v.revision_kind,'correctionReason',v.correction_reason,
 'collectedAt',s.collected_at,'releasedAt',rel.released_at,'verification','exact-version manually verified and released') fields
 from lab.results r join lab.result_revisions v on v.result_id=r.id and v.version=r.current_version
 and v.patient_id=r.patient_id and v.facility_id=r.facility_id
 join lab.result_releases rel on rel.result_id=r.id and rel.result_version=r.current_version
 and rel.patient_id=r.patient_id and rel.facility_id=r.facility_id
 join lab.result_verifications ver on ver.id=rel.verification_id and ver.result_id=r.id and ver.result_version=r.current_version
 and ver.patient_id=r.patient_id and ver.facility_id=r.facility_id
 join lab.test_executions e on e.id=r.execution_id and e.patient_id=r.patient_id and e.facility_id=r.facility_id
 join lab.work_item_requested_tests t on t.id=e.requested_test_id and t.patient_id=r.patient_id and t.facility_id=r.facility_id
 join lab.specimens s on s.id=e.specimen_id and s.patient_id=r.patient_id and s.facility_id=r.facility_id
 where r.patient_id=$1 and r.id::text>$2 and not exists(select 1 from lab.result_invalidations i
 where i.result_id=r.id and i.result_version=r.current_version and i.patient_id=r.patient_id)
 order by r.id::text limit 201`;

@Injectable()
export class PatientResultsService {
  private readonly identity:IdentityApiClient;
  constructor(private readonly database:DatabaseService,workload:LabWorkloadIdentityService,private readonly audit:AuditService) {
    this.identity=new IdentityApiClient({baseUrl:getEnvironment().IDENTITY_API_URL,caller:'lab-api',timeoutMs:5000,workloadHeaders:()=>workload.identityHeaders()});
  }
  async read(request:HidRequest,cursor='') {
    if (cursor && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(cursor)) throw new DomainProblem(400,'INVALID_CURSOR','Invalid record cursor');
    const actor=request.actor;
    if (actor?.kind!=='patient'||!actor.patientId||!actor.sessionId) throw new DomainProblem(403,'PATIENT_SESSION_REQUIRED','An active patient session is required');
    const auth=await this.identity.authorizePatientSelf({correlationId:request.correlationId,
      authorization:request.header('authorization'),cookie:request.header('cookie'),origin:request.header('origin')})
      .catch(error=>{if(error instanceof IdentityApiProblem)throw new DomainProblem(error.status,error.code??'PATIENT_ACCESS_DENIED',error.message);
        throw new DomainProblem(503,'IDENTITY_SERVICE_UNAVAILABLE','Patient authorization is unavailable');});
    if(auth.patientId!==actor.patientId||auth.accountId!==actor.accountId||auth.subject!==actor.subject||auth.sessionId!==actor.sessionId)
      throw new DomainProblem(403,'PATIENT_ACCESS_DENIED','Patient authorization changed');
    return this.database.withPatientTransaction(auth,request.correlationId,async client=>{
      const rows=(await client.query(PATIENT_LAB_QUERY,[auth.patientId,cursor])).rows;
      const records=rows.slice(0,200);
      await this.audit.recordWithClient(client,{correlationId:request.correlationId,actorType:'patient',actorSubject:auth.subject,
        actorAccountId:auth.accountId,patientId:auth.patientId,action:'lab.patient.released-results.read',resourceType:'released-result-collection',
        outcome:'success',purposeOfUse:'patient-self',details:{recordCount:records.length}});
      return {records,nextCursor:rows.length>200?records.at(-1)!.id:null};
    });
  }
}
