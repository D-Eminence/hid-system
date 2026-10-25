import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { requireNoRecentRecoveryHold } from '../auth/recent-authentication';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest, PlatformAdminContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { ChangeFacilityStaffRoleDto, EndFacilityStaffDto } from './dto/staff-invitation.dto';
import { staffCommandProblem, unavailableFor } from './staff-invitation-problems';
import { STAFF_ATTESTATION_VERSION, StaffInvitationsService } from './staff-invitations.service';
import { normalizeLicenceNumber, staffRoleLicenceBody } from './staff-licence';
import { StaffReauthenticationService } from './staff-reauthentication.service';

type Timestamp = Date | string | null;
type Count = string | number | null;

interface StateRow extends QueryResultRow {
  facility_id: string;
  facility_name: string;
  organization_type: string;
  product_code: string;
  review_state: string;
  on_probation: boolean;
  probation_ends_at: Timestamp;
  invitations_open: boolean;
  pending_count: Count;
  invitations_last_day: Count;
  emails_last_day: Count;
  delivery_paused: boolean;
  invitable_roles: string[] | null;
  attestation_version: string | null;
  attestation_text: string | null;
  administrator_licence_body: string | null;
  administrator_licence_hint: string | null;
  administrator_licence_recorded_at: Timestamp;
  reviewable_licence_bodies: string[] | null;
  pending_limit: Count;
  invitations_per_day: Count;
  emails_per_day: Count;
}

interface MemberRow extends QueryResultRow {
  membership_id: string;
  row_version: Count;
  account_id: string;
  display_name: string;
  email: string;
  roles: string[] | null;
  is_administrator: boolean;
  is_self: boolean;
  joined_at: Timestamp;
  licence_body: string | null;
  licence_number_hint: string | null;
  vouched_by_name: string | null;
  vouched_at: Timestamp;
  verification_method: string | null;
}

interface InvitationRow extends QueryResultRow {
  invitation_id: string;
  row_version: Count;
  reference: string;
  invitee_name: string;
  invitee_email: string;
  role_code: string;
  licence_body: string | null;
  licence_number_hint: string | null;
  status: string;
  invited_by_name: string | null;
  created_at: Timestamp;
  last_sent_at: Timestamp;
  expires_at: Timestamp;
  send_count: Count;
  delivery_outcome: string;
  resend_available_at: Timestamp;
}

interface AdministratorLicenceRow extends QueryResultRow {
  licence_body: string;
  number_hint: string;
  recorded_at: Timestamp;
}

interface EndRow extends QueryResultRow {
  row_version: Count;
  ended_at: Timestamp;
  roles_revoked: Count;
  grants_revoked: Count;
  requests_expired: Count;
}

interface RoleRow extends QueryResultRow {
  row_version: Count;
  role_code: string;
}

interface AdminFacilityRow extends QueryResultRow {
  id: string;
  name: string;
  review_state: string | null;
  organization_type: string | null;
  product_code: string | null;
}

interface AdminStaffRow extends QueryResultRow {
  kind: string;
  membership_id: string | null;
  invitation_id: string | null;
  reference: string | null;
  account_id: string | null;
  name: string | null;
  email: string | null;
  roles: string[] | null;
  status: string | null;
  licence_body: string | null;
  licence_number: string | null;
  licence_key: string | null;
  same_licence_elsewhere: Count;
  name_mismatch: boolean | null;
  attested_by_account_id: string | null;
  attested_by_name: string | null;
  verification_method: string | null;
  attested_at: Timestamp;
  created_at: Timestamp;
}

interface FoundInvitationRow extends QueryResultRow {
  invitation_id: string;
  reference: string;
  facility_id: string;
  facility_name: string;
  organization_id: string;
  status: string;
  role_code: string;
  created_at: Timestamp;
  expires_at: Timestamp;
}

function iso(value: Timestamp | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function count(value: Count | undefined): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

/**
 * A facility's own staff (P4b, SPEC 4.5): the Staff page's read, the pending
 * administrator's own licence (SPEC 3.4), removing a member and changing a
 * member's role; and support's reads of a facility's staff and licences and of
 * an invitation by its reference (SPEC 6.3 admin routes). Invitations
 * themselves are StaffInvitationsService's.
 */
@Injectable()
export class FacilityStaffService {
  constructor(
    private readonly database: DatabaseService,
    private readonly invitations: StaffInvitationsService,
    private readonly reauthentication: StaffReauthenticationService,
  ) {}

  /**
   * The Staff page (SPEC 6.3): the facility's state, limits and invite
   * options, its members and its invitations, in one read-only transaction.
   * Allowed while pending (the administrator alone, the own-licence card).
   */
  async list(context: DataAccessContext) {
    this.invitations.requireSelfService(context.actor.facility, 'any');
    let state: StateRow | undefined;
    let members: MemberRow[];
    let invitations: InvitationRow[];
    try {
      ({ state, members, invitations } = await this.database.withTransaction(context, async (client) => ({
        state: (await client.query<StateRow>('select * from identity.facility_staff_management_state()')).rows[0],
        members: (await client.query<MemberRow>('select * from identity.list_facility_staff()')).rows,
        invitations: (await client.query<InvitationRow>('select * from identity.list_facility_staff_invitations()')).rows,
      }), { readOnly: true }));
    } catch (error) {
      throw staffCommandProblem(error, 'staff');
    }
    if (!state) throw unavailableFor('staff');
    const reviewed = state.review_state === 'reviewed';
    const limits = {
      pendingInvitations: count(state.pending_count), pendingLimit: count(state.pending_limit),
      invitationsToday: count(state.invitations_last_day), invitationsPerDay: count(state.invitations_per_day),
      emailsToday: count(state.emails_last_day), emailsPerDay: count(state.emails_per_day),
    };
    return {
      facility: {
        id: state.facility_id,
        name: state.facility_name,
        organizationType: state.organization_type,
        reviewState: state.review_state,
        firstThirtyDaysEndAt: iso(state.probation_ends_at),
        invitationsOpen: state.invitations_open === true,
        deliveryPaused: state.delivery_paused === true,
      },
      canInvite: reviewed && state.invitations_open === true && state.delivery_paused !== true
        && limits.pendingInvitations < limits.pendingLimit && limits.invitationsToday < limits.invitationsPerDay
        && limits.emailsToday < limits.emailsPerDay,
      limits,
      inviteOptions: {
        roles: (state.invitable_roles ?? []).map((code) => ({ code, licenceBody: staffRoleLicenceBody(code) })),
        attestation: state.attestation_version
          ? { version: state.attestation_version, text: state.attestation_text } : null,
      },
      administratorLicence: state.administrator_licence_body
        ? { body: state.administrator_licence_body, numberHint: state.administrator_licence_hint,
          recordedAt: iso(state.administrator_licence_recorded_at) } : null,
      administratorLicenceBodies: state.reviewable_licence_bodies ?? [],
      members: members.map((row) => ({
        membershipId: row.membership_id,
        version: count(row.row_version),
        accountId: row.account_id,
        name: row.display_name,
        email: row.email,
        roles: row.roles ?? [],
        isAdministrator: row.is_administrator === true,
        isSelf: row.is_self === true,
        joinedAt: iso(row.joined_at),
        licence: row.licence_body ? { body: row.licence_body, numberHint: row.licence_number_hint,
          vouchedBy: row.vouched_by_name, vouchedAt: iso(row.vouched_at), method: row.verification_method } : null,
      })),
      invitations: invitations.map((row) => ({
        invitationId: row.invitation_id,
        version: count(row.row_version),
        reference: row.reference,
        name: row.invitee_name,
        email: row.invitee_email,
        roleCode: row.role_code,
        licence: row.licence_body ? { body: row.licence_body, numberHint: row.licence_number_hint } : null,
        status: row.status,
        invitedBy: row.invited_by_name,
        createdAt: iso(row.created_at),
        lastSentAt: iso(row.last_sent_at),
        expiresAt: iso(row.expires_at),
        sendCount: count(row.send_count),
        deliveryOutcome: row.delivery_outcome,
        resendAvailableAt: iso(row.resend_available_at),
      })),
    };
  }

  /**
   * The pending administrator's own licence (SPEC 3.4), which support checks
   * at review: allowed only before review (409 FACILITY_ALREADY_REVIEWED
   * after) and replaceable until then. Not gated by the invitations control.
   */
  async recordAdministratorLicence(context: DataAccessContext, licenceBody: string, licenceNumber: string) {
    this.invitations.requireSelfService(context.actor.facility, 'pending');
    let row: AdministratorLicenceRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<AdministratorLicenceRow>(
        'select * from identity.record_self_service_administrator_licence($1,$2)',
        [licenceBody, normalizeLicenceNumber(licenceNumber)])).rows[0]);
    } catch (error) {
      throw staffCommandProblem(error, 'staff');
    }
    if (!row) throw unavailableFor('staff');
    return { licenceBody: row.licence_body, numberHint: row.number_hint, recordedAt: iso(row.recorded_at) };
  }

  /**
   * Remove a member (SPEC 4.5), after the password: their facility roles and
   * the consents patients gave them here end at once; sessions are not
   * revoked (authorization stops at their next request). Not gated, and not
   * held after a recovery (S11.2): an administrator who has just recovered
   * their mailbox must be able to remove whoever took it.
   */
  async end(context: DataAccessContext, request: HidRequest, membershipId: string, input: EndFacilityStaffDto) {
    this.invitations.requireSelfService(context.actor.facility, 'reviewed');
    await this.reauthentication.confirm(context.actor, input.currentPassword, request);
    let row: EndRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<EndRow>(
        'select * from identity.end_facility_staff_membership($1,$2,$3)',
        [membershipId, input.expectedVersion, input.reason])).rows[0]);
    } catch (error) {
      throw staffCommandProblem(error, 'membership');
    }
    if (!row) throw unavailableFor('staff');
    return { version: count(row.row_version), endedAt: iso(row.ended_at), grantsRevoked: count(row.grants_revoked) };
  }

  /**
   * Change a member's role (SPEC 4.5): gated, after the password, with the
   * recovery hold in the command's transaction. The same role with another
   * licence records a new attestation only.
   */
  async changeRole(context: DataAccessContext, request: HidRequest, membershipId: string,
    input: ChangeFacilityStaffRoleDto) {
    this.invitations.requireSelfService(context.actor.facility, 'reviewed');
    await this.invitations.assertOpen('staff');
    await this.reauthentication.confirm(context.actor, input.currentPassword, request);
    const licenceNumber = typeof input.licenceNumber === 'string' ? normalizeLicenceNumber(input.licenceNumber) : null;
    let row: RoleRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => {
        await requireNoRecentRecoveryHold(client, context.actor.accountId, 'staff invitations and role changes',
          'STAFF_RECENT_RECOVERY_HOLD');
        return (await client.query<RoleRow>(
          'select * from identity.change_facility_staff_role($1,$2,$3,$4,$5,$6,$7)',
          [membershipId, input.expectedVersion, input.role, input.licenceBody ?? null, licenceNumber,
            STAFF_ATTESTATION_VERSION, input.reason])).rows[0];
      });
    } catch (error) {
      throw staffCommandProblem(error, 'membership');
    }
    if (!row) throw unavailableFor('staff');
    return { version: count(row.row_version), roleCode: row.role_code };
  }

  /**
   * Support's view of a facility's staff and licences (SPEC 6.3): every
   * membership, active or ended, and every invitation, with full licence
   * numbers, the licence key, how many other accounts hold the same licence,
   * and whether the attested person's name differs from the account's. A
   * read-only platform transaction; the interceptor audits it.
   */
  async adminStaff(context: PlatformAdminContext, facilityId: string) {
    let facility: AdminFacilityRow | undefined;
    let rows: AdminStaffRow[];
    try {
      ({ facility, rows } = await this.database.withPlatformTransaction(context, async (client) => {
        const header = await client.query<AdminFacilityRow>(
          `select facility.id::text as id, facility.name, state.review_state, state.organization_type, state.product_code
             from identity.facilities facility
             left join lateral identity.organization_self_service_state(facility.organization_id) state on true
            where facility.id = $1`, [facilityId]);
        if (!header.rows[0]) return { facility: undefined, rows: [] };
        return { facility: header.rows[0],
          rows: (await client.query<AdminStaffRow>('select * from identity.admin_list_facility_staff($1)', [facilityId])).rows };
      }, { readOnly: true }));
    } catch (error) {
      throw this.adminProblem(error);
    }
    if (!facility) throw new DomainProblem(404, 'ADMIN_FACILITY_NOT_FOUND', 'Facility was not found');
    const item = (row: AdminStaffRow) => ({
      ...(row.kind === 'invitation'
        ? { invitationId: row.invitation_id, reference: row.reference }
        : { membershipId: row.membership_id }),
      accountId: row.account_id,
      name: row.name,
      email: row.email,
      roles: row.roles ?? [],
      status: row.status,
      licenceBody: row.licence_body,
      licenceNumber: row.licence_number,
      licenceKey: row.licence_key,
      sameLicenceElsewhere: count(row.same_licence_elsewhere),
      nameMismatch: row.name_mismatch === true,
      attestedByAccountId: row.attested_by_account_id,
      attestedByName: row.attested_by_name,
      verificationMethod: row.verification_method,
      attestedAt: iso(row.attested_at),
      createdAt: iso(row.created_at),
    });
    return {
      facility: {
        id: facility.id,
        name: facility.name,
        selfService: facility.review_state
          ? { review: facility.review_state, organizationType: facility.organization_type,
            productCode: facility.product_code } : null,
      },
      members: rows.filter((row) => row.kind !== 'invitation').map(item),
      invitations: rows.filter((row) => row.kind === 'invitation').map(item),
    };
  }

  /** Support finds an invitation by the reference its email quotes (S10.4), at most 5. */
  async adminFindInvitations(context: PlatformAdminContext, reference: string) {
    let rows: FoundInvitationRow[];
    try {
      rows = await this.database.withPlatformTransaction(context, async (client) => (await client.query<FoundInvitationRow>(
        'select * from identity.admin_find_staff_invitations($1)', [reference.toUpperCase()])).rows, { readOnly: true });
    } catch (error) {
      throw this.adminProblem(error);
    }
    return { items: rows.map((row) => ({
      invitationId: row.invitation_id, reference: row.reference, facilityId: row.facility_id,
      facilityName: row.facility_name, organizationId: row.organization_id, status: row.status,
      roleCode: row.role_code, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
    })) };
  }

  private adminProblem(error: unknown): DomainProblem {
    if (error instanceof DomainProblem) return error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === '42501') return new DomainProblem(403, 'PERMISSION_DENIED', 'Platform administration authority is required');
    if (code === 'P0002') return new DomainProblem(404, 'ADMIN_FACILITY_NOT_FOUND', 'Facility was not found');
    if (code === '22023') return new DomainProblem(400, 'STAFF_INVITATION_REFERENCE_INVALID', 'Enter the 8-character invitation reference');
    return new DomainProblem(503, 'STAFF_MANAGEMENT_UNAVAILABLE', 'Staff management is temporarily unavailable');
  }
}
