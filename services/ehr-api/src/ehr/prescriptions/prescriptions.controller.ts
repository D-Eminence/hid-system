import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import {
  AcceptPrescriptionForPharmacyDto,
  CreatePrescriptionDto,
  TimelineQueryDto,
  UpdatePrescriptionDto,
} from '../shared/clinical.dto';
import { PrescriptionsService } from './prescriptions.service';

@Controller('ehr/patients/:patientId/encounters/:encounterId/prescriptions')
export class PrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  @Get()
  @RequirePermissions('ehr.prescription.read')
  list(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string, @Query() query: TimelineQueryDto) {
    return this.prescriptions.list(clinicalContext(request), patientId, encounterId, query);
  }

  @Get(':prescriptionId')
  @RequirePermissions('ehr.prescription.read')
  get(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('prescriptionId', new ParseUUIDPipe()) prescriptionId: string) {
    return this.prescriptions.get(clinicalContext(request), patientId, encounterId, prescriptionId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('ehr.prescription.write')
  create(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CreatePrescriptionDto) {
    return this.prescriptions.create(
      clinicalContext(request), patientId, encounterId, input, requireIdempotencyKey(key),
    );
  }

  @Patch(':prescriptionId')
  @RequirePermissions('ehr.prescription.write')
  update(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('prescriptionId', new ParseUUIDPipe()) prescriptionId: string, @Body() input: UpdatePrescriptionDto) {
    return this.prescriptions.update(clinicalContext(request), patientId, encounterId, prescriptionId, input);
  }

  @Post(':prescriptionId/pharmacy-work-item')
  @RequirePermissions('pharmacy.work-item.accept')
  acceptForPharmacy(
    @Req() request: HidRequest,
    @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('prescriptionId', new ParseUUIDPipe()) prescriptionId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() input: AcceptPrescriptionForPharmacyDto,
  ) {
    return this.prescriptions.acceptForPharmacy(
      clinicalContext(request),
      patientId,
      encounterId,
      prescriptionId,
      input,
      requireIdempotencyKey(key),
    );
  }
}
