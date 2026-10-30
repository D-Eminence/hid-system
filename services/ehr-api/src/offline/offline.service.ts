import { hkdfSync } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment, parseOfflineEscrowKeys } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import {
  parseAuditEvent,
  type AuditEventsDto,
  type OfflineAuditEventInput,
  type OfflineAuditRejection,
} from './dto/audit-events.dto';
import type { EscrowKeyDto } from './dto/escrow-key.dto';
import type { ReceiptsLookupDto } from './dto/receipts-lookup.dto';

export interface OfflineReceipt {
  key: string;
  operation: string;
  state: 'processing' | 'completed' | 'failed';
  resourceType: string | null;
  resourceId: string | null;
  responseStatus: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AuditIngestResult {
  accepted: string[];
  duplicate: string[];
  rejected: { eventId: string; code: OfflineAuditRejection }[];
}

export interface EscrowConfiguration {
  enabled: boolean;
  keys: ReadonlyMap<number, Buffer> | undefined;
}

interface ReceiptRow extends QueryResultRow {
  key: string;
  operation: string;
  state: OfflineReceipt['state'];
  resourceType: string | null;
  resourceId: string | null;
  responseStatus: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export const OFFLINE_SOURCE_SYSTEM = 'health-id-offline';
export const ESCROW_SALT = 'hid-offline-escrow/v1';
export const ESCROW_LIMIT = 30;
const ESCROW_WINDOW_MS = 3600_000;
const ESCROW_TRACKED_ACCOUNTS = 10_000;
const AUDIT_PAST_MS = 26 * 3600_000;

/**
 * The derivation of §2.5: HKDF-SHA256 over the version's secret, bound to the
 * account, membership, facility and vault. Stateless; nothing is stored.
 */
export function deriveEscrowKey(secret: Buffer, accountId: string, membershipId: string, facilityId: string,
  vaultId: string): Buffer {
  const info = [accountId, membershipId, facilityId, vaultId].map((part) => part.toLowerCase()).join('|');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.from(ESCROW_SALT, 'utf8'), Buffer.from(info, 'utf8'), 32));
}

@Injectable()
export class OfflineService {
  // Per-task window, as the patient chat admission limit: replicas count
  // separately. Bounded so a flood of accounts cannot grow it without limit.
  private readonly escrowIssues = new Map<string, number[]>();

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  ping() {
    return { service: 'ehr-api', serverTime: new Date().toISOString() };
  }

  /**
   * C1. Reads only the caller's own keys: ehr.idempotency_keys RLS is
   * owner-only (account, membership, facility), and the query repeats that
   * scope. No consent check, and no patient or clinical content is returned.
   */
  async lookupReceipts(context: DataAccessContext, input: ReceiptsLookupDto) {
    requireStaffScope(context);
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<ReceiptRow>(
        `select idempotency_key as "key", operation, state,
                result_resource_type as "resourceType", result_resource_id as "resourceId",
                response_status as "responseStatus", created_at as "createdAt", updated_at as "updatedAt"
           from ehr.idempotency_keys
          where idempotency_key = any($1::text[])
            and facility_id = $2 and created_by = $3 and created_by_membership_id = $4
          order by created_at, operation`,
        [input.keys, context.facilityId, context.actor.accountId, context.membershipId],
      );
      const requested = new Set(input.keys);
      const rows = result.rows.filter((row) => requested.has(row.key));
      const found = new Set(rows.map((row) => row.key));
      await this.audit.recordWithClient(client, {
        ...this.actor(context),
        action: 'ehr.offline.receipts.lookup',
        resourceType: 'offline-receipts',
        outcome: 'success',
        details: { requested: input.keys.length, found: found.size },
      });
      return {
        receipts: rows.map((row): OfflineReceipt => ({
          key: row.key,
          operation: row.operation,
          state: row.state,
          resourceType: row.state === 'completed' ? row.resourceType : null,
          resourceId: row.state === 'completed' ? row.resourceId : null,
          responseStatus: row.responseStatus === null ? null : Number(row.responseStatus),
          createdAt: row.createdAt.toISOString(),
          completedAt: row.state === 'completed' ? row.updatedAt.toISOString() : null,
        })),
        unknown: input.keys.filter((key) => !found.has(key)),
      };
    });
  }

  /**
   * C2. Each event is inserted under its own savepoint with the caller's
   * event_id; a repeated event_id is a duplicate and writes nothing. The
   * conflict has no target on purpose: naming (event_id) needs SELECT on
   * audit.events, and hid_audit_writer has INSERT only. event_id is the only
   * unique key a caller can supply (sequence_id is always generated), so the
   * two are the same here. The
   * device time is clamped into [now - 26 h, now] by the database's clock, so
   * recorded_at >= occurred_at always holds. Never consent-gated.
   */
  async ingestAuditEvents(context: DataAccessContext, input: AuditEventsDto): Promise<AuditIngestResult> {
    requireStaffScope(context);
    const result: AuditIngestResult = { accepted: [], duplicate: [], rejected: [] };
    const parsed = input.events.map((value) => ({ eventId: (value as { eventId: string }).eventId, ...parseAuditEvent(value) }));
    for (const item of parsed) {
      if ('rejected' in item) result.rejected.push({ eventId: item.eventId, code: item.rejected });
    }
    const valid = parsed.flatMap((item) => ('event' in item ? [item.event] : []));
    if (valid.length === 0) return result;
    await this.database.withTransaction(context, async (client) => {
      const allowed = await this.patientsAllowed(client, valid);
      const clock = await client.query<{ now: Date }>('select now() as now');
      const now = clock.rows[0]?.now.getTime();
      if (now === undefined || !Number.isFinite(now)) throw new Error('Database time is unavailable');
      for (const event of valid) {
        if (event.patientId && !allowed.has(event.patientId)) {
          result.rejected.push({ eventId: event.eventId, code: 'PATIENT_NOT_FOUND' });
          continue;
        }
        const outcome = await this.insertAuditEvent(client, context, input.vaultId, event, now);
        if (outcome === 'accepted') result.accepted.push(event.eventId);
        else if (outcome === 'duplicate') result.duplicate.push(event.eventId);
        else result.rejected.push({ eventId: event.eventId, code: outcome });
      }
    });
    return result;
  }

  /**
   * C4. 503 until OFFLINE_ESCROW_ENABLED is true with a valid key set; then
   * at most 30 issues per account per hour on this task. The key is never
   * logged or audited; the issue is.
   */
  async issueEscrowKey(context: DataAccessContext, input: EscrowKeyDto,
    configuration: EscrowConfiguration = escrowConfiguration(), now = Date.now()) {
    if (!configuration.enabled || !configuration.keys) {
      throw new DomainProblem(503, 'OFFLINE_ESCROW_UNAVAILABLE', 'Offline escrow is not available');
    }
    requireStaffScope(context);
    this.admitEscrowIssue(context.actor.accountId, now);
    const keyVersion = input.keyVersion ?? Math.max(...configuration.keys.keys());
    const secret = configuration.keys.get(keyVersion);
    if (!secret) {
      throw new DomainProblem(404, 'OFFLINE_ESCROW_VERSION_UNKNOWN', 'This escrow key version is not available');
    }
    const vaultId = input.vaultId.toLowerCase();
    const key = deriveEscrowKey(secret, context.actor.accountId, context.membershipId, context.facilityId, vaultId);
    await this.audit.record({
      ...this.actor(context),
      action: 'ehr.offline.escrow-key.issue',
      resourceType: 'offline-escrow-key',
      outcome: 'success',
      details: { vaultId, keyVersion },
    });
    return { keyVersion, key: key.toString('base64url'), algorithm: 'HKDF-SHA256' as const };
  }

  /**
   * The patients this caller may record offline reads for: those the
   * database's ehr.offline_audit_patient_allowed accepts (a consent grant to
   * this account, membership and facility, whatever its status now, so a
   * late-synced read still counts). Without it any staff member could put a
   * "viewed your record" row in any patient's access log. Until the function
   * is installed, or if the runtime may not call it, a batch naming a patient
   * is refused whole with 503 and nothing is written; the device keeps its
   * events and sends them again. Session events never need it.
   */
  private async patientsAllowed(client: PoolClient, events: readonly OfflineAuditEventInput[]): Promise<Set<string>> {
    const patients = [...new Set(events.flatMap((event) => (event.patientId ? [event.patientId.toLowerCase()] : [])))];
    const allowed = new Set<string>();
    if (patients.length === 0) return allowed;
    try {
      const installed = await client.query<{ present: boolean }>(
        `select to_regprocedure('ehr.offline_audit_patient_allowed(uuid)') is not null as present`,
      );
      if (installed.rows[0]?.present !== true) throw auditUnavailable();
      for (const patientId of patients) {
        const answer = await client.query<{ allowed: boolean }>(
          'select ehr.offline_audit_patient_allowed($1) as allowed', [patientId],
        );
        if (answer.rows[0]?.allowed === true) allowed.add(patientId);
      }
    } catch (error) {
      if (error instanceof DomainProblem) throw error;
      throw auditUnavailable();
    }
    // Events carry the patient id as sent; match it the way Postgres compares uuids.
    for (const event of events) {
      if (event.patientId && allowed.has(event.patientId.toLowerCase())) allowed.add(event.patientId);
    }
    return allowed;
  }

  private async insertAuditEvent(client: PoolClient, context: DataAccessContext, vaultId: string,
    event: OfflineAuditEventInput, now: number): Promise<'accepted' | 'duplicate' | OfflineAuditRejection> {
    const occurredMs = Math.min(Math.max(event.occurredMs, now - AUDIT_PAST_MS), now);
    const details = {
      offline: true,
      vaultId,
      seq: event.seq,
      section: event.section,
      clock: event.clock,
      deviceOccurredAt: event.occurredAt,
      clamped: occurredMs !== event.occurredMs,
      grantExpiresAt: event.grantExpiresAt,
      ...(event.discarded ?? {}),
    };
    const actor = this.actor(context);
    await client.query('savepoint offline_audit_event');
    try {
      const inserted = await client.query(
        `insert into audit.events (
           event_id, occurred_at, correlation_id, actor_type, actor_subject, actor_account_id,
           actor_membership_id, organization_id, facility_id, patient_id, action,
           resource_type, resource_id, outcome, purpose_of_use, details, provenance,
           source_system, source_event_id
         ) values ($1, $2, $3, 'staff', $4, $5, $6, $7, $8, $9, $10, $11, $12, 'success', 'direct-care',
                   $13::jsonb, 'application', $14, $15)
         on conflict do nothing`,
        [
          event.eventId,
          new Date(occurredMs).toISOString(),
          actor.correlationId,
          actor.actorSubject,
          actor.actorAccountId,
          actor.actorMembershipId,
          actor.organizationId ?? null,
          actor.facilityId,
          event.patientId,
          event.action,
          event.patientId ? 'offline-chart-section' : 'offline-session',
          event.resourceId,
          JSON.stringify(details),
          OFFLINE_SOURCE_SYSTEM,
          `${vaultId}:${event.seq}`,
        ],
      );
      await client.query('release savepoint offline_audit_event');
      return inserted.rowCount === 1 ? 'accepted' : 'duplicate';
    } catch (error) {
      const code = databaseCode(error);
      // A missing patient fails the patient foreign key (a backstop: the check
      // above already refuses a patient it does not know); data the table's
      // checks refuse is the event's fault. Anything else fails the batch, and
      // the device sends it again.
      if (code === '23503' && event.patientId) {
        await client.query('rollback to savepoint offline_audit_event');
        return 'PATIENT_NOT_FOUND';
      }
      if (code === '23514' || code?.startsWith('22')) {
        await client.query('rollback to savepoint offline_audit_event');
        return 'INVALID_EVENT';
      }
      throw error;
    }
  }

  private admitEscrowIssue(accountId: string, now: number): void {
    const recent = (this.escrowIssues.get(accountId) ?? []).filter((at) => at > now - ESCROW_WINDOW_MS);
    if (recent.length >= ESCROW_LIMIT) {
      this.escrowIssues.set(accountId, recent);
      throw new DomainProblem(429, 'OFFLINE_ESCROW_RATE_LIMITED', 'Too many escrow key requests; try again later');
    }
    recent.push(now);
    this.escrowIssues.delete(accountId);
    this.escrowIssues.set(accountId, recent);
    if (this.escrowIssues.size > ESCROW_TRACKED_ACCOUNTS) {
      for (const [account, issues] of this.escrowIssues) {
        if (issues.every((at) => at <= now - ESCROW_WINDOW_MS)) this.escrowIssues.delete(account);
      }
      // Still full of live windows: drop the least recently used account.
      if (this.escrowIssues.size > ESCROW_TRACKED_ACCOUNTS) {
        const oldest = this.escrowIssues.keys().next().value;
        if (oldest !== undefined) this.escrowIssues.delete(oldest);
      }
    }
  }

  private actor(context: DataAccessContext) {
    return {
      correlationId: context.correlationId,
      actorType: 'staff' as const,
      actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId,
      purposeOfUse: context.purposeOfUse,
    };
  }
}

export function escrowConfiguration(): EscrowConfiguration {
  const environment = getEnvironment();
  return {
    enabled: environment.OFFLINE_ESCROW_ENABLED,
    keys: environment.OFFLINE_ESCROW_ENABLED ? parseOfflineEscrowKeys(environment.OFFLINE_ESCROW_KEYS) : undefined,
  };
}

/** Every offline route acts as a staff member at one facility; a patient or facility-less caller is refused. */
function requireStaffScope(context: DataAccessContext): void {
  if (context.actor.kind === 'patient' || !context.facilityId || !context.membershipId || !context.actor.accountId) {
    throw new DomainProblem(403, 'STAFF_FACILITY_REQUIRED', 'Offline routes need a staff member at a facility');
  }
}

function auditUnavailable(): DomainProblem {
  return new DomainProblem(503, 'OFFLINE_AUDIT_UNAVAILABLE', 'Offline audit events cannot be accepted yet; send them again later');
}

function databaseCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}
