import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { CollectSpecimenDto, CreateAccessionDto, ReceiveSpecimenDto, RejectSpecimenDto } from './dto/accession.dto';
import type { LabAccessionResult, LabSpecimenResult, SpecimenStatus } from './lab-accessions.types';

interface AccessionRow extends QueryResultRow { id:string; accession_number:string; work_item_id:string; patient_id:string;
  facility_id:string; status:'accessioned'; priority:LabAccessionResult['priority']; row_version:string; created_at:Date; request_sha256:string }
interface SpecimenRow extends QueryResultRow { id:string; specimen_identifier:string; requirement_id:string; accession_id:string;
  patient_id:string; facility_id:string; specimen_type:string; container_type:string|null; status:SpecimenStatus;
  collected_at:Date|null; received_at:Date|null; rejected_at:Date|null; rejection_reason:string|null; row_version:string }

const ACCESSION_COLUMNS = `id::text,accession_number,work_item_id::text,patient_id::text,facility_id::text,
  status,priority,row_version::text,created_at,request_sha256`;
const SPECIMEN_COLUMNS = `id::text,specimen_identifier,requirement_id::text,accession_id::text,patient_id::text,
  facility_id::text,specimen_type,container_type,status,collected_at,received_at,rejected_at,rejection_reason,row_version::text`;

@Injectable()
export class LabAccessionsService {
  constructor(private readonly database:DatabaseService, private readonly identity:IdentityService,
    private readonly audit:AuditService) {}

  async create(context:DataAccessContext, workItemId:string, input:CreateAccessionDto, key:string):Promise<LabAccessionResult> {
    this.permission(context,'lab.accession.create');
    const normalized = { requirements: input.requirements.map((r) => ({ specimenType:r.specimenType.trim(),
      containerType:r.containerType?.trim() || null,notes:r.notes?.trim() || null })),reason:input.reason.trim() };
    const digest = requestDigest('lab.accession.create',{ workItemId,...normalized });
    return this.database.withTransaction(context,async (client) => {
      const workResult=await client.query<{id:string;patient_id:string;facility_id:string;priority:LabAccessionResult['priority'];status:string}>(
        `select id::text,patient_id::text,facility_id::text,priority,status from lab.work_items where id=$1`,[workItemId]);
      const work=workResult.rows[0];
      if(!work) throw new DomainProblem(404,'LAB_WORK_ITEM_NOT_FOUND','Lab work item was not found');
      if(work.facility_id!==context.facilityId||work.status!=='accepted') throw new DomainProblem(409,'LAB_WORK_ITEM_NOT_ACCESSIONABLE','Lab work item is not accessionable at this facility');
      await this.authorize(work.patient_id,context,'write_records');
      const replay = await client.query<AccessionRow>(`select ${ACCESSION_COLUMNS} from lab.accessions
        where work_item_id=$1 or (facility_id=$2 and created_by=$3 and idempotency_key=$4) for update`,
      [workItemId,context.facilityId,context.actor.accountId,key]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_sha256!==digest) throw new DomainProblem(409,'IDEMPOTENCY_CONFLICT','Accession request conflicts with existing work');
        return this.aggregate(client,replay.rows[0]);
      }
      const inserted = await client.query<AccessionRow>(`insert into lab.accessions(work_item_id,patient_id,facility_id,
        priority,created_by,created_by_membership_id,idempotency_key,request_sha256,correlation_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${ACCESSION_COLUMNS}`,
      [workItemId,work.patient_id,work.facility_id,work.priority,context.actor.accountId,context.membershipId,key,digest,context.correlationId]);
      const accession = inserted.rows[0];
      if (!accession) throw new DomainProblem(503,'LAB_ACCESSION_NOT_CREATED','Lab accession could not be created');
      for (const [index,requirement] of normalized.requirements.entries()) {
        const requirementId=randomUUID(); const specimenId=randomUUID();
        await client.query(`insert into lab.specimen_requirements(id,accession_id,patient_id,facility_id,ordinal,specimen_type,container_type,notes)
          values($1,$2,$3,$4,$5,$6,$7,$8)`,[requirementId,accession.id,work.patient_id,work.facility_id,index+1,
          requirement.specimenType,requirement.containerType,requirement.notes]);
        const specimen = await client.query<SpecimenRow>(`insert into lab.specimens(id,requirement_id,accession_id,patient_id,facility_id,
          specimen_type,container_type) values($1,$2,$3,$4,$5,$6,$7) returning ${SPECIMEN_COLUMNS}`,
        [specimenId,requirementId,accession.id,work.patient_id,work.facility_id,requirement.specimenType,requirement.containerType]);
        const specimenRow=specimen.rows[0];
        if(!specimenRow) throw new DomainProblem(503,'LAB_SPECIMEN_NOT_CREATED','Required specimen could not be created');
        await this.specimenEvent(client,specimenRow,1,'specimen_required',normalized.reason,context);
      }
      await client.query(`insert into lab.accession_events(accession_id,work_item_id,patient_id,facility_id,event_version,event_type,
        actor_id,actor_membership_id,reason,correlation_id) values($1,$2,$3,$4,1,'accession_created',$5,$6,$7,$8)`,
      [accession.id,workItemId,work.patient_id,work.facility_id,context.actor.accountId,context.membershipId,normalized.reason,context.correlationId]);
      await this.outbox(client,'LabAccessionCreated',accession.id,1,work.patient_id,work.facility_id,context,
        { accessionId:accession.id,workItemId });
      await this.audit.recordWithClient(client,this.auditEvent(context,accession,'lab.accession.create',{ workItemId }));
      return this.aggregate(client,accession);
    },{ isolationLevel:'SERIALIZABLE' });
  }

  async get(context:DataAccessContext, accessionId:string):Promise<LabAccessionResult> {
    this.permission(context,'lab.accession.read');
    return this.database.withTransaction(context,async (client) => {
      const result=await client.query<AccessionRow>(`select ${ACCESSION_COLUMNS} from lab.accessions where id=$1`,[accessionId]);
      const row=result.rows[0]; if(!row) throw new DomainProblem(404,'LAB_ACCESSION_NOT_FOUND','Lab accession was not found');
      await this.authorize(row.patient_id,context,'read_records');
      await this.audit.recordWithClient(client,this.auditEvent(context,row,'lab.accession.read'));
      return this.aggregate(client,row);
    },{ readOnly:false });
  }

  async listSpecimens(context:DataAccessContext, accessionId:string):Promise<{items:LabSpecimenResult[]}> {
    const accession=await this.get(context,accessionId); return { items:accession.specimens };
  }

  collect(context:DataAccessContext,accessionId:string,specimenId:string,input:CollectSpecimenDto,key:string) {
    return this.transition(context,accessionId,specimenId,'collect','lab.specimen.collect','collected',input.expectedVersion,key,
      { collectedAt:input.collectedAt,notes:input.notes?.trim()||null },input.notes?.trim()||'Specimen collected');
  }
  receive(context:DataAccessContext,accessionId:string,specimenId:string,input:ReceiveSpecimenDto,key:string) {
    return this.transition(context,accessionId,specimenId,'receive','lab.specimen.receive','received',input.expectedVersion,key,
      { receivedAt:input.receivedAt,condition:input.condition?.trim()||null },input.condition?.trim()||'Specimen received');
  }
  reject(context:DataAccessContext,accessionId:string,specimenId:string,input:RejectSpecimenDto,key:string) {
    return this.transition(context,accessionId,specimenId,'reject','lab.specimen.reject','rejected',input.expectedVersion,key,
      { reason:input.reason.trim() },input.reason.trim());
  }

  private async transition(context:DataAccessContext,accessionId:string,specimenId:string,operation:'collect'|'receive'|'reject',
    permission:string,target:'collected'|'received'|'rejected',expectedVersion:number,key:string,payload:Record<string,unknown>,reason:string) {
    this.permission(context,permission); const digest=requestDigest(`lab.specimen.${operation}`,{accessionId,specimenId,expectedVersion,...payload});
    return this.database.withTransaction(context,async (client) => {
      const currentResult=await client.query<SpecimenRow>(`select ${SPECIMEN_COLUMNS} from lab.specimens
        where id=$1 and accession_id=$2 for update`,[specimenId,accessionId]);
      const current=currentResult.rows[0]; if(!current) throw new DomainProblem(404,'LAB_SPECIMEN_NOT_FOUND','Lab specimen was not found');
      await this.authorize(current.patient_id,context,'write_records');
      const replay=await client.query<{request_sha256:string}>(`select request_sha256 from lab.specimen_command_idempotency
        where facility_id=$1 and actor_id=$2 and idempotency_key=$3`,[context.facilityId,context.actor.accountId,key]);
      if(replay.rows[0]) {
        if(replay.rows[0].request_sha256!==digest) throw new DomainProblem(409,'IDEMPOTENCY_CONFLICT','Specimen command conflicts with an earlier request');
        return this.projectSpecimen(current);
      }
      const set = operation==='collect'
        ? `status='collected',collected_at=$5,collected_by=$6,collected_by_membership_id=$7,collection_notes=$8`
        : operation==='receive'
          ? `status='received',received_at=$5,received_by=$6,received_by_membership_id=$7,receipt_condition=$8`
          : `status='rejected',rejected_at=clock_timestamp(),rejected_by=$6,rejected_by_membership_id=$7,rejection_reason=$8`;
      const values=operation==='collect'?[specimenId,accessionId,context.facilityId,expectedVersion,payload.collectedAt,context.actor.accountId,context.membershipId,payload.notes]
        : operation==='receive'?[specimenId,accessionId,context.facilityId,expectedVersion,payload.receivedAt,context.actor.accountId,context.membershipId,payload.condition]
          : [specimenId,accessionId,context.facilityId,expectedVersion,null,context.actor.accountId,context.membershipId,payload.reason];
      const result=await client.query<SpecimenRow>(`update lab.specimens set ${set},row_version=row_version+1
        where id=$1 and accession_id=$2 and facility_id=$3 and row_version=$4 returning ${SPECIMEN_COLUMNS}`,values);
      const row=result.rows[0]; if(!row) throw new DomainProblem(412,'VERSION_CONFLICT','Specimen changed since it was loaded');
      await client.query(`insert into lab.specimen_command_idempotency(facility_id,patient_id,actor_id,idempotency_key,operation,
        specimen_id,request_sha256,result_version) values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.facility_id,row.patient_id,context.actor.accountId,key,operation,row.id,digest,row.row_version]);
      await this.specimenEvent(client,row,Number(row.row_version),`specimen_${target}` as never,reason,context);
      const eventType=target==='collected'?'LabSpecimenCollected':target==='received'?'LabSpecimenReceived':'LabSpecimenRejected';
      await this.outbox(client,eventType,row.id,Number(row.row_version),row.patient_id,row.facility_id,context,
        { specimenId:row.id,accessionId,rowVersion:Number(row.row_version),status:target });
      await this.audit.recordWithClient(client,this.auditEvent(context,row,`lab.specimen.${operation}`,{ accessionId,reason }));
      return this.projectSpecimen(row);
    },{ isolationLevel:'SERIALIZABLE' });
  }

  private async aggregate(client:PoolClient,row:AccessionRow):Promise<LabAccessionResult> {
    const specimens=await client.query<SpecimenRow>(`select ${SPECIMEN_COLUMNS} from lab.specimens where accession_id=$1 order by created_at,id`,[row.id]);
    return { id:row.id,accessionNumber:row.accession_number,workItemId:row.work_item_id,patientId:row.patient_id,
      facilityId:row.facility_id,status:row.status,priority:row.priority,version:Number(row.row_version),createdAt:row.created_at,
      specimens:specimens.rows.map((item)=>this.projectSpecimen(item)) };
  }
  private projectSpecimen(row:SpecimenRow):LabSpecimenResult { return { id:row.id,specimenIdentifier:row.specimen_identifier,
    requirementId:row.requirement_id,accessionId:row.accession_id,patientId:row.patient_id,facilityId:row.facility_id,
    specimenType:row.specimen_type,containerType:row.container_type,status:row.status,collectedAt:row.collected_at,
    receivedAt:row.received_at,rejectedAt:row.rejected_at,rejectionReason:row.rejection_reason,version:Number(row.row_version) }; }
  private specimenEvent(client:PoolClient,row:SpecimenRow,version:number,eventType:'specimen_required'|'specimen_collected'|'specimen_received'|'specimen_rejected',reason:string,context:DataAccessContext) {
    return client.query(`insert into lab.specimen_events(specimen_id,accession_id,patient_id,facility_id,event_version,event_type,
      actor_id,actor_membership_id,reason,correlation_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [row.id,row.accession_id,row.patient_id,row.facility_id,version,eventType,context.actor.accountId,context.membershipId,reason,context.correlationId]);
  }
  private outbox(client:PoolClient,eventType:string,aggregateId:string,version:number,patientId:string,facilityId:string,
    context:DataAccessContext,payload:Record<string,unknown>) { return client.query(`insert into lab.outbox_events(event_type,aggregate_id,
      aggregate_version,facility_id,patient_id,correlation_id,payload) values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [eventType,aggregateId,version,facilityId,patientId,context.correlationId,JSON.stringify(payload)]); }
  private permission(context:DataAccessContext,permission:string) { if(!context.actor.permissions.includes(permission))
    throw new DomainProblem(403,'LAB_OPERATION_ACCESS_DENIED','Required Lab operation permission is absent'); }
  private async authorize(patientId:string,context:DataAccessContext,action:'read_records'|'write_records') {
    const decision=await this.identity.authorize(patientId,action,context.purposeOfUse,context);
    if(!decision.allowed||(action==='write_records'&&decision.breakGlass)) throw new DomainProblem(403,'LAB_OPERATION_ACCESS_DENIED','Lab operation is not authorized');
  }
  private auditEvent(context:DataAccessContext,row:{id:string;patient_id:string;facility_id:string},action:string,details?:Record<string,unknown>) {
    return { correlationId:context.correlationId,actorType:'staff' as const,actorSubject:context.actor.subject,
      actorAccountId:context.actor.accountId,actorMembershipId:context.membershipId,organizationId:context.actor.facility?.organizationId,
      facilityId:row.facility_id,patientId:row.patient_id,action,resourceType:action.includes('specimen')?'lab-specimen':'lab-accession',
      resourceId:row.id,outcome:'success' as const,purposeOfUse:context.purposeOfUse,details,sourceSystem:'lab-api' };
  }
}
