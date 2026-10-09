import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { CollectSpecimenDto, CreateAccessionDto, ReceiveSpecimenDto, RejectSpecimenDto } from './dto/accession.dto';
import { LabAccessionsService } from './lab-accessions.service';

@Controller('lab')
export class LabAccessionsController {
  constructor(private readonly accessions: LabAccessionsService) {}

  @Post('work-items/:workItemId/accession') @HttpCode(201)
  @RequirePermissions('lab.accession.create') @AuditAction('lab.accession.create.request')
  create(@Param('workItemId', new ParseUUIDPipe({ version: '4' })) workItemId: string,
    @Body() input: CreateAccessionDto, @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    return this.accessions.create(requireRequestContext(request), workItemId, input, requireIdempotencyKey(key));
  }

  @Get('accessions/:accessionId') @RequirePermissions('lab.accession.read')
  @AuditAction('lab.accession.read.request')
  get(@Param('accessionId', new ParseUUIDPipe({ version: '4' })) accessionId: string, @Req() request: HidRequest) {
    return this.accessions.get(requireRequestContext(request), accessionId);
  }

  @Get('accessions/:accessionId/specimens') @RequirePermissions('lab.accession.read')
  @AuditAction('lab.specimen.list.request')
  specimens(@Param('accessionId', new ParseUUIDPipe({ version: '4' })) accessionId: string, @Req() request: HidRequest) {
    return this.accessions.listSpecimens(requireRequestContext(request), accessionId);
  }

  @Post('accessions/:accessionId/specimens/:specimenId/collect')
  @RequirePermissions('lab.specimen.collect') @AuditAction('lab.specimen.collect.request')
  collect(@Param('accessionId', new ParseUUIDPipe({ version: '4' })) accessionId: string,
    @Param('specimenId', new ParseUUIDPipe({ version: '4' })) specimenId: string, @Body() input: CollectSpecimenDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    return this.accessions.collect(requireRequestContext(request), accessionId, specimenId, input, requireIdempotencyKey(key));
  }

  @Post('accessions/:accessionId/specimens/:specimenId/receive')
  @RequirePermissions('lab.specimen.receive') @AuditAction('lab.specimen.receive.request')
  receive(@Param('accessionId', new ParseUUIDPipe({ version: '4' })) accessionId: string,
    @Param('specimenId', new ParseUUIDPipe({ version: '4' })) specimenId: string, @Body() input: ReceiveSpecimenDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    return this.accessions.receive(requireRequestContext(request), accessionId, specimenId, input, requireIdempotencyKey(key));
  }

  @Post('accessions/:accessionId/specimens/:specimenId/reject')
  @RequirePermissions('lab.specimen.reject') @AuditAction('lab.specimen.reject.request')
  reject(@Param('accessionId', new ParseUUIDPipe({ version: '4' })) accessionId: string,
    @Param('specimenId', new ParseUUIDPipe({ version: '4' })) specimenId: string, @Body() input: RejectSpecimenDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    return this.accessions.reject(requireRequestContext(request), accessionId, specimenId, input, requireIdempotencyKey(key));
  }
}
