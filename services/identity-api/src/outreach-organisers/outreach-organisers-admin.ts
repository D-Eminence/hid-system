import { Body, Controller, Get, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import type { QueryResultRow } from 'pg';
import { requireAdminContext } from '../admin/admin-context';
import { AuditAction, FacilityOptional, RequirePermissions } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest, PlatformAdminContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { databaseCode, decryptOutreachPhone, hasRefusal, outreachKey } from './outreach-organiser-crypto';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

export class ListOutreachOrganisersDto {
  /** active (not paused), suspended (paused), or all (the default). */
  @IsOptional() @IsIn(['active', 'suspended', 'all'])
  status?: 'active' | 'suspended' | 'all';
}

/** The row version the page read, from If-Match (the admin console's convention) or the body. */
export class OutreachAdminVersionDto {
  @IsOptional() @IsInt() @Min(1)
  version?: number;
}

export class OutreachAdminReasonDto extends OutreachAdminVersionDto {
  @Transform(trim) @IsString() @MinLength(8, { message: 'Write a short reason (at least 8 characters)' }) @MaxLength(500)
  reason!: string;
}

export class AppointCampaignAdminDto {
  @Transform(trim) @IsString() @MinLength(8, { message: 'Write a short reason (at least 8 characters)' }) @MaxLength(500)
  reason!: string;

  @IsUUID('4')
  membershipId!: string;
}

/**
 * identity.admin_list_outreach_organisers (0114). Owner decision Q38 (11 Nov
 * 2026) removed Health ID's one-time check: a group is 'active' or
 * 'suspended' (paused), and nothing else is read about its state.
 */
interface OrganiserRow extends QueryResultRow {
  organization_id: string;
  facility_id: string;
  row_version: string | number;
  display_name: string;
  kind: string;
  registration_number: string | null;
  status: string;
  origin: string;
  organiser_account_id: string;
  organiser_name: string | null;
  organiser_email: string;
  contact_phone_ciphertext: Buffer | null;
  contact_key_version: string | null;
  terms_version: string;
  created_at: Date | string;
  suspended_at: Date | string | null;
  suspension_reason: string | null;
  member_count: string | number;
  pending_invitation_count: string | number;
  campaign_count: string | number;
  active_campaign_count: string | number;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** The version from If-Match (W/"3", "3" or 3), else the body's; 428 in plain English when neither is usable. */
export function outreachAdminVersion(ifMatch: string | undefined, bodyVersion: number | undefined): number {
  const normalized = ifMatch?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const version = normalized ? Number(normalized) : bodyVersion ?? Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new DomainProblem(428, 'OUTREACH_ADMIN_VERSION_REQUIRED', 'Reload the list, then try again.');
  }
  return version;
}

/** The refusals of 0114's support commands, in plain English. */
export const OUTREACH_ADMIN_REFUSALS: Readonly<Record<string, readonly [number, string]>> = {
  OUTREACH_ORGANISER_NOT_FOUND: [404, 'That outreach group was not found.'],
  OUTREACH_ORGANISER_VERSION_CONFLICT: [409, 'Someone else changed this outreach group just now. Reload the list and try again.'],
  OUTREACH_ORGANISER_ALREADY_SUSPENDED: [409, 'This outreach group is already paused.'],
  OUTREACH_ORGANISER_SUSPEND_INVALID: [422, 'Write a short reason (at least 8 characters) for pausing this group.'],
  OUTREACH_ORGANISER_STATE_INVALID: [400, 'Choose which outreach groups to show.'],
  OUTREACH_CAMPAIGN_NOT_FOUND: [404, 'That campaign was not found at an outreach group.'],
  OUTREACH_CAMPAIGN_VERSION_CONFLICT: [409, 'Someone else changed this campaign just now. Reload and try again.'],
  OUTREACH_CAMPAIGN_RESCUE_INVALID: [422, 'Write a short reason (at least 8 characters).'],
  OUTREACH_CAMPAIGN_ADMIN_NOT_ELIGIBLE: [422, 'That person is not an active member of this outreach group.'],
  ADMIN_PERMISSION_DENIED: [403, 'You do not have permission to do this.'],
};

export function adminProblem(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  for (const [code, [status, detail]] of Object.entries(OUTREACH_ADMIN_REFUSALS)) {
    if (hasRefusal(error, code)) return new DomainProblem(status, code, detail);
  }
  const code = databaseCode(error);
  if (code === '42501') return new DomainProblem(403, 'PERMISSION_DENIED', 'You do not have permission to do this.');
  if (code === '40001') return new DomainProblem(409, 'VERSION_CONFLICT', 'Something changed while we were saving. Reload and try again.');
  return new DomainProblem(503, 'ADMIN_OUTREACH_UNAVAILABLE', 'Outreach groups could not be loaded or changed right now. Please try again.');
}

export type OutreachOrganiserStatus = 'active' | 'suspended';

/** What people see: Health ID never verifies an outreach group, so an active one is always "Unverified organiser". */
export function outreachOrganiserLabel(status: OutreachOrganiserStatus): string {
  return status === 'suspended' ? 'Paused' : 'Unverified organiser';
}

/**
 * Support's tools for outreach groups (plan PR-3): the list of groups,
 * pausing a group (which stops everything it does), and the rescue of a
 * campaign whose only admin has gone. There is no check before a group's
 * campaigns go live (owner decision Q38, 11 Nov 2026). The commands are
 * 0114's identity.admin_*; each writes its own audit row, and the list writes
 * one too, so no transaction here is read-only.
 */
@Injectable()
export class OutreachOrganisersAdminService {
  constructor(private readonly database: DatabaseService) {}

  /** The outreach groups: 'active', 'suspended' (paused) or 'all' (the default). */
  async list(context: PlatformAdminContext, status: 'active' | 'suspended' | 'all' | undefined) {
    const key = outreachKey();
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = await client.query<OrganiserRow>('select * from identity.admin_list_outreach_organisers($1)',
          [status ?? 'all']);
        return { organisers: result.rows.map((row) => {
          const rowStatus: OutreachOrganiserStatus = row.status === 'suspended' || row.suspended_at ? 'suspended' : 'active';
          return {
            organizationId: row.organization_id, facilityId: row.facility_id, version: Number(row.row_version),
            displayName: row.display_name, groupName: row.display_name, kind: row.kind,
            registrationNumber: row.registration_number, origin: row.origin,
            organiserAccountId: row.organiser_account_id, organiserName: row.organiser_name,
            organiserEmail: row.organiser_email,
            phone: key ? decryptOutreachPhone(key, row.contact_phone_ciphertext) : null,
            status: rowStatus, label: outreachOrganiserLabel(rowStatus), suspendedAt: iso(row.suspended_at),
            suspensionReason: row.suspension_reason, createdAt: iso(row.created_at), termsVersion: row.terms_version,
            members: Number(row.member_count), pendingInvitations: Number(row.pending_invitation_count),
            campaigns: Number(row.campaign_count), activeCampaigns: Number(row.active_campaign_count),
          };
        }) };
      });
    } catch (error) {
      throw adminProblem(error);
    }
  }

  async suspend(context: PlatformAdminContext, organizationId: string, version: number, reason: string) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const row = (await client.query<{ row_version: string | number; revoked_roles: number }>(
          'select * from identity.admin_suspend_outreach_organiser($1,$2,$3)', [organizationId, version, reason])).rows[0];
        if (!row) throw adminProblem(undefined);
        return { organizationId, version: Number(row.row_version), status: 'suspended' as const,
          label: outreachOrganiserLabel('suspended'), revokedRoles: Number(row.revoked_roles) };
      });
    } catch (error) {
      throw adminProblem(error);
    }
  }

  /** 'closed' or 'already_closed'. */
  async closeCampaign(context: PlatformAdminContext, campaignId: string, version: number, reason: string) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = (await client.query<{ result: string }>(
          'select identity.admin_close_outreach_campaign($1,$2,$3) as result', [campaignId, version, reason])).rows[0]?.result;
        if (result !== 'closed' && result !== 'already_closed') throw adminProblem(undefined);
        return { campaignId, status: 'closed' as const, alreadyClosed: result === 'already_closed' };
      });
    } catch (error) {
      throw adminProblem(error);
    }
  }

  /** 'appointed' or 'already_admin'. */
  async appointCampaignAdmin(context: PlatformAdminContext, campaignId: string, input: AppointCampaignAdminDto) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = (await client.query<{ result: string }>(
          'select identity.admin_appoint_outreach_campaign_admin($1,$2,$3) as result',
          [campaignId, input.membershipId, input.reason])).rows[0]?.result;
        if (result !== 'appointed' && result !== 'already_admin') throw adminProblem(undefined);
        return { campaignId, membershipId: input.membershipId, role: 'admin' as const,
          alreadyAdmin: result === 'already_admin' };
      });
    } catch (error) {
      throw adminProblem(error);
    }
  }
}

@Controller('admin/outreach-organisers')
@FacilityOptional()
export class OutreachOrganisersAdminController {
  constructor(private readonly admin: OutreachOrganisersAdminService) {}

  /** The groups: ?status=active|suspended|all (all by default). */
  @Get()
  @RequirePermissions('platform.facility.read')
  @AuditAction('admin.outreach-organisers.list')
  list(@Query() query: ListOutreachOrganisersDto, @Req() request: HidRequest) {
    return this.admin.list(requireAdminContext(request), query.status);
  }

  @Post(':organizationId/suspend')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage', 'platform.facility.unlock')
  @AuditAction('admin.outreach-organiser.suspend')
  suspend(@Param('organizationId', new ParseUUIDPipe({ version: '4' })) organizationId: string,
    @Headers('if-match') ifMatch: string | undefined, @Body() input: OutreachAdminReasonDto,
    @Req() request: HidRequest) {
    return this.admin.suspend(requireAdminContext(request), organizationId, outreachAdminVersion(ifMatch, input.version),
      input.reason);
  }
}

@Controller('admin/outreach-campaigns')
@FacilityOptional()
export class OutreachCampaignsAdminController {
  constructor(private readonly admin: OutreachOrganisersAdminService) {}

  @Post(':campaignId/close')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage', 'platform.facility.unlock')
  @AuditAction('admin.outreach-campaign.close')
  close(@Param('campaignId', new ParseUUIDPipe()) campaignId: string, @Headers('if-match') ifMatch: string | undefined,
    @Body() input: OutreachAdminReasonDto, @Req() request: HidRequest) {
    return this.admin.closeCampaign(requireAdminContext(request), campaignId, outreachAdminVersion(ifMatch, input.version),
      input.reason);
  }

  @Post(':campaignId/admins')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage', 'platform.facility.unlock')
  @AuditAction('admin.outreach-campaign.appoint-admin')
  appointAdmin(@Param('campaignId', new ParseUUIDPipe()) campaignId: string, @Body() input: AppointCampaignAdminDto,
    @Req() request: HidRequest) {
    return this.admin.appointCampaignAdmin(requireAdminContext(request), campaignId, input);
  }
}
