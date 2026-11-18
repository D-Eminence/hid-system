import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, RequireAnyPermission, RequirePermissions } from '../common/decorators';
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

  // Starting or retrying a reading needs ocr.job.start as well as
  // ocr.job.write (owner decision Q111 A, migration 0136): doctors keep
  // ocr.job.write for checking readings and confirming their patient under
  // records processing, but do not start new readings; the front desk,
  // nurses and clinicians do.
  @Post()
  @RequirePermissions('ocr.job.write', 'ocr.job.start')
  @AuditAction('ocr.job.create.request')
  create(@Body() input: CreateOcrJobDto, @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    return this.ocr.createJob(input, key, requireRequestContext(request, input.purpose));
  }

  // ocr.job.read, or the front desk's ocr.job.read-own (owner decision Q112
  // A): then only a reading of a document its own login uploaded (ehr-api's
  // source read answers 404 for any other, so this answers OCR_JOB_NOT_FOUND).
  // The status only, never the text: extractions, validations and
  // publications below still need ocr.job.read.
  @Get(':jobId')
  @RequireAnyPermission('ocr.job.read', 'ocr.job.read-own')
  @AuditAction('ocr.job.read.request')
  get(@Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string, @Req() request: HidRequest) {
    return this.ocr.getJob(jobId, requireRequestContext(request));
  }

  @Get()
  @RequireAnyPermission('ocr.job.read', 'ocr.job.read-own')
  @AuditAction('ocr.job.find.request')
  find(@Query() query: FindOcrJobDto, @Req() request: HidRequest) {
    return this.ocr.findForDocument(query.documentId, requireRequestContext(request));
  }

  @Post(':jobId/retry')
  @RequirePermissions('ocr.job.write', 'ocr.job.start')
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

