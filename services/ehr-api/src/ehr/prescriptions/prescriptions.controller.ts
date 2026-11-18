import { Body, Controller, Get, Headers, HttpCode, Optional, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import {
  AcceptPrescriptionForPharmacyDto,
  TimelineQueryDto,
  UpdatePrescriptionDto,
} from '../shared/clinical.dto';
import { CreatePrescriptionBodyPipe, type CreatePrescriptionInput } from './prescription-dispensing-details';
import { PrescriptionsService } from './prescriptions.service';
import { WorkItemProgressService } from '../../integrations/work-item-progress.service';

@Controller('ehr/patients/:patientId/encounters/:encounterId/prescriptions')
export class PrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService,
    @Optional() private readonly progress?: WorkItemProgressService) {}

  /** Each item carries `ownProgress` in this facility's own pharmacy (ORD-3), read after the list. */
  @Get()
  @RequirePermissions('ehr.prescription.read')
  async list(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string, @Query() query: TimelineQueryDto) {
    const context = clinicalContext(request);
    const page = await this.prescriptions.list(context, patientId, encounterId, query);
    return this.progress ? this.progress.withPrescriptionProgress(context, patientId, page) : page;
  }

  /** With `ownProgress` (ORD-3), read after the prescription. */
  @Get(':prescriptionId')
  @RequirePermissions('ehr.prescription.read')
  async get(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('prescriptionId', new ParseUUIDPipe()) prescriptionId: string) {
    const context = clinicalContext(request);
    const prescription = await this.prescriptions.get(context, patientId, encounterId, prescriptionId);
    return this.progress ? this.progress.withPrescription(context, patientId, prescription) : prescription;
  }

  /**
   * The body is checked by CreatePrescriptionBodyPipe: today's
   * CreatePrescriptionDto, or with the dispensing details while
   * PRESCRIPTION_DISPENSING_DETAILS_ENABLED is on (0125). Its declared type is
   * a union, so the global pipe leaves it to that pipe.
   */
  @Post()
  @HttpCode(201)
  @RequirePermissions('ehr.prescription.write')
  create(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(CreatePrescriptionBodyPipe) input: CreatePrescriptionInput) {
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
