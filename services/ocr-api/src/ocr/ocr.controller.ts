import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { CreateOcrJobDto } from './dto/create-ocr-job.dto';
import { ConfirmOcrPatientDto } from './dto/confirm-ocr-patient.dto';
import { CreateOcrPublicationDto } from './dto/create-ocr-publication.dto';
import { RetryOcrJobDto } from './dto/retry-ocr-job.dto';
import { ValidateOcrJobDto } from './dto/validate-ocr-job.dto';
import { OcrService } from './ocr.service';
import { FindOcrJobDto } from './dto/find-ocr-job.dto';

@Controller('ocr/jobs')
export class OcrController {
  constructor(private readonly ocr: OcrService) {}

  @Post()
  @RequirePermissions('ocr.job.write')
  @AuditAction('ocr.job.create.request')
  create(@Body() input: CreateOcrJobDto, @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    return this.ocr.createJob(input, key, requireRequestContext(request, input.purpose));
  }

  @Get(':jobId')
  @RequirePermissions('ocr.job.read')
  @AuditAction('ocr.job.read.request')
  get(@Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string, @Req() request: HidRequest) {
    return this.ocr.getJob(jobId, requireRequestContext(request));
  }

  @Get()
  @RequirePermissions('ocr.job.read')
  @AuditAction('ocr.job.find.request')
  find(@Query() query: FindOcrJobDto, @Req() request: HidRequest) {
    return this.ocr.findForDocument(query.documentId, requireRequestContext(request));
  }

  @Post(':jobId/retry')
  @RequirePermissions('ocr.job.write')
  @AuditAction('ocr.job.retry.request')
  retry(@Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string, @Body() input: RetryOcrJobDto, @Req() request: HidRequest) {
    return this.ocr.retry(jobId, input, requireRequestContext(request, input.purpose));
  }

  @Get(':jobId/extractions')
  @RequirePermissions('ocr.job.read')
  @AuditAction('ocr.extraction.list.request')
  extractions(@Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string, @Req() request: HidRequest) {
    return this.ocr.listExtractions(jobId, requireRequestContext(request));
  }

  @Post(':jobId/validation')
  @RequirePermissions('ocr.validation.write')
  @AuditAction('ocr.validation.create.request')
  validate(@Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
    @Body() input: ValidateOcrJobDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest) {
    return this.ocr.validate(jobId, input, key, requireRequestContext(request, input.purpose));
  }

  @Post(':jobId/validations')
  @RequirePermissions('ocr.validation.write')
  @AuditAction('ocr.validation.create.request')
  validatePlural(@Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
    @Body() input: ValidateOcrJobDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest) {
    return this.ocr.validate(jobId, input, key, requireRequestContext(request, input.purpose));
  }

  @Get(':jobId/validations')
  @RequirePermissions('ocr.job.read')
  @AuditAction('ocr.validation.list.request')
  validations(@Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
    @Req() request: HidRequest) {
    return this.ocr.listValidations(jobId, requireRequestContext(request));
  }

  @Post(':jobId/patient-confirmation')
  @RequirePermissions('ocr.patient.confirm')
  @AuditAction('ocr.patient.confirm.request')
  confirmPatient(@Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
    @Body() input: ConfirmOcrPatientDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest) {
    return this.ocr.confirmPatient(jobId, input, key, requireRequestContext(request, input.purpose));
  }
}

@Controller('ocr/validations')
export class OcrPublicationController {
  constructor(private readonly ocr: OcrService) {}

  @Post(':validationId/publications')
  @RequirePermissions('ocr.publication.write')
  @AuditAction('ocr.publication.create.request')
  publish(@Param('validationId', new ParseUUIDPipe({ version: '4' })) validationId: string,
    @Body() input: CreateOcrPublicationDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest) {
    return this.ocr.createPublication(validationId, input, key, requireRequestContext(request, input.purpose));
  }

  @Get(':validationId/publications')
  @RequirePermissions('ocr.job.read')
  @AuditAction('ocr.publication.list.request')
  list(@Param('validationId', new ParseUUIDPipe({ version: '4' })) validationId: string,
    @Req() request: HidRequest) {
    return this.ocr.listPublications(validationId, requireRequestContext(request));
  }
}

