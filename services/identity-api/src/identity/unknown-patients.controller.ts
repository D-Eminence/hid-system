import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import { type DataAccessContext, type HidRequest, requireRequestContext } from '../common/request-context';
import { CreateUnknownPatientDto, DecideUnknownPatientDto, IdentifyUnknownPatientDto,
  ListUnknownPatientsDto } from './dto/unknown-patient.dto';
import { UnknownPatientsService } from './unknown-patients.service';

/**
 * 0146 (ID-7): unknown patient records at the X-Facility-ID facility, for
 * healthcare operations (POST bodies carry `purpose`, GETs the
 * X-Purpose-Of-Use header). Every write needs an Idempotency-Key. Each route
 * sees only this facility's unknown records; any other answers 404
 * PATIENT_NOT_FOUND (Q100 B), with the reason in the audit row.
 */
@Controller('identity/unknown-patients')
export class UnknownPatientsController {
  constructor(private readonly unknownPatients: UnknownPatientsService) {}

  @Post()
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.unknown-patient.create.request')
  async create(@Body() input: CreateUnknownPatientDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    const idempotencyKey = requireIdempotencyKey(key);
    const answer = await this.unknownPatients.create(input, idempotencyKey, requireRequestContext(request, input.purpose));
    response.status(answer.status);
    return answer.body;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.unknown-patient.list.request')
  list(@Query() query: ListUnknownPatientsDto, @Req() request: HidRequest) {
    return this.unknownPatients.list(query, operations(request));
  }

  @Get(':patientId')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.unknown-patient.read.request')
  read(@Param('patientId', new ParseUUIDPipe({ version: '4' })) patientId: string, @Req() request: HidRequest) {
    return this.unknownPatients.read(patientId, operations(request));
  }

  @Post(':patientId/identify')
  @HttpCode(200)
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.unknown-patient.identify.request')
  identify(@Param('patientId', new ParseUUIDPipe({ version: '4' })) patientId: string,
    @Body() input: IdentifyUnknownPatientDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.unknownPatients.identify(patientId, input, idempotencyKey, requireRequestContext(request, input.purpose));
  }

  @Post(':patientId/confirm-separate')
  @HttpCode(200)
  @RequirePermissions('identity.registration.approve')
  @AuditAction('identity.unknown-patient.confirm-separate.request')
  confirmSeparate(@Param('patientId', new ParseUUIDPipe({ version: '4' })) patientId: string,
    @Body() input: DecideUnknownPatientDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.unknownPatients.decide(patientId, 'confirm_separate', input, idempotencyKey,
      requireRequestContext(request, input.purpose));
  }

  @Post(':patientId/cancel')
  @HttpCode(200)
  @RequirePermissions('identity.registration.approve')
  @AuditAction('identity.unknown-patient.cancel.request')
  cancel(@Param('patientId', new ParseUUIDPipe({ version: '4' })) patientId: string,
    @Body() input: DecideUnknownPatientDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.unknownPatients.decide(patientId, 'cancel', input, idempotencyKey,
      requireRequestContext(request, input.purpose));
  }
}

/** A GET's context: X-Purpose-Of-Use must be healthcare-operations. */
function operations(request: HidRequest): DataAccessContext {
  const context = requireRequestContext(request);
  if (context.purposeOfUse !== 'healthcare-operations') {
    throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'X-Purpose-Of-Use must be healthcare-operations');
  }
  return context;
}
