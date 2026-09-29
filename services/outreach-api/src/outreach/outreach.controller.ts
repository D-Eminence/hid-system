import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { CreateRegistrationCaseDto } from './dto/create-registration-case.dto';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignStatusDto } from './dto/update-campaign-status.dto';
import { AddCampaignMemberDto } from './dto/add-campaign-member.dto';
import { LinkExistingPatientDto } from './dto/link-existing-patient.dto';
import { OutreachService } from './outreach.service';

@Controller('outreach/registration-cases')
export class OutreachController {
  constructor(private readonly outreach: OutreachService) {}


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
    const raw = request.header('if-match')?.replace(/^W\//, '').replace(/^"|"$/g, '');
    const expectedVersion = Number(raw);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'If-Match must contain the expected positive version');
    }
    return this.outreach.updateCampaignStatus(campaignId, input, expectedVersion, requireRequestContext(request));
  }

  @Get('/campaigns/:campaignId/members')
  @RequirePermissions('outreach.campaign.read')
  listCampaignMembers(@Param('campaignId', new ParseUUIDPipe()) campaignId: string, @Req() request: HidRequest) {
    return this.outreach.listCampaignMembers(campaignId, requireRequestContext(request));
  }

  @Post('/campaigns/:campaignId/members')
  @HttpCode(201)
  @RequirePermissions('outreach.campaign.write')
  addCampaignMember(@Param('campaignId', new ParseUUIDPipe()) campaignId: string,
    @Body() input: AddCampaignMemberDto, @Req() request: HidRequest) {
    return this.outreach.addCampaignMember(campaignId, input, requireRequestContext(request));
  }

  @Get()
  @RequirePermissions('outreach.registration.read')
  list(@Req() request: HidRequest) { return this.outreach.list(requireRequestContext(request)); }

  @Get(':caseId')
  @RequirePermissions('outreach.registration.read')
  get(@Param('caseId', new ParseUUIDPipe()) caseId: string, @Req() request: HidRequest) {
    return this.outreach.get(caseId, requireRequestContext(request));
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
