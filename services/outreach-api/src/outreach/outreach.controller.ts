import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { CreateRegistrationCaseDto } from './dto/create-registration-case.dto';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignStatusDto } from './dto/update-campaign-status.dto';
import { AddCampaignMemberDto } from './dto/add-campaign-member.dto';
import { LinkExistingPatientDto } from './dto/link-existing-patient.dto';
import { ExportRegistrationsDto } from './dto/export-registrations.dto';
import { ListRegistrationCasesQueryDto } from './dto/list-registration-cases.dto';
import { SaveRegistrationScreeningDto } from './dto/registration-screening.dto';
import { ConfirmHealthIdDto, requireEmptyHealthIdBody, StartHealthIdDto } from './dto/health-id.dto';
import { OutreachService } from './outreach.service';

/**
 * The version an If-Match header names ("3", W/"3" or 3); undefined when the
 * header is absent; 428 IF_MATCH_REQUIRED when it is present but names no
 * positive version.
 */
export function ifMatchVersion(header: string | undefined): number | undefined {
  if (header === undefined || header.trim() === '') return undefined;
  const raw = header.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const version = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'If-Match must contain the expected positive version');
  }
  return version;
}

@Controller('outreach/registration-cases')
export class OutreachController {
  constructor(private readonly outreach: OutreachService) {}


  /**
   * How campaigns are governed here (0111, ADR-045 option B): a campaign's own admins open, close and staff it. A
   * website asks this to learn that campaign management is served; a backend before 0111 answers 404. At an
   * outreach group's facility it also gives the group's status (organiserStatus: 'unverified', or 'suspended' when
   * Health ID has paused it). Health ID does not check a group before its campaigns go Active (owner decision Q38).
   */
  @Get('/campaigns/governance')
  @RequirePermissions('outreach.campaign.read')
  campaignGovernance(@Req() request: HidRequest) {
    return this.outreach.campaignGovernance(requireRequestContext(request));
  }

  @Get('/campaigns')
  @RequirePermissions('outreach.campaign.read')
  listCampaigns(@Req() request: HidRequest) {
    return this.outreach.listCampaigns(requireRequestContext(request));
  }

  @Post('/campaigns')
  @HttpCode(201)
  @RequirePermissions('outreach.campaign.write')
  createCampaign(@Body() input: CreateCampaignDto, @Req() request: HidRequest) {
    return this.outreach.createCampaign(input, requireRequestContext(request));
  }

  @Post('/campaigns/:campaignId/status')
  @HttpCode(200)
  @RequirePermissions('outreach.campaign.write')
  updateCampaignStatus(@Param('campaignId', new ParseUUIDPipe()) campaignId: string,
    @Body() input: UpdateCampaignStatusDto, @Req() request: HidRequest) {
    const expectedVersion = ifMatchVersion(request.header('if-match'));
    if (expectedVersion === undefined) {
      throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'If-Match must contain the expected positive version');
    }
    return this.outreach.updateCampaignStatus(campaignId, input, expectedVersion, requireRequestContext(request));
  }

  @Get('/campaigns/:campaignId/members')
  @RequirePermissions('outreach.campaign.read')
  listCampaignMembers(@Param('campaignId', new ParseUUIDPipe()) campaignId: string, @Req() request: HidRequest) {
    return this.outreach.listCampaignMembers(campaignId, requireRequestContext(request));
  }

  @Get('/campaigns/:campaignId/staff')
  @RequirePermissions('outreach.campaign.read')
  listCampaignStaff(@Param('campaignId', new ParseUUIDPipe()) campaignId: string, @Req() request: HidRequest) {
    return this.outreach.listCampaignStaff(campaignId, requireRequestContext(request));
  }

  @Post('/campaigns/:campaignId/members')
  @HttpCode(201)
  @RequirePermissions('outreach.campaign.write')
  addCampaignMember(@Param('campaignId', new ParseUUIDPipe()) campaignId: string,
    @Body() input: AddCampaignMemberDto, @Req() request: HidRequest) {
    return this.outreach.addCampaignMember(campaignId, input, requireRequestContext(request));
  }

  /**
   * The website exports the registration list (CSV, PDF, Word or Excel) from
   * the existing reads; this records that it did, with the format and the
   * count only.
   */
  @Post('/exports')
  @HttpCode(204)
  @RequirePermissions('outreach.registration.read')
  async recordExport(@Body() input: ExportRegistrationsDto, @Req() request: HidRequest): Promise<void> {
    await this.outreach.recordExport(input, requireRequestContext(request));
  }

  @Get()
  @RequirePermissions('outreach.registration.read')
  async list(@Query() query: ListRegistrationCasesQueryDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    const page = await this.outreach.list(requireRequestContext(request),
      { campaignId: query.campaignId, limit: query.limit, before: query.before });
    if (page.nextCursor) response.setHeader('X-Next-Cursor', page.nextCursor);
    return [...page];
  }

  @Get(':caseId')
  @RequirePermissions('outreach.registration.read')
  get(@Param('caseId', new ParseUUIDPipe()) caseId: string, @Req() request: HidRequest) {
    return this.outreach.get(caseId, requireRequestContext(request));
  }

  /**
   * A registration's screening (0118): { screening: null } or { screening } with
   * ETag "<version>", and since 0122 accepts: the optional fields beyond 0118's
   * that this database takes (['genotype', 'bloodGroup'] once 0122 is applied,
   * [] before), so the website sends them only to a service that takes them
   * (an older one refuses an unknown field with 400).
   */
  @Get(':caseId/screening')
  @RequirePermissions('outreach.registration.read')
  async getScreening(@Param('caseId', new ParseUUIDPipe()) caseId: string, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    const { screening, accepts } = await this.outreach.readScreening(caseId, requireRequestContext(request));
    if (screening) response.setHeader('ETag', `"${screening.version}"`);
    return { screening, accepts };
  }

  /**
   * Saves a registration's whole screening (0118). Idempotency-Key required;
   * If-Match "<version>" omitted for the first save (201), required after it
   * (200). Answers { screening, accepts } with ETag "<version>".
   */
  @Put(':caseId/screening')
  @RequirePermissions('outreach.registration.write')
  async saveScreening(@Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Body() input: SaveRegistrationScreeningDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    const idempotencyKey = requireIdempotencyKey(request.header('idempotency-key'));
    const expectedVersion = ifMatchVersion(request.header('if-match'));
    const result = await this.outreach.saveScreening(caseId, input, expectedVersion, idempotencyKey,
      requireRequestContext(request));
    response.status(result.status);
    response.setHeader('ETag', `"${result.screening.version}"`);
    return { screening: result.screening, accepts: result.accepts };
  }

  /*
   * Assisted Health ID (0119), email path: start sends the person a 6-digit
   * code (202), confirm checks it and creates the Health ID (201). Each takes
   * an Idempotency-Key. Identity does the work in the volunteer's own session.
   * The no-contact path (0120), create-unverified, sits beside them under the
   * same permission.
   */
  @Post(':caseId/health-id/start')
  @HttpCode(202)
  @RequirePermissions('outreach.registration.write')
  startHealthId(@Param('caseId', new ParseUUIDPipe()) caseId: string, @Body() input: StartHealthIdDto,
    @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(request.header('idempotency-key'));
    return this.outreach.startHealthId(caseId, input, idempotencyKey, requireRequestContext(request));
  }

  @Post(':caseId/health-id/confirm')
  @HttpCode(201)
  @RequirePermissions('outreach.registration.write')
  confirmHealthId(@Param('caseId', new ParseUUIDPipe()) caseId: string, @Body() input: ConfirmHealthIdDto,
    @Req() request: HidRequest) {
    requireIdempotencyKey(request.header('idempotency-key'));
    return this.outreach.confirmHealthId(caseId, input, requireRequestContext(request));
  }

  /**
   * No contact at all (0120): the person's Health ID with no account and a
   * one-time claim code (201 { healthId, claimCode, claimExpiresAt,
   * registration }). Body {}. The claim code is answered once: a retry, with
   * the same Idempotency-Key or not, answers 409 OUTREACH_HEALTH_ID_ALREADY_CREATED
   * with healthId only.
   */
  @Post(':caseId/health-id/create-unverified')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('outreach.registration.write')
  createUnverifiedHealthId(@Param('caseId', new ParseUUIDPipe()) caseId: string, @Body() body: unknown,
    @Req() request: HidRequest) {
    requireIdempotencyKey(request.header('idempotency-key'));
    requireEmptyHealthIdBody(body);
    return this.outreach.createUnverifiedHealthId(caseId, requireRequestContext(request));
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('outreach.registration.write')
  create(@Body() input: CreateRegistrationCaseDto, @Req() request: HidRequest) {
    return this.outreach.create(input, requireIdempotencyKey(request.header('idempotency-key')),
      requireRequestContext(request));
  }

  @Post(':caseId/link-existing')
  @HttpCode(200)
  @RequirePermissions('outreach.registration.write')
  linkExisting(@Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Body() input: LinkExistingPatientDto, @Req() request: HidRequest) {
    return this.outreach.linkExisting(caseId, input,
      requireIdempotencyKey(request.header('idempotency-key')), requireRequestContext(request));
  }
}
