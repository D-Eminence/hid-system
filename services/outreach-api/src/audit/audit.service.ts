import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DataAccessContext } from '../common/request-context';

@Injectable()
export class AuditService {
  async recordWithClient(client: PoolClient, context: DataAccessContext, action: string,
    registrationCaseId: string, patientId?: string): Promise<void> {
    await client.query(`insert into audit.events (
      correlation_id,actor_type,actor_subject,actor_account_id,actor_membership_id,
      organization_id,facility_id,patient_id,action,resource_type,resource_id,outcome,
      purpose_of_use,details,provenance,source_system
    ) values ($1,'staff',$2,$3,$4,$5,$6,$7,$8,'outreach-registration-case',$9,
      'success','direct-care','{}'::jsonb,'application','outreach-api')`,
    [context.correlationId, context.actor.subject, context.actor.accountId, context.membershipId,
      context.actor.facility?.organizationId ?? null, context.facilityId, patientId ?? null,
      action, registrationCaseId]);
  }
}
