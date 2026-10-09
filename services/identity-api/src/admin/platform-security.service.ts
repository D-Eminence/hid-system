import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requirePlatformAssurance } from '../auth/platform-assurance';
import { TokenService, type SessionEventMetadata } from '../auth/token.service';
import { cursorPage, cursorTimestampSql, decodeCursor } from '../common/cursor';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { PlatformAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { adminCommandError } from './admin-command-error';
import { platformAuditActor } from './admin-context';

interface SessionRow extends QueryResultRow {
  sessionId: string; familyId: string; kind: string; authenticationMethod: string; signedInAt: Date;
  lastRefreshedAt: Date; idleExpiresAt: Date; absoluteExpiresAt: Date; mfaVerifiedAt: Date | null;
  mfaMethod: string | null; lastStepUpAt: Date | null; sourceIp: string | null;
}

interface ApprovalRow extends QueryResultRow {
  id: string; action: string; roleCode: string | null; targetAccountId: string; targetEmail: string | null;
  targetDisplayName: string | null; reason: string; status: string; requestedBy: string; requestedAt: Date;
  expiresAt: Date; decidedBy: string | null; decidedAt: Date | null; decisionReason: string | null;
  executedAt: Date | null; version: string; cursorAt: string;
}

const APPROVALS_CURSOR = 'admin.approvals';

interface DecisionRow extends QueryResultRow {
  request_id: string; request_status: string; action: string; target_account_id: string;
  executed: boolean; row_version: string; replayed: boolean;
}

export type ApprovalDecision = 'approve' | 'reject' | 'cancel';

/**
 * Platform session management and two-person approvals. Each command checks
 * the central policy in its own transaction; the SQL commands repeat the
 * permission and step-up checks against the same server-side session.
 */
@Injectable()
export class PlatformSecurityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
  ) {}

  /** Active sessions of one account: safe metadata only, never token material. */
  async listSessions(context: PlatformAccessContext, accountId: string) {
    const own = accountId === context.actor.accountId;
    if (!own && !(context.actor.platformPermissions ?? []).includes('platform.session.revoke')) {
      throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
    }
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<SessionRow>(
        `select current_row.id::text as "sessionId", current_row.family_id::text as "familyId",
                current_row.session_kind as kind, current_row.authentication_method as "authenticationMethod",
                (select min(family.issued_at) from auth.sessions family
                  where family.family_id = current_row.family_id) as "signedInAt",
                current_row.issued_at as "lastRefreshedAt", current_row.expires_at as "idleExpiresAt",
                current_row.absolute_expires_at as "absoluteExpiresAt",
                assurance.mfa_verified_at as "mfaVerifiedAt", assurance.mfa_method as "mfaMethod",
                assurance.step_up_at as "lastStepUpAt", host(current_row.source_ip) as "sourceIp"
           from auth.sessions current_row
           left join auth.session_assurance assurance on assurance.family_id = current_row.family_id
          where current_row.account_id = $1 and current_row.revoked_at is null
            and current_row.expires_at > clock_timestamp() and current_row.absolute_expires_at > clock_timestamp()
          order by current_row.issued_at desc, current_row.id
          limit 100`,
        [accountId],
      );
      return {
        accountId,
        items: result.rows.map((row) => ({ ...row, current: row.sessionId === context.actor.sessionId })),
      };
    }, { readOnly: true });
  }

  /** Revokes one of the administrator's own session families (for example, another device). */
  async revokeOwnSession(context: PlatformAccessContext, sessionId: string, event: SessionEventMetadata) {
    return this.database.withTransaction(context, async (client) => {
      await requirePlatformAssurance(client, context, 'platform.session.revoke-own');
      const family = (await client.query<{ family_id: string }>(
        'select family_id::text from auth.sessions where id = $1 and account_id = $2',
        [sessionId, context.actor.accountId],
      )).rows[0];
      if (!family) throw new DomainProblem(404, 'ADMIN_RESOURCE_NOT_FOUND', 'The requested administration resource was not found');
      const revoked = await client.query(
        `update auth.sessions set revoked_at = clock_timestamp(), revocation_reason = 'self_revoked',
            row_version = row_version + 1
          where family_id = $1 and account_id = $2 and revoked_at is null`,
        [family.family_id, context.actor.accountId],
      );
      await this.tokens.recordSessionEvent(client, { eventType: 'revoked', outcome: 'success',
        accountId: context.actor.accountId, sessionId, event, details: { revokedBy: 'self', revokedCount: revoked.rowCount } });
      await this.audit.recordWithClient(client, this.auditEvent(context, 'admin.session.revoke-own', 'session',
        sessionId, 'Administrator revoked their own session', { revokedCount: revoked.rowCount ?? 0 }));
      return { sessionId, revokedCount: revoked.rowCount ?? 0 };
    });
  }

  /** Revokes a session family of another account; `compromised` records why. */
  async revokeAccountSession(context: PlatformAccessContext, accountId: string, sessionId: string,
    input: { reason: string; compromised: boolean }, idempotencyKey: string) {
    return this.database.withTransaction(context, async (client) => {
      try {
        await requirePlatformAssurance(client, context, 'platform.session.revoke-other');
        const row = (await client.query<{ account_id: string; family_id: string; revoked_count: number; replayed: boolean }>(
          'select * from auth.admin_revoke_session_family($1, $2, $3, $4, $5, $6)',
          [accountId, sessionId, input.compromised, input.reason.trim(), idempotencyKey,
            this.digest({ accountId, sessionId, ...input })],
        )).rows[0];
        if (!row) throw new DomainProblem(503, 'ADMIN_COMMAND_UNAVAILABLE', 'Session command is unavailable');
        if (!row.replayed) {
          await this.audit.recordWithClient(client, this.auditEvent(context, 'admin.session.revoke', 'authentication-account',
            accountId, input.reason, { sessionId, compromised: input.compromised, revokedCount: row.revoked_count }));
        }
        return { accountId: row.account_id, revokedCount: row.revoked_count, replayed: row.replayed };
      } catch (error) { throw adminCommandError(error); }
    });
  }

  /**
   * Approval requests, newest first (requested_at desc, id), one page per call.
   * `nextCursor` is null on the last page; a cursor is bound to the status filter.
   */
  async listApprovals(context: PlatformAccessContext, query: { status?: string; limit?: number; cursor?: string }) {
    const granted = new Set(context.actor.platformPermissions ?? []);
    if (!['platform.role.manage', 'platform.mfa.reset', 'platform.audit.read'].some((code) => granted.has(code))) {
      throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
    }
    const limit = query.limit ?? 50;
    const filters = { status: query.status ?? null };
    const after = query.cursor ? decodeCursor(query.cursor, APPROVALS_CURSOR, filters) : null;
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<ApprovalRow>(
        `select request.id::text, request.action, request.role_code as "roleCode",
                request.target_account_id::text as "targetAccountId", target.email as "targetEmail",
                target.display_name as "targetDisplayName", request.reason,
                case when request.status = 'pending' and request.expires_at <= clock_timestamp()
                  then 'expired' else request.status end as status,
                request.requested_by::text as "requestedBy", request.requested_at as "requestedAt",
                request.expires_at as "expiresAt", request.decided_by::text as "decidedBy",
                request.decided_at as "decidedAt", request.decision_reason as "decisionReason",
                request.executed_at as "executedAt", request.row_version::text as version,
                ${cursorTimestampSql('request.requested_at')} as "cursorAt"
           from auth.admin_approval_requests request
           join auth.accounts target on target.id = request.target_account_id
          where ($1::text is null
             or (case when request.status = 'pending' and request.expires_at <= clock_timestamp()
                   then 'expired' else request.status end) = $1)
            and ($2::timestamptz is null or request.requested_at < $2::timestamptz
              or (request.requested_at = $2::timestamptz and request.id > $3::uuid))
          order by request.requested_at desc, request.id
          limit $4`,
        [filters.status, after?.at ?? null, after?.id ?? null, limit + 1],
      );
      const page = cursorPage(result.rows, limit, APPROVALS_CURSOR, filters);
      return { items: page.rows.map(({ cursorAt: _cursorAt, ...row }) => ({ ...row, version: Number(row.version) })),
        nextCursor: page.nextCursor };
    }, { readOnly: true });
  }

  /** Step one of Super Admin elevation; a different Super Admin must approve. */
  requestSuperAdmin(context: PlatformAccessContext, accountId: string, reason: string, idempotencyKey: string) {
    return this.requestApproval(context, 'platform.role.super-admin.request', 'platform_role.grant', accountId,
      'platform_super_admin', reason, idempotencyKey);
  }

  /** Step one of a lost-authenticator reset; a different Super Admin must approve. */
  requestMfaReset(context: PlatformAccessContext, accountId: string, reason: string, idempotencyKey: string) {
    return this.requestApproval(context, 'platform.mfa.reset.request', 'mfa.reset', accountId, null, reason,
      idempotencyKey);
  }

  async decide(context: PlatformAccessContext, requestId: string, expectedVersion: number, decision: ApprovalDecision,
    reason: string, idempotencyKey: string) {
    const outcome = await this.database.withTransaction(context, async (client) => {
      try {
        await requirePlatformAssurance(client, context, 'platform.approval.decide');
        const row = (await client.query<DecisionRow>(
          'select * from auth.admin_decide_approval($1, $2, $3, $4, $5, $6)',
          [requestId, expectedVersion, decision, reason.trim(), idempotencyKey,
            this.digest({ requestId, expectedVersion, decision, reason: reason.trim() })],
        )).rows[0];
        if (!row) throw new DomainProblem(503, 'ADMIN_COMMAND_UNAVAILABLE', 'Approval command is unavailable');
        if (!row.replayed) await this.auditDecision(client, context, row, reason);
        return row;
      } catch (error) { throw adminCommandError(error); }
    });
    if (outcome.request_status === 'expired') {
      throw new DomainProblem(409, 'APPROVAL_EXPIRED', 'This request expired; create a new one');
    }
    return {
      requestId: outcome.request_id, status: outcome.request_status, action: outcome.action,
      targetAccountId: outcome.target_account_id, executed: outcome.executed,
      version: Number(outcome.row_version), replayed: outcome.replayed,
    };
  }

  private async requestApproval(context: PlatformAccessContext,
    policyAction: 'platform.role.super-admin.request' | 'platform.mfa.reset.request',
    approvalAction: 'platform_role.grant' | 'mfa.reset', accountId: string, roleCode: string | null,
    reason: string, idempotencyKey: string) {
    return this.database.withTransaction(context, async (client) => {
      try {
        await requirePlatformAssurance(client, context, policyAction);
        const row = (await client.query<{ request_id: string; request_status: string; expires_at: Date;
          row_version: string; replayed: boolean }>(
          'select * from auth.admin_request_approval($1, $2, $3, $4, $5, $6)',
          [approvalAction, accountId, roleCode, reason.trim(), idempotencyKey,
            this.digest({ approvalAction, accountId, roleCode, reason: reason.trim() })],
        )).rows[0];
        if (!row) throw new DomainProblem(503, 'ADMIN_COMMAND_UNAVAILABLE', 'Approval command is unavailable');
        if (!row.replayed) {
          await this.audit.recordWithClient(client, this.auditEvent(context, 'admin.approval.requested',
            'admin-approval-request', row.request_id, reason, { action: approvalAction, targetAccountId: accountId, roleCode }));
        }
        return { requestId: row.request_id, status: row.request_status, expiresAt: new Date(row.expires_at).toISOString(),
          version: Number(row.row_version), replayed: row.replayed };
      } catch (error) { throw adminCommandError(error); }
    });
  }

  private async auditDecision(client: PoolClient, context: PlatformAccessContext, row: DecisionRow, reason: string) {
    await this.audit.recordWithClient(client, this.auditEvent(context, `admin.approval.${row.request_status}`,
      'admin-approval-request', row.request_id, reason,
      { action: row.action, targetAccountId: row.target_account_id, executed: row.executed }));
    if (!row.executed) return;
    await this.audit.recordWithClient(client, this.auditEvent(context,
      row.action === 'mfa.reset' ? 'admin.mfa.reset' : 'admin.platform-role.grant',
      'authentication-account', row.target_account_id, reason,
      { approvalRequestId: row.request_id, ...(row.action === 'mfa.reset' ? {} : { roleCode: 'platform_super_admin' }) }));
  }

  private auditEvent(context: PlatformAccessContext, action: string, resourceType: string, resourceId: string,
    reason: string, details: Record<string, unknown>) {
    return { ...platformAuditActor(context), action, resourceType, resourceId, outcome: 'success' as const,
      purposeOfUse: 'healthcare-operations', reason: reason.trim(), details };
  }

  private digest(value: unknown): string {
    return requestDigest('platform.security.command', value);
  }
}
