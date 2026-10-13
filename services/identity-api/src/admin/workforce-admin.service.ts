import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requirePlatformAssurance } from '../auth/platform-assurance';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { PlatformAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { adminCommandError } from './admin-command-error';
import { platformAuditActor } from './admin-context';
import type { PlatformAction } from './high-risk-policy';
import type {
  WorkforceAttachCommandDto, WorkforceAttestationCommandDto, WorkforceEndMembershipCommandDto, WorkforceRoleCommandDto,
} from './dto/workforce-command.dto';

interface CommandRow extends QueryResultRow { replayed: boolean }
interface AttachRow extends CommandRow {
  membership_id: string; account_id: string; staff_id: string; facility_id: string; account_status: string;
  account_created: boolean; membership_version: string; staff_version: string;
}
interface AttestationRow extends CommandRow {
  attestation_id: string; account_id: string; staff_id: string; attested_roles: string[]; valid_until: Date;
  verification_status: string; staff_version: string;
}
interface RoleRow extends CommandRow {
  membership_id: string; facility_id: string; role_code: string; role_active: boolean; membership_active: boolean;
  membership_state: string; membership_version: string; attestation_id: string | null; renewed: boolean;
}
interface EndRow extends CommandRow {
  membership_id: string; facility_id: string; account_id: string; revoked_roles: number; revoked_grants: number;
  expired_requests: number; revoked_sessions: number; membership_version: string;
}

interface CommandResult<T> {
  row: CommandRow;
  response: T;
  action: string;
  resourceType: string;
  resourceId: string;
  details: Record<string, unknown>;
}

/**
 * Launch D14: governed clinician provisioning (0087). Each command runs in one
 * transaction that first re-checks the platform session and step-up for its
 * action, then calls its SECURITY DEFINER command, which repeats the
 * permission, MFA, step-up, version, reason and idempotency checks and the
 * workforce rules (no self-provisioning, no administrator who works at the
 * facility, an independent reviewer's current attestation for a role). A grant
 * of a role the membership already holds renews it on a newer attestation
 * (`renewed: true`) when its own has lapsed or the newer one lasts longer. A new
 * command (not a replay) is recorded as a platform-scoped semantic audit event
 * in the same transaction.
 */
@Injectable()
export class WorkforceAdminService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  async profile(context: PlatformAccessContext, accountId: string): Promise<Record<string, unknown>> {
    return this.database.withTransaction(context, async (client) => {
      try {
        const result = await client.query<{ profile: Record<string, unknown> }>(
          'select identity.admin_workforce_profile($1) as profile', [accountId]);
        const profile = result.rows[0]?.profile;
        if (!profile) throw new DomainProblem(503, 'ADMIN_COMMAND_UNAVAILABLE', 'Workforce profile is unavailable');
        return profile;
      } catch (error) { throw adminCommandError(error); }
    }, { readOnly: true });
  }

  async attach(context: PlatformAccessContext, input: WorkforceAttachCommandDto, idempotencyKey: string) {
    const existing = input.accountId !== undefined;
    if (existing === (input.email !== undefined) || (existing && input.fullName !== undefined)
      || (!existing && input.fullName === undefined)) {
      throw new DomainProblem(400, 'WORKFORCE_COMMAND_INVALID',
        'Name either an existing account, or the email and full name of a new staff identity');
    }
    return this.command(context, 'platform.workforce.attach', input.reason, input, async (client, digest) => {
      const result = await client.query<AttachRow>(
        'select * from identity.admin_attach_workforce_member($1, $2, $3, $4, $5, $6, $7)',
        [input.facilityId, input.accountId ?? null, input.email ?? null, input.fullName ?? null, input.reason.trim(),
          idempotencyKey, digest]);
      const row = this.single(result.rows);
      return { row, response: { membershipId: row.membership_id, accountId: row.account_id, staffId: row.staff_id,
          facilityId: row.facility_id, state: 'pending' as const, accountStatus: row.account_status,
          accountCreated: row.account_created, membershipVersion: Number(row.membership_version),
          staffVersion: Number(row.staff_version), replayed: row.replayed },
        action: 'admin.workforce.membership.attached', resourceType: 'staff-membership', resourceId: row.membership_id,
        details: { accountId: row.account_id, facilityId: row.facility_id, accountCreated: row.account_created } };
    });
  }

  async attest(context: PlatformAccessContext, accountId: string, expectedStaffVersion: number,
    input: WorkforceAttestationCommandDto, idempotencyKey: string) {
    const validUntil = new Date(input.validUntil);
    if (Number.isNaN(validUntil.getTime())) {
      throw new DomainProblem(400, 'WORKFORCE_COMMAND_INVALID', 'validUntil must be a date and time');
    }
    return this.command(context, 'platform.workforce.attest', input.reason,
      { accountId, expectedStaffVersion, ...input }, async (client, digest) => {
        const result = await client.query<AttestationRow>(
          `select * from identity.admin_record_credential_attestation($1, $2, $3::text[], $4, $5, $6, $7, $8, $9, $10)`,
          [accountId, expectedStaffVersion, input.attestedRoles, input.credentialReference, input.issuingAuthority,
            input.evidenceReference, validUntil.toISOString(), input.reason.trim(), idempotencyKey, digest]);
        const row = this.single(result.rows);
        return { row, response: { attestationId: row.attestation_id, accountId: row.account_id, staffId: row.staff_id,
            attestedRoles: row.attested_roles, verificationMethod: 'manual_review' as const,
            validUntil: new Date(row.valid_until).toISOString(), verificationStatus: row.verification_status,
            staffVersion: Number(row.staff_version), replayed: row.replayed },
          action: 'admin.workforce.credential.attested', resourceType: 'staff-credential-attestation',
          resourceId: row.attestation_id,
          details: { accountId: row.account_id, attestedRoles: row.attested_roles,
            validUntil: new Date(row.valid_until).toISOString(), verificationMethod: 'manual_review' } };
      });
  }

  async changeRole(context: PlatformAccessContext, membershipId: string, expectedVersion: number,
    input: WorkforceRoleCommandDto, idempotencyKey: string) {
    return this.command(context, 'platform.workforce.role.change', input.reason,
      { membershipId, expectedVersion, ...input }, async (client, digest) => {
        const result = await client.query<RoleRow>(
          'select * from identity.admin_change_workforce_role($1, $2, $3, $4, $5, $6, $7, $8)',
          [membershipId, input.facilityId, expectedVersion, input.roleCode, input.action, input.reason.trim(),
            idempotencyKey, digest]);
        const row = this.single(result.rows);
        return { row, response: { membershipId: row.membership_id, facilityId: row.facility_id, roleCode: row.role_code,
            roleActive: row.role_active, membershipActive: row.membership_active, state: row.membership_state,
            version: Number(row.membership_version), attestationId: row.attestation_id, renewed: row.renewed === true,
            replayed: row.replayed },
          action: `admin.workforce.role.${input.action === 'grant' ? 'granted' : 'revoked'}`,
          resourceType: 'staff-membership', resourceId: row.membership_id,
          details: { facilityId: row.facility_id, roleCode: row.role_code, membershipActive: row.membership_active,
            attestationId: row.attestation_id, renewed: row.renewed === true } };
      });
  }

  async endMembership(context: PlatformAccessContext, membershipId: string, expectedVersion: number,
    input: WorkforceEndMembershipCommandDto, idempotencyKey: string) {
    return this.command(context, 'platform.workforce.membership.end', input.reason,
      { membershipId, expectedVersion, ...input }, async (client, digest) => {
        const result = await client.query<EndRow>(
          'select * from identity.admin_end_workforce_membership($1, $2, $3, $4, $5, $6)',
          [membershipId, input.facilityId, expectedVersion, input.reason.trim(), idempotencyKey, digest]);
        const row = this.single(result.rows);
        const counts = { revokedRoles: row.revoked_roles, revokedGrants: row.revoked_grants,
          expiredRequests: row.expired_requests, revokedSessions: row.revoked_sessions };
        return { row, response: { membershipId: row.membership_id, facilityId: row.facility_id,
            accountId: row.account_id, state: 'ended' as const, ...counts, version: Number(row.membership_version),
            replayed: row.replayed },
          action: 'admin.workforce.membership.ended', resourceType: 'staff-membership', resourceId: row.membership_id,
          details: { facilityId: row.facility_id, accountId: row.account_id, ...counts } };
      });
  }

  private async command<T>(context: PlatformAccessContext, action: PlatformAction, reason: string, request: unknown,
    run: (client: PoolClient, digest: string) => Promise<CommandResult<T>>): Promise<T> {
    return this.database.withTransaction(context, async (client) => {
      try {
        await requirePlatformAssurance(client, context, action);
        const result = await run(client, requestDigest(`platform.workforce:${action}`, request));
        if (!result.row.replayed) {
          await this.audit.recordWithClient(client, { ...platformAuditActor(context), action: result.action,
            resourceType: result.resourceType, resourceId: result.resourceId, outcome: 'success',
            purposeOfUse: 'healthcare-operations', reason: reason.trim(), details: result.details });
        }
        return result.response;
      } catch (error) { throw adminCommandError(error); }
    });
  }

  private single<Row extends QueryResultRow>(rows: Row[]): Row {
    const row = rows[0];
    if (!row) throw new DomainProblem(503, 'ADMIN_COMMAND_UNAVAILABLE', 'The workforce command is unavailable');
    return row;
  }
}
