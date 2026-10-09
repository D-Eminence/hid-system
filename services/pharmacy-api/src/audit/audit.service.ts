import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DataAccessContext } from '../common/request-context';

export interface PharmacyAuditResource {
  patientId?: string;
  resourceType: string;
  resourceId: string;
}

@Injectable()
export class AuditService {
  async recordWithClient(client: PoolClient, context: DataAccessContext, action: string,
    resource: PharmacyAuditResource, details: Readonly<Record<string, unknown>> = {}): Promise<void> {
    await client.query(`insert into audit.events (
      correlation_id,actor_type,actor_subject,actor_account_id,actor_membership_id,
      organization_id,facility_id,patient_id,action,resource_type,resource_id,outcome,
      purpose_of_use,details,provenance,source_system
    ) values ($1,'staff',$2,$3,$4,$5,$6,$7,$8,$9,$10,'success',$11,$12::jsonb,'application','pharmacy-api')`,
    [context.correlationId, context.actor.subject, context.actor.accountId, context.membershipId,
      context.actor.facility?.organizationId ?? null, context.facilityId, resource.patientId ?? null, action,
      resource.resourceType, resource.resourceId, context.purposeOfUse, JSON.stringify(details)]);
  }
}
