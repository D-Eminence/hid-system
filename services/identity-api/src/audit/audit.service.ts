import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { ListAuditEventsDto } from './dto/list-audit-events.dto';

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
  reason?: string;
  sourceIp?: string;
  userAgent?: string;
  details?: Readonly<Record<string, unknown>>;
  provenance?: 'application' | 'legacy_identity' | 'migration' | 'system';
  sourceSystem?: string;
}

export interface AuditEventRow extends QueryResultRow {
  sequenceId: string;
  eventId: string;
  occurredAt: Date;
  correlationId: string;
  actorType: 'staff' | 'patient' | 'system' | 'workload' | 'legacy';
  actorSubject: string | null;
  patientId: string | null;
  action: string;
  outcome: AuditOutcome;
  resourceType: string | null;
  resourceId: string | null;
  purposeOfUse: string | null;
  reason: string | null;
  sourceSystem: string | null;
  details: Readonly<Record<string, unknown>>;
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
           resource_type, resource_id, outcome, purpose_of_use, reason, source_ip,
           user_agent, details, provenance, source_system
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19)`,
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
         resource_type, resource_id, outcome, purpose_of_use, reason, source_ip,
         user_agent, details, provenance, source_system
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19)`,
      this.values(event),
    );
  }

  async listFacilityEvents(context: DataAccessContext, query: ListAuditEventsDto) {
    try {
      return await this.database.withTransaction(context, async (client) => {
        const result = await client.query<AuditEventRow>(
          `select
             sequence_id::text as "sequenceId",
             event_id as "eventId",
             occurred_at as "occurredAt",
             correlation_id as "correlationId",
             actor_type as "actorType",
             actor_subject as "actorSubject",
             patient_id as "patientId",
             action,
             outcome,
             resource_type as "resourceType",
             resource_id as "resourceId",
             purpose_of_use as "purposeOfUse",
             reason,
             source_system as "sourceSystem",
             details
           from audit.list_facility_events($1, $2::bigint)`,
          [query.limit, query.beforeSequenceId ?? null],
        );
        await this.recordWithClient(client, {
          correlationId: context.correlationId,
          actorType: 'staff',
          actorSubject: context.actor.subject,
          actorAccountId: context.actor.accountId,
          actorMembershipId: context.membershipId,
          organizationId: context.actor.facility?.organizationId,
          facilityId: context.facilityId,
          action: 'audit.events.list',
          resourceType: 'audit-event-collection',
          outcome: 'success',
          purposeOfUse: context.purposeOfUse,
          details: { returnedCount: result.rows.length, beforeSequenceId: query.beforeSequenceId ?? null },
        });
        const tail = result.rows.at(-1);
        return {
          items: result.rows,
          nextBeforeSequenceId: result.rows.length === query.limit && tail ? tail.sequenceId : null,
        };
      }, { readOnly: false });
    } catch (error) {
      if (isDatabaseError(error) && error.code === '42501') {
        throw new DomainProblem(403, 'AUDIT_ACCESS_DENIED', 'Audit access is not authorized');
      }
      throw error;
    }
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
      event.reason?.trim() ?? null,
      event.sourceIp ?? null,
      event.userAgent?.slice(0, 512) ?? null,
      JSON.stringify(event.details ?? {}),
      event.provenance ?? 'application',
      event.sourceSystem ?? 'ehr-api',
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

function isDatabaseError(value: unknown): value is { code: string } {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && typeof (value as { code?: unknown }).code === 'string';
}
