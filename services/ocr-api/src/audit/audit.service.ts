import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';

export type AuditOutcome = 'success' | 'denied' | 'failure';

export interface AuditEventInput {
  correlationId: string;
  actorType?: 'staff' | 'patient' | 'system' | 'workload' | 'legacy';
  actorSubject?: string;
  actorAccountId?: string;
  actorMembershipId?: string;
  organizationId?: string;
  facilityId?: string;
  patientId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  outcome: AuditOutcome;
  purposeOfUse?: string;
  sourceIp?: string;
  userAgent?: string;
  details?: Readonly<Record<string, unknown>>;
  provenance?: 'application' | 'legacy_identity' | 'migration' | 'system';
  sourceSystem?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  async record(event: AuditEventInput): Promise<void> {
    this.assertActorFacility(event);
    try {
      await this.database.query(
        `insert into audit.events (
           correlation_id, actor_type, actor_subject, actor_account_id,
           actor_membership_id, organization_id, facility_id, patient_id, action,
           resource_type, resource_id, outcome, purpose_of_use, source_ip,
           user_agent, details, provenance, source_system
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18)`,
        this.values(event),
      );
    } catch {
      throw new ServiceUnavailableException('Audit persistence is unavailable; request was denied');
    }
  }

  async recordWithClient(client: PoolClient, event: AuditEventInput): Promise<void> {
    this.assertActorFacility(event);
    await client.query(
      `insert into audit.events (
         correlation_id, actor_type, actor_subject, actor_account_id,
         actor_membership_id, organization_id, facility_id, patient_id, action,
         resource_type, resource_id, outcome, purpose_of_use, source_ip,
         user_agent, details, provenance, source_system
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18)`,
      this.values(event),
    );
  }

  private values(event: AuditEventInput): unknown[] {
    return [
      event.correlationId,
      event.actorType ?? (event.actorSubject && event.facilityId ? 'staff' : 'system'),
      event.actorSubject ?? null,
      event.actorAccountId ?? null,
      event.actorMembershipId ?? null,
      event.organizationId ?? null,
      event.facilityId ?? null,
      event.patientId ?? null,
      event.action,
      event.resourceType ?? null,
      event.resourceId ?? null,
      event.outcome,
      event.purposeOfUse ?? null,
      event.sourceIp ?? null,
      event.userAgent?.slice(0, 512) ?? null,
      JSON.stringify(event.details ?? {}),
      event.provenance ?? 'application',
      event.sourceSystem ?? 'ocr-api',
    ];
  }

  private assertActorFacility(event: AuditEventInput): void {
    const actorType = event.actorType ?? (event.actorSubject ? 'staff' : 'system');
    const facilityOptionalAuthEvent = actorType === 'staff'
      && event.action.startsWith('auth.')
      && (event.resourceType === 'authentication' || event.resourceType === 'session');
    if (actorType === 'staff' && !event.facilityId && !facilityOptionalAuthEvent) {
      throw new ServiceUnavailableException('Staff audit events require a resolved facility context');
    }
    if (actorType === 'system' && event.actorSubject) {
      throw new ServiceUnavailableException('A staff subject cannot be recorded as a system actor');
    }
  }
}
