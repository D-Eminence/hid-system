import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { AccountStatusCommandDto, FacilityStatusCommandDto,
  PlatformRoleCommandDto, RevokeSessionsCommandDto } from './dto/admin-command.dto';
import type { ListFacilitiesDto, ListIdentityReviewsDto,
  ListPlatformAuditDto, ListPrincipalsDto } from './dto/admin-list.dto';

interface FacilityRow extends QueryResultRow {
  id: string; organizationId: string; organizationName: string; name: string; code: string;
  status: string; version: string; statusReason: string | null; statusChangedAt: Date | null;
  createdAt: Date; membershipCount: string;
}

interface PrincipalRow extends QueryResultRow {
  id: string; subject: string; email: string | null; displayName: string | null;
  status: string; version: string; createdAt: Date; activeSessionCount: string;
  memberships: unknown; platformRoles: string[];
}

interface ReviewRow extends QueryResultRow {
  id: string; facilityId: string; facilityName: string; status: string;
  maskedNin: string; provider: string; candidateCount: string; version: string;
  createdAt: Date; updatedAt: Date;
}

interface CommandRow extends QueryResultRow { replayed: boolean }
interface FacilityCommandRow extends CommandRow { facility_id: string; lifecycle_status: string; row_version: string }
interface AccountCommandRow extends CommandRow { account_id: string; account_status: string; row_version: string }
interface RoleCommandRow extends CommandRow { account_id: string; role_code: string; active: boolean; account_version: string }
interface SessionCommandRow extends CommandRow { account_id: string; revoked_count: number }

@Injectable()
export class AdminService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  session(context: DataAccessContext) {
    return {
      actor: {
        accountId: context.actor.accountId,
        subject: context.actor.subject,
        displayName: context.actor.displayName ?? null,
        email: context.actor.email ?? null,
        platformRoles: context.actor.platformRoles ?? [],
        platformPermissions: context.actor.platformPermissions ?? [],
      },
    };
  }

  async overview(context: DataAccessContext) {
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<{
        registered_patients: string; facilities: string; verified_facilities: string;
        suspended_facilities: string; active_memberships: string; pending_identity_reviews: string;
      }>(`select registered_patients::text, facilities::text, verified_facilities::text,
        suspended_facilities::text, active_memberships::text, pending_identity_reviews::text
        from identity.admin_platform_overview()`);
      const row = result.rows[0];
      if (!row) throw new DomainProblem(503, 'ADMIN_DATA_UNAVAILABLE', 'Administration data is unavailable');
      return {
        registeredPatients: Number(row.registered_patients), facilities: Number(row.facilities),
        verifiedFacilities: Number(row.verified_facilities), suspendedFacilities: Number(row.suspended_facilities),
        activeStaffMemberships: Number(row.active_memberships), pendingIdentityReviews: Number(row.pending_identity_reviews),
      };
    }, { readOnly: true });
  }

  async listFacilities(context: DataAccessContext, query: ListFacilitiesDto) {
    const offset = (query.page - 1) * query.pageSize;
    const term = query.query ? `%${this.escapeLike(query.query.trim())}%` : null;
    return this.database.withTransaction(context, async (client) => {
      const [items, total] = await Promise.all([
        client.query<FacilityRow>(`select facility.id::text, facility.organization_id::text as "organizationId",
          organization.name as "organizationName", facility.name, facility.code,
          facility.lifecycle_status as status, facility.row_version::text as version,
          facility.status_reason as "statusReason", facility.status_changed_at as "statusChangedAt",
          facility.created_at as "createdAt",
          (select count(*) from identity.staff_facility_memberships membership
            where membership.facility_id = facility.id and membership.active)::text as "membershipCount"
        from identity.facilities facility
        join identity.organizations organization on organization.id = facility.organization_id
        where ($1::text is null or facility.lifecycle_status = $1)
          and ($2::text is null or facility.name ilike $2 escape '\\' or facility.code ilike $2 escape '\\')
        order by facility.updated_at desc, facility.id
        limit $3 offset $4`, [query.status ?? null, term, query.pageSize, offset]),
        client.query<{ count: string }>(`select count(*)::text from identity.facilities facility
          where ($1::text is null or facility.lifecycle_status = $1)
            and ($2::text is null or facility.name ilike $2 escape '\\' or facility.code ilike $2 escape '\\')`,
        [query.status ?? null, term]),
      ]);
      return { items: items.rows.map((row) => ({ ...row, version: Number(row.version), membershipCount: Number(row.membershipCount) })),
        page: query.page, pageSize: query.pageSize, total: Number(total.rows[0]?.count ?? 0) };
    }, { readOnly: true });
  }

  async facility(context: DataAccessContext, facilityId: string) {
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<FacilityRow>(`select facility.id::text,
        facility.organization_id::text as "organizationId", organization.name as "organizationName",
        facility.name, facility.code, facility.lifecycle_status as status,
        facility.row_version::text as version, facility.status_reason as "statusReason",
        facility.status_changed_at as "statusChangedAt", facility.created_at as "createdAt",
        (select count(*) from identity.staff_facility_memberships membership
          where membership.facility_id = facility.id and membership.active)::text as "membershipCount"
      from identity.facilities facility
      join identity.organizations organization on organization.id = facility.organization_id
      where facility.id = $1`, [facilityId]);
      const row = result.rows[0];
      if (!row) throw new DomainProblem(404, 'ADMIN_FACILITY_NOT_FOUND', 'Facility was not found');
      return { ...row, version: Number(row.version), membershipCount: Number(row.membershipCount) };
    }, { readOnly: true });
  }

  async transitionFacility(context: DataAccessContext, facilityId: string, expectedVersion: number,
    input: FacilityStatusCommandDto, idempotencyKey: string) {
    const digest = this.digest({ facilityId, expectedVersion, ...input });
    return this.database.withTransaction(context, async (client) => {
      try {
        const result = await client.query<FacilityCommandRow>(
          `select * from identity.admin_transition_facility($1, $2, $3, $4, $5, $6)`,
          [facilityId, expectedVersion, input.status, input.reason.trim(), idempotencyKey, digest],
        );
        const row = result.rows[0];
        if (!row) throw new DomainProblem(503, 'ADMIN_COMMAND_UNAVAILABLE', 'Facility command is unavailable');
        if (!row.replayed) await this.audit.recordWithClient(client, this.auditEvent(context,
          `admin.facility.${input.status}`, 'facility', facilityId, input.reason,
          { status: input.status, version: Number(row.row_version) }));
        return { facilityId: row.facility_id, status: row.lifecycle_status,
          version: Number(row.row_version), replayed: row.replayed };
      } catch (error) { throw this.commandError(error); }
    });
  }

  async listPrincipals(context: DataAccessContext, query: ListPrincipalsDto) {
    const offset = (query.page - 1) * query.pageSize;
    const term = `%${this.escapeLike(query.query.trim())}%`;
    return this.database.withTransaction(context, async (client) => {
      const [items, total] = await Promise.all([
        client.query<PrincipalRow>(`select account.id::text, account.subject, account.email,
          account.display_name as "displayName", account.status, account.row_version::text as version,
          account.created_at as "createdAt",
          (select count(*) from auth.sessions session where session.account_id = account.id
            and session.revoked_at is null and session.expires_at > clock_timestamp())::text as "activeSessionCount",
          coalesce((select jsonb_agg(jsonb_build_object('id', membership.id, 'facilityId', membership.facility_id,
            'facilityName', facility.name, 'role', membership.membership_role, 'appRole', membership.app_role,
            'active', membership.active, 'version', membership.row_version) order by facility.name)
            from identity.staff_facility_memberships membership
            join identity.facilities facility on facility.id = membership.facility_id
            where membership.account_id = account.id), '[]'::jsonb) as memberships,
          coalesce((select array_agg(assignment.role_code order by assignment.role_code)
            from auth.account_roles assignment where assignment.account_id = account.id
              and assignment.scope_type = 'platform' and assignment.revoked_at is null), array[]::text[]) as "platformRoles"
        from auth.accounts account
        where (account.email ilike $1 escape '\\' or account.display_name ilike $1 escape '\\'
          or account.subject ilike $1 escape '\\')
          and ($2::text is null or account.status = $2)
        order by account.updated_at desc, account.id limit $3 offset $4`,
        [term, query.status ?? null, query.pageSize, offset]),
        client.query<{ count: string }>(`select count(*)::text from auth.accounts account
          where (account.email ilike $1 escape '\\' or account.display_name ilike $1 escape '\\'
            or account.subject ilike $1 escape '\\') and ($2::text is null or account.status = $2)`,
        [term, query.status ?? null]),
      ]);
      return { items: items.rows.map((row) => ({ ...row, version: Number(row.version),
          activeSessionCount: Number(row.activeSessionCount) })), page: query.page,
        pageSize: query.pageSize, total: Number(total.rows[0]?.count ?? 0) };
    }, { readOnly: true });
  }

  async transitionAccount(context: DataAccessContext, accountId: string, expectedVersion: number,
    input: AccountStatusCommandDto, idempotencyKey: string) {
    return this.accountCommand(context, 'status', accountId, input.reason, idempotencyKey,
      { accountId, expectedVersion, ...input }, async (client, digest) => {
        const result = await client.query<AccountCommandRow>(
          `select * from auth.admin_transition_account($1, $2, $3, $4, $5, $6)`,
          [accountId, expectedVersion, input.status, input.reason.trim(), idempotencyKey, digest]);
        const row = result.rows[0];
        if (!row) throw new DomainProblem(503, 'ADMIN_COMMAND_UNAVAILABLE', 'Account command is unavailable');
        return { row, response: { accountId: row.account_id, status: row.account_status,
          version: Number(row.row_version), replayed: row.replayed },
        action: `admin.account.${input.status}`, details: { status: input.status, version: Number(row.row_version) } };
      });
  }

  async changePlatformRole(context: DataAccessContext, accountId: string, expectedVersion: number,
    input: PlatformRoleCommandDto, idempotencyKey: string) {
    return this.accountCommand(context, 'role', accountId, input.reason, idempotencyKey,
      { accountId, expectedVersion, ...input }, async (client, digest) => {
        const result = await client.query<RoleCommandRow>(
          `select * from auth.admin_change_platform_role($1, $2, $3, $4, $5, $6, $7)`,
          [accountId, expectedVersion, input.roleCode, input.action, input.reason.trim(), idempotencyKey, digest]);
        const row = result.rows[0];
        if (!row) throw new DomainProblem(503, 'ADMIN_COMMAND_UNAVAILABLE', 'Role command is unavailable');
        return { row, response: { accountId: row.account_id, roleCode: row.role_code,
          active: row.active, version: Number(row.account_version), replayed: row.replayed },
        action: `admin.platform-role.${input.action}`, details: { roleCode: row.role_code, active: row.active } };
      });
  }

  async revokeSessions(context: DataAccessContext, accountId: string, input: RevokeSessionsCommandDto,
    idempotencyKey: string) {
    return this.accountCommand(context, 'sessions', accountId, input.reason, idempotencyKey,
      { accountId, ...input }, async (client, digest) => {
        const result = await client.query<SessionCommandRow>(
          `select * from auth.admin_revoke_account_sessions($1, $2, $3, $4)`,
          [accountId, input.reason.trim(), idempotencyKey, digest]);
        const row = result.rows[0];
        if (!row) throw new DomainProblem(503, 'ADMIN_COMMAND_UNAVAILABLE', 'Session command is unavailable');
        return { row, response: { accountId: row.account_id, revokedCount: row.revoked_count, replayed: row.replayed },
          action: 'admin.account.sessions-revoked', details: { revokedCount: row.revoked_count } };
      });
  }

  async listIdentityReviews(context: DataAccessContext, query: ListIdentityReviewsDto) {
    const offset = (query.page - 1) * query.pageSize;
    return this.database.withTransaction(context, async (client) => {
      const [items, total] = await Promise.all([
        client.query<ReviewRow>(`select registration.id::text, registration.facility_id::text as "facilityId",
          facility.name as "facilityName", registration.status,
          concat('NIN-****', registration.nin_last4) as "maskedNin",
          registration.verification_provider as provider,
          (select count(*) from identity.registration_case_candidates candidate
            where candidate.case_id = registration.id)::text as "candidateCount",
          registration.row_version::text as version, registration.created_at as "createdAt",
          registration.updated_at as "updatedAt"
        from identity.registration_cases registration
        join identity.facilities facility on facility.id = registration.facility_id
        where ($1::text is null or registration.status = $1)
        order by registration.updated_at desc, registration.id limit $2 offset $3`,
        [query.status ?? null, query.pageSize, offset]),
        client.query<{ count: string }>(`select count(*)::text from identity.registration_cases
          where ($1::text is null or status = $1)`, [query.status ?? null]),
      ]);
      return { items: items.rows.map((row) => ({ ...row, candidateCount: Number(row.candidateCount), version: Number(row.version) })),
        page: query.page, pageSize: query.pageSize, total: Number(total.rows[0]?.count ?? 0) };
    }, { readOnly: true });
  }

  async listAudit(context: DataAccessContext, query: ListPlatformAuditDto) {
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<Record<string, unknown> & QueryResultRow>(
        `select sequence_id::text as "sequenceId", event_id::text as "eventId",
          occurred_at as "occurredAt", correlation_id as "correlationId", actor_type as "actorType",
          actor_subject as "actorSubject", facility_id::text as "facilityId",
          action, outcome, resource_type as "resourceType", resource_id as "resourceId",
          purpose_of_use as "purposeOfUse", reason, source_system as "sourceSystem"
        from audit.list_platform_events($1, $2::bigint, $3, $4::uuid, $5, $6, $7, $8, $9)`,
        [query.limit, query.beforeSequenceId ?? null, query.actor ?? null, query.facilityId ?? null,
          query.action ?? null, query.correlationId ?? null, query.outcome ?? null,
          query.from ?? null, query.to ?? null]);
      await this.audit.recordWithClient(client, this.auditEvent(context, 'admin.audit.list',
        'audit-event-collection', null, 'Platform audit review', { returnedCount: result.rows.length }));
      const tail = result.rows.at(-1) as { sequenceId?: string } | undefined;
      return { items: result.rows, nextBeforeSequenceId: result.rows.length === query.limit ? tail?.sequenceId ?? null : null };
    });
  }

  private async accountCommand<T>(context: DataAccessContext, _kind: string, accountId: string,
    reason: string, _key: string, request: unknown,
    run: (client: import('pg').PoolClient, digest: string) => Promise<{
      row: CommandRow; response: T; action: string; details: Record<string, unknown>;
    }>): Promise<T> {
    return this.database.withTransaction(context, async (client) => {
      try {
        const result = await run(client, this.digest(request));
        if (!result.row.replayed) await this.audit.recordWithClient(client,
          this.auditEvent(context, result.action, 'authentication-account', accountId, reason, result.details));
        return result.response;
      } catch (error) { throw this.commandError(error); }
    });
  }

  private auditEvent(context: DataAccessContext, action: string, resourceType: string,
    resourceId: string | null, reason: string, details: Record<string, unknown>) {
    return { correlationId: context.correlationId, actorType: 'staff' as const,
      actorSubject: context.actor.subject, actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId, organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId, action, resourceType, resourceId: resourceId ?? undefined,
      outcome: 'success' as const, purposeOfUse: 'healthcare-operations', reason: reason.trim(), details };
  }

  private digest(value: unknown): string {
    return requestDigest('platform.admin.command', value);
  }

  private escapeLike(value: string): string { return value.replace(/[\\%_]/g, (match) => `\\${match}`); }

  private commandError(error: unknown): Error {
    if (error instanceof DomainProblem) return error;
    const message = typeof error === 'object' && error && 'message' in error ? String(error.message) : '';
    if (message.includes('ADMIN_PERMISSION_DENIED')) return new DomainProblem(403, 'PERMISSION_DENIED', 'Administrative permission is missing');
    if (message.includes('ADMIN_VERSION_CONFLICT')) return new DomainProblem(409, 'VERSION_CONFLICT', 'The resource changed; reload before retrying');
    if (message.includes('ADMIN_IDEMPOTENCY_CONFLICT')) return new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was used for a different command');
    if (message.includes('ADMIN_LAST_SUPER_ADMIN')) return new DomainProblem(409, 'LAST_SUPER_ADMIN', 'At least one active platform Super Admin must remain');
    if (message.includes('NOT_FOUND') || message.includes('NOT_ACTIVE')) return new DomainProblem(404, 'ADMIN_RESOURCE_NOT_FOUND', 'The requested administration resource was not found');
    if (message.includes('ALREADY_ACTIVE') || message.includes('NO_STATE_CHANGE')) return new DomainProblem(409, 'ADMIN_STATE_CONFLICT', 'The requested state is already active');
    if (message.includes('ADMIN_INVALID') || message.includes('ADMIN_REASON_REQUIRED')) return new DomainProblem(400, 'ADMIN_COMMAND_INVALID', 'The administration command is invalid');
    return new DomainProblem(503, 'ADMIN_COMMAND_UNAVAILABLE', 'The administration command could not be completed');
  }
}
