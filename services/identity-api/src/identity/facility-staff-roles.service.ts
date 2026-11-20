import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requireNoRecentRecoveryHold } from '../auth/recent-authentication';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest, PlatformAdminContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { AddFacilityStaffRoleDto, AdminAddFacilityStaffRoleDto, AdminRemoveFacilityStaffRoleDto,
  RemoveFacilityStaffRoleDto } from './dto/staff-role.dto';
import { unavailableFor } from './staff-invitation-problems';
import { STAFF_ATTESTATION_VERSION, StaffInvitationsService } from './staff-invitations.service';
import { normalizeLicenceNumber, staffRoleLicenceBody } from './staff-licence';
import { StaffReauthenticationService } from './staff-reauthentication.service';
import { staffRoleProblem } from './staff-role-problems';

type Count = string | number | null;

interface RoleChangeRow extends QueryResultRow {
  membership_id: string;
  row_version: Count;
  roles: string[] | null;
  previous_roles?: string[] | null;
  requests_closed?: Count;
  replayed?: boolean | null;
}

/** The answer of every SX-4 command; `status` is 201 for a new grant, else 200. */
export interface StaffRoleAnswer {
  status: 200 | 201;
  body: { membershipId: string; version: number; roles: string[]; replayed: boolean };
}

/** The four statements, exactly as identity-api sends them (0139). */
export const ADD_FACILITY_STAFF_ROLE_SQL = 'select * from identity.add_facility_staff_role($1,$2,$3,$4,$5,$6,$7,$8,$9)';
export const REMOVE_FACILITY_STAFF_ROLE_SQL = 'select * from identity.remove_facility_staff_role($1,$2,$3,$4)';
export const ADMIN_ADD_FACILITY_STAFF_ROLE_SQL =
  'select * from identity.admin_add_facility_staff_role($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)';
export const ADMIN_REMOVE_FACILITY_STAFF_ROLE_SQL =
  'select * from identity.admin_remove_facility_staff_role($1,$2,$3,$4,$5,$6,$7)';

function count(value: Count | undefined): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function isRefusal(problem: DomainProblem): boolean {
  return problem.getStatus() < 500;
}

/**
 * SX-4 (0139, owner decision Q129 A): add or remove one role for a member of
 * staff. The facility administrator does it at a reviewed self-signed-up
 * facility, after the password (and, for an add, the staff-invitations gate
 * and the recovery hold); Health ID support does it at any facility, with
 * If-Match and an Idempotency-Key, and records how it checked a licence. The
 * database decides everything else and writes the administrator's success
 * row; this service writes the administrator's refusal row
 * (identity.facility-staff.role-add or .role-remove, outcome denied) and
 * support's success row (admin.facility-staff.role-add or .role-remove), in
 * the command's transaction. No row ever holds a licence number.
 */
@Injectable()
export class FacilityStaffRolesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly invitations: StaffInvitationsService,
    private readonly reauthentication: StaffReauthenticationService,
    private readonly audit: AuditService,
  ) {}

  /** The administrator adds one role: 201, or 200 with replayed: true for a replay of the same key and request. */
  async add(context: DataAccessContext, request: HidRequest, membershipId: string, input: AddFacilityStaffRoleDto,
    idempotencyKey: string): Promise<StaffRoleAnswer> {
    const licence = this.licence(input.role, input.licenceBody, input.licenceNumber);
    const digest = requestDigest('identity.facility-staff.role-add', {
      facilityId: context.facilityId, membershipId, expectedVersion: input.expectedVersion, role: input.role,
      licenceBody: licence.body, licenceNumber: licence.number, attested: input.attested, reason: input.reason,
    });
    try {
      this.invitations.requireSelfService(context.actor.facility, 'reviewed');
      await this.invitations.assertOpen('staff');
      await this.reauthentication.confirm(context.actor, input.currentPassword, request);
      const row = await this.database.withTransaction(context, async (client) => {
        await requireNoRecentRecoveryHold(client, context.actor.accountId, 'staff invitations and role changes',
          'STAFF_RECENT_RECOVERY_HOLD');
        return (await client.query<RoleChangeRow>(ADD_FACILITY_STAFF_ROLE_SQL,
          [membershipId, input.expectedVersion, input.role, licence.body, licence.number, STAFF_ATTESTATION_VERSION,
            input.reason, idempotencyKey, digest])).rows[0];
      });
      return this.answer(row, row?.replayed === true ? 200 : 201);
    } catch (error) {
      throw await this.facilityRefusal(context, 'identity.facility-staff.role-add', membershipId, input.role,
        input.reason, error);
    }
  }

  /** The administrator removes one role: 200; a retry after success is 409 FACILITY_STAFF_ROLE_NOT_HELD. */
  async remove(context: DataAccessContext, request: HidRequest, membershipId: string,
    input: RemoveFacilityStaffRoleDto): Promise<StaffRoleAnswer> {
    try {
      this.invitations.requireSelfService(context.actor.facility, 'reviewed');
      await this.reauthentication.confirm(context.actor, input.currentPassword, request);
      const row = await this.database.withTransaction(context, async (client) => (await client.query<RoleChangeRow>(
        REMOVE_FACILITY_STAFF_ROLE_SQL, [membershipId, input.expectedVersion, input.role, input.reason])).rows[0]);
      return this.answer(row, 200);
    } catch (error) {
      throw await this.facilityRefusal(context, 'identity.facility-staff.role-remove', membershipId, input.role,
        input.reason, error);
    }
  }

  /** Support adds one role at any facility: 201, or 200 with replayed: true. */
  async adminAdd(context: PlatformAdminContext, facilityId: string, membershipId: string, expectedVersion: number,
    input: AdminAddFacilityStaffRoleDto, idempotencyKey: string): Promise<StaffRoleAnswer> {
    const licence = this.licence(input.role, input.licenceBody, input.licenceNumber);
    const method = licence.body === null ? null : input.verificationMethod ?? null;
    const digest = requestDigest('admin.facility-staff.role-add', {
      facilityId, membershipId, expectedVersion, role: input.role, licenceBody: licence.body,
      licenceNumber: licence.number, verificationMethod: method, attested: input.attested, reason: input.reason,
    });
    return this.database.withPlatformTransaction(context, async (client) => {
      let row: RoleChangeRow | undefined;
      try {
        row = (await client.query<RoleChangeRow>(ADMIN_ADD_FACILITY_STAFF_ROLE_SQL,
          [facilityId, membershipId, expectedVersion, input.role, licence.body, licence.number, method, input.reason,
            idempotencyKey, digest])).rows[0];
      } catch (error) {
        throw staffRoleProblem(error, 'support');
      }
      if (row && row.replayed !== true) {
        await this.supportAudit(client, context, 'admin.facility-staff.role-add', facilityId, membershipId, input.reason,
          { roleCode: input.role, licenceBody: licence.body, verificationMethod: method,
            previousRoles: row.previous_roles ?? [], roles: row.roles ?? [] });
      }
      return this.answer(row, row?.replayed === true ? 200 : 201);
    });
  }

  /** Support removes one role at any facility: 200, a replay with replayed: true. */
  async adminRemove(context: PlatformAdminContext, facilityId: string, membershipId: string, expectedVersion: number,
    input: AdminRemoveFacilityStaffRoleDto, idempotencyKey: string): Promise<StaffRoleAnswer> {
    const digest = requestDigest('admin.facility-staff.role-remove', {
      facilityId, membershipId, expectedVersion, role: input.role, reason: input.reason,
    });
    return this.database.withPlatformTransaction(context, async (client) => {
      let row: RoleChangeRow | undefined;
      try {
        row = (await client.query<RoleChangeRow>(ADMIN_REMOVE_FACILITY_STAFF_ROLE_SQL,
          [facilityId, membershipId, expectedVersion, input.role, input.reason, idempotencyKey, digest])).rows[0];
      } catch (error) {
        throw staffRoleProblem(error, 'support');
      }
      if (row && row.replayed !== true) {
        await this.supportAudit(client, context, 'admin.facility-staff.role-remove', facilityId, membershipId,
          input.reason, { roleCode: input.role, previousRoles: row.previous_roles ?? [], roles: row.roles ?? [],
            requestsClosed: count(row.requests_closed) });
      }
      return this.answer(row, 200);
    });
  }

  /** The licence a request carries for its role: none for the front desk, else the body and the stored number. */
  private licence(role: string, body: string | null | undefined, number: string | null | undefined) {
    if (staffRoleLicenceBody(role) === null) return { body: null, number: null };
    return { body: body ?? null, number: typeof number === 'string' ? normalizeLicenceNumber(number) : null };
  }

  private answer(row: RoleChangeRow | undefined, status: 200 | 201): StaffRoleAnswer {
    if (!row) throw unavailableFor('staff');
    return { status, body: { membershipId: row.membership_id, version: count(row.row_version), roles: row.roles ?? [],
      replayed: row.replayed === true } };
  }

  /**
   * The administrator's refusal: mapped, then one denied row at the facility
   * with the membership, role, reason and code (its own connection: the
   * command's transaction, with the database's own row, rolled back). A 5xx
   * is not a refusal and writes none.
   */
  private async facilityRefusal(context: DataAccessContext, action: string, membershipId: string, role: string,
    reason: string, error: unknown): Promise<DomainProblem> {
    const problem = staffRoleProblem(error, 'facility');
    if (isRefusal(problem)) {
      await this.audit.record({
        correlationId: context.correlationId, actorType: 'staff', actorSubject: context.actor.subject,
        actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
        organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId, action,
        resourceType: 'staff-membership', resourceId: membershipId, outcome: 'denied',
        purposeOfUse: 'healthcare-operations', reason,
        details: { membershipId, roleCode: role, code: problem.code },
      });
    }
    return problem;
  }

  /** Support's success row, in the command's transaction (as every support command's). */
  private supportAudit(client: PoolClient, context: PlatformAdminContext, action: string, facilityId: string,
    membershipId: string, reason: string, details: Record<string, unknown>): Promise<void> {
    return this.audit.recordWithClient(client, {
      correlationId: context.correlationId, actorType: context.facilityId ? 'staff' : 'platform',
      actorSubject: context.actor.subject, actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId, organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId, action, resourceType: 'staff-membership', resourceId: membershipId,
      outcome: 'success', purposeOfUse: 'healthcare-operations', reason,
      details: { facilityId, membershipId, ...details },
    });
  }
}
