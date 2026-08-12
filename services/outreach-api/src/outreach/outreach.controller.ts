import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { CreateRegistrationCaseDto } from './dto/create-registration-case.dto';
import { LinkExistingPatientDto } from './dto/link-existing-patient.dto';
import { OutreachService } from './outreach.service';

@Controller('outreach/registration-cases')
export class OutreachController {
  constructor(private readonly outreach: OutreachService) {}

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
