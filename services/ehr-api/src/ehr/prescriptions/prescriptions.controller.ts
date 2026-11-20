import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
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
import { DuplicateMedicineChecker } from './duplicate-medicines';
import { SendPrescriptionToOwnPharmacyDto } from './own-pharmacy-send.dto';

@Controller('ehr/patients/:patientId/encounters/:encounterId/prescriptions')
export class PrescriptionsController {
  // Both are required: a missing provider fails at start, never silently drops ownProgress or duplicateMedicines.
  constructor(private readonly prescriptions: PrescriptionsService,
    private readonly progress: WorkItemProgressService,
    private readonly duplicates: DuplicateMedicineChecker) {}

  /** Each item carries `ownProgress` in this facility's own pharmacy (ORD-3), read after the list. */
  @Get()
  @RequirePermissions('ehr.prescription.read')
  async list(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string, @Query() query: TimelineQueryDto) {
    const context = clinicalContext(request);
    const page = await this.prescriptions.list(context, patientId, encounterId, query);
    return this.progress.withPrescriptionProgress(context, patientId, page);
  }

  /** With `ownProgress` (ORD-3), read after the prescription. */
  @Get(':prescriptionId')
  @RequirePermissions('ehr.prescription.read')
  async get(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('prescriptionId', new ParseUUIDPipe()) prescriptionId: string) {
    const context = clinicalContext(request);
    const prescription = await this.prescriptions.get(context, patientId, encounterId, prescriptionId);
    return this.progress.withPrescription(context, patientId, prescription);
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
  async create(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(CreatePrescriptionBodyPipe) input: CreatePrescriptionInput) {
    const context = clinicalContext(request);
    const created = await this.prescriptions.create(context, patientId, encounterId, input, requireIdempotencyKey(key));
    // ORD-10 phase 1: the same-medicine warning, after the write; it never fails the create.
    return this.duplicates.afterCreate(context, patientId, created);
  }

  @Patch(':prescriptionId')
  @RequirePermissions('ehr.prescription.write')
  update(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('prescriptionId', new ParseUUIDPipe()) prescriptionId: string, @Body() input: UpdatePrescriptionDto) {
    return this.prescriptions.update(clinicalContext(request), patientId, encounterId, prescriptionId, input);
  }

  /**
   * "Send to pharmacy" for the prescriber (0133): sends their active
   * prescription to this hospital's own pharmacy, or tries a pending send
   * again, and answers its `pharmacyHandoff`. Sending twice sends once (the
   * database keeps one work item per prescription), so no Idempotency-Key.
   */
  @Post(':prescriptionId/own-pharmacy-send')
  @HttpCode(200)
  @RequirePermissions('ehr.prescription.write')
  sendToOwnPharmacy(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('prescriptionId', new ParseUUIDPipe()) prescriptionId: string, @Body() input: SendPrescriptionToOwnPharmacyDto) {
    return this.prescriptions.sendToOwnPharmacy(clinicalContext(request), patientId, encounterId, prescriptionId, input);
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
