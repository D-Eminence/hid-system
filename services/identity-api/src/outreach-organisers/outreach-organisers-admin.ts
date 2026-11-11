import { Body, Controller, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { QueryResultRow } from 'pg';
import { requireAdminContext } from '../admin/admin-context';
import { AuditAction, FacilityOptional, RequirePermissions } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest, PlatformAdminContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { databaseCode, decryptOutreachPhone, hasRefusal, outreachKey } from './outreach-organiser-crypto';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

/** The default note of a one-click review, so the queue needs no typing. */
export const ONE_CLICK_REVIEW_REASON = 'Checked by Health ID support';

export class ListOutreachOrganisersDto {
  @IsOptional() @IsIn(['pending', 'reviewed', 'suspended'])
  reviewState?: 'pending' | 'reviewed' | 'suspended';
}

export class ReviewOutreachOrganiserDto {
  /** Support may correct the group's shown name at review. */
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120)
  @Matches(/^[\p{L}\p{M}0-9][\p{L}\p{M}0-9 .,'&()/-]*$/u, { message: 'Use letters, numbers and simple punctuation in the name' })
  displayName?: string;

  @IsOptional() @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason?: string;
}

export class OutreachAdminReasonDto {
  @Transform(trim) @IsString() @MinLength(8, { message: 'Write a short reason (at least 8 characters)' }) @MaxLength(500)
  reason!: string;
}

export class AppointCampaignAdminDto extends OutreachAdminReasonDto {
  @IsUUID('4')
  membershipId!: string;
}

interface OrganiserRow extends QueryResultRow {
  organization_id: string;
  facility_id: string;
  display_name: string;
  group_name: string;
  kind: string;
  registration_number: string | null;
  organiser_name: string;
  organiser_email: string;
  phone_ciphertext: Buffer | null;
  review_state: string;
  reviewed_at: Date | string | null;
  suspended_at: Date | string | null;
  created_at: Date | string;
  terms_version: string;
  campaign_count: string | number;
  member_count: string | number;
  registration_count: string | number;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function adminProblem(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  if (hasRefusal(error, 'OUTREACH_ORGANISATION_NOT_FOUND')) {
    return new DomainProblem(404, 'OUTREACH_ORGANISATION_NOT_FOUND', 'That outreach group was not found.');
  }
  if (hasRefusal(error, 'OUTREACH_ORGANISATION_SUSPENDED')) {
    return new DomainProblem(409, 'OUTREACH_ORGANISATION_SUSPENDED', 'That outreach group is paused. It cannot be checked while paused.');
  }
  if (hasRefusal(error, 'OUTREACH_CAMPAIGN_NOT_FOUND')) {
    return new DomainProblem(404, 'OUTREACH_CAMPAIGN_NOT_FOUND', 'That campaign was not found.');
  }
  if (hasRefusal(error, 'OUTREACH_CAMPAIGN_CLOSED')) {
    return new DomainProblem(409, 'OUTREACH_CAMPAIGN_CLOSED', 'That campaign is already closed.');
  }
  if (hasRefusal(error, 'OUTREACH_STAFF_NOT_AVAILABLE')) {
    return new DomainProblem(422, 'OUTREACH_STAFF_NOT_AVAILABLE', 'That person is not an active member of this outreach group.');
  }
  const code = databaseCode(error);
  if (code === '42501') return new DomainProblem(403, 'PERMISSION_DENIED', 'You do not have permission to do this.');
  if (code === '40001') return new DomainProblem(409, 'VERSION_CONFLICT', 'Something changed while we were saving. Reload and try again.');
  return new DomainProblem(503, 'ADMIN_OUTREACH_UNAVAILABLE', 'Outreach groups could not be loaded or changed right now. Please try again.');
}

/**
 * Support's tools for outreach groups (plan PR-3): the "Outreach organisers to
 * check" queue, the one-time check that lets a group's first campaign go live,
 * pausing a group, and the rescue of a campaign whose only admin has gone.
 * Every command is audited by the database; the HTTP row is the interceptor's.
 */
@Injectable()
export class OutreachOrganisersAdminService {
  constructor(private readonly database: DatabaseService) {}

  async list(context: PlatformAdminContext, reviewState: string | undefined) {
    const key = outreachKey();
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = await client.query<OrganiserRow>('select * from identity.admin_list_outreach_organisers($1)',
          [reviewState ?? null]);
        return { organisers: result.rows.map((row) => ({
          organizationId: row.organization_id, facilityId: row.facility_id, displayName: row.display_name,
          groupName: row.group_name, kind: row.kind, registrationNumber: row.registration_number,
          organiserName: row.organiser_name, organiserEmail: row.organiser_email,
          phone: key ? decryptOutreachPhone(key, row.phone_ciphertext) : null,
          reviewState: row.review_state, label: row.review_state === 'reviewed' ? 'Checked by Health ID'
            : row.review_state === 'suspended' ? 'Paused' : 'Unverified organiser',
          reviewedAt: iso(row.reviewed_at), suspendedAt: iso(row.suspended_at), createdAt: iso(row.created_at),
          termsVersion: row.terms_version, campaigns: Number(row.campaign_count), members: Number(row.member_count),
          registrations: Number(row.registration_count),
        })) };
      }, { readOnly: true });
    } catch (error) {
      throw adminProblem(error);
    }
  }

  async review(context: PlatformAdminContext, organizationId: string, input: ReviewOutreachOrganiserDto) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const row = (await client.query<{ organization_id: string; review_state: string; display_name: string;
          reviewed_at: Date | string }>('select * from identity.admin_review_outreach_organiser($1,$2,$3)',
        [organizationId, input.displayName ?? null, input.reason ?? ONE_CLICK_REVIEW_REASON])).rows[0];
        if (!row) throw adminProblem(undefined);
        return { organizationId: row.organization_id, reviewState: row.review_state, displayName: row.display_name,
          reviewedAt: iso(row.reviewed_at) };
      });
    } catch (error) {
      throw adminProblem(error);
    }
  }

  async suspend(context: PlatformAdminContext, organizationId: string, reason: string) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const row = (await client.query<{ organization_id: string; review_state: string; suspended_at: Date | string }>(
          'select * from identity.admin_suspend_outreach_organiser($1,$2)', [organizationId, reason])).rows[0];
        if (!row) throw adminProblem(undefined);
        return { organizationId: row.organization_id, reviewState: row.review_state, suspendedAt: iso(row.suspended_at) };
      });
    } catch (error) {
      throw adminProblem(error);
    }
  }

  async closeCampaign(context: PlatformAdminContext, campaignId: string, reason: string) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const row = (await client.query<{ campaign_id: string; status: string; row_version: string | number }>(
          'select * from outreach.admin_close_campaign($1,$2)', [campaignId, reason])).rows[0];
        if (!row) throw adminProblem(undefined);
        return { campaignId: row.campaign_id, status: row.status, version: Number(row.row_version) };
      });
    } catch (error) {
      throw adminProblem(error);
    }
  }

  async appointCampaignAdmin(context: PlatformAdminContext, campaignId: string, input: AppointCampaignAdminDto) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const row = (await client.query<{ campaign_id: string; membership_id: string; role: string }>(
          'select * from outreach.admin_appoint_campaign_admin($1,$2,$3)',
          [campaignId, input.membershipId, input.reason])).rows[0];
        if (!row) throw adminProblem(undefined);
        return { campaignId: row.campaign_id, membershipId: row.membership_id, role: row.role };
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

  /** The queue: ?reviewState=pending lists the groups waiting for their one-time check. */
  @Get()
  @RequirePermissions('platform.facility.read')
  @AuditAction('admin.outreach-organisers.list')
  list(@Query() query: ListOutreachOrganisersDto, @Req() request: HidRequest) {
    return this.admin.list(requireAdminContext(request), query.reviewState);
  }

  /** One click: an empty body marks the group checked, so its campaigns can go live. */
  @Post(':organizationId/review')
  @HttpCode(200)
  @RequirePermissions('platform.facility.unlock')
  @AuditAction('admin.outreach-organiser.review')
  review(@Param('organizationId', new ParseUUIDPipe({ version: '4' })) organizationId: string,
    @Body() input: ReviewOutreachOrganiserDto, @Req() request: HidRequest) {
    return this.admin.review(requireAdminContext(request), organizationId, input);
  }

  @Post(':organizationId/suspend')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.outreach-organiser.suspend')
  suspend(@Param('organizationId', new ParseUUIDPipe({ version: '4' })) organizationId: string,
    @Body() input: OutreachAdminReasonDto, @Req() request: HidRequest) {
    return this.admin.suspend(requireAdminContext(request), organizationId, input.reason);
  }
}

@Controller('admin/outreach-campaigns')
@FacilityOptional()
export class OutreachCampaignsAdminController {
  constructor(private readonly admin: OutreachOrganisersAdminService) {}

  @Post(':campaignId/close')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.outreach-campaign.close')
  close(@Param('campaignId', new ParseUUIDPipe()) campaignId: string, @Body() input: OutreachAdminReasonDto,
    @Req() request: HidRequest) {
    return this.admin.closeCampaign(requireAdminContext(request), campaignId, input.reason);
  }

  @Post(':campaignId/admins')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.outreach-campaign.appoint-admin')
  appointAdmin(@Param('campaignId', new ParseUUIDPipe()) campaignId: string, @Body() input: AppointCampaignAdminDto,
    @Req() request: HidRequest) {
    return this.admin.appointCampaignAdmin(requireAdminContext(request), campaignId, input);
  }
}
