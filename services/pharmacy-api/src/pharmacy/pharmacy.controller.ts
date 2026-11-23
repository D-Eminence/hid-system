import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InternalCaller, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { AcceptEhrPrescriptionDto } from './dto/accept-ehr-prescription.dto';
import { AcceptWorkItemDto } from './dto/accept-work-item.dto';
import { ReverseDispensingDto } from './dto/dispensing.dto';
import { ListImportedMedicationsQueryDto, OcrMedicationImportBatchDto, OcrMedicationImportDto }
  from './dto/ocr-medication-import.dto';
import { PharmacyService } from './pharmacy.service';
import { CreateDispensingBodyPipe, type CreateDispensingInput } from './prescription-refills';

@Controller('pharmacy')
export class PharmacyController {
  constructor(private readonly pharmacy: PharmacyService) {}

  @Post('work-items/accept-ehr-prescription')
  @HttpCode(201)
  @InternalCaller('ehr-api')
  @RequirePermissions('pharmacy.work-item.accept')
  accept(@Body() input: AcceptEhrPrescriptionDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest) {
    return this.pharmacy.acceptPrescription(requireRequestContext(request), input,
      requireIdempotencyKey(key));
  }

  @Get('work-items')
  @RequirePermissions('pharmacy.work-item.read')
  list(@Req() request: HidRequest) {
    return this.pharmacy.listWorkItems(requireRequestContext(request));
  }

  @Get('work-items/:workItemId')
  @RequirePermissions('pharmacy.work-item.read')
  getWorkItem(@Param('workItemId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: HidRequest) {
    return this.pharmacy.getWorkItem(requireRequestContext(request), id);
  }

  /**
   * ORD-4: a pharmacist accepts a work item before dispensing it. A browser
   * write (Origin and CSRF checks as for other browser writes), with a
   * required Idempotency-Key and exactly { expectedWorkItemVersion }. 201 when
   * this call recorded the acceptance, 200 with `alreadyAccepted: true` when
   * the item was already accepted, by anyone and in any way.
   */
  @Post('work-items/:workItemId/accept')
  @RequirePermissions('pharmacy.work-item.accept')
  async acceptWorkItem(@Param('workItemId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: AcceptWorkItemDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    const answer = await this.pharmacy.acceptWorkItem(requireRequestContext(request), id, input,
      requireIdempotencyKey(key));
    response.status(answer.alreadyAccepted ? 200 : 201);
    return answer;
  }

  /**
   * The body is checked by CreateDispensingBodyPipe: today's
   * CreateDispensingDto, or with `fillNumber` while PRESCRIPTION_REFILLS_ENABLED
   * is on (ORD-12). Its declared type is a union, so the global pipe leaves it
   * to that pipe. 201 for a recorded fill and for its replay.
   */
  @Post('work-items/:workItemId/dispensings')
  @HttpCode(201)
  @RequirePermissions('pharmacy.dispensing.create')
  dispense(@Param('workItemId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body(CreateDispensingBodyPipe) input: CreateDispensingInput, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest) {
    return this.pharmacy.dispense(requireRequestContext(request), id, input, requireIdempotencyKey(key));
  }

  @Get('dispensings/:dispensingId')
  @RequirePermissions('pharmacy.dispensing.read')
  getDispensing(@Param('dispensingId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: HidRequest) {
    return this.pharmacy.getDispensing(requireRequestContext(request), id);
  }

  @Post('dispensings/:dispensingId/reversals')
  @HttpCode(201)
  @RequirePermissions('pharmacy.dispensing.reverse')
  reverse(@Param('dispensingId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: ReverseDispensingDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest) {
    return this.pharmacy.reverse(requireRequestContext(request), id, input, requireIdempotencyKey(key));
  }

  @Post('imports/from-ocr')
  @HttpCode(201)
  @InternalCaller('ocr-api')
  @RequirePermissions('pharmacy.import.write')
  createImport(@Body() input: OcrMedicationImportDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest) {
    return this.pharmacy.createImport(requireRequestContext(request), input, requireIdempotencyKey(key));
  }

  /** Several medicines from one OCR review: every one is stored, or none. Same guards as the single route. */
  @Post('imports/from-ocr/batch')
  @HttpCode(201)
  @InternalCaller('ocr-api')
  @RequirePermissions('pharmacy.import.write')
  createImportBatch(@Body() input: OcrMedicationImportBatchDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    return this.pharmacy.createImportBatch(requireRequestContext(request), input, requireIdempotencyKey(key));
  }

  /**
   * One patient's imported medication records at this facility, newest first,
   * paged (`limit` 1-100, `cursor`). Same guards as GET imports/:importId.
   */
  @Get('imports')
  @RequirePermissions('pharmacy.import.read')
  listImports(@Query() query: ListImportedMedicationsQueryDto, @Req() request: HidRequest) {
    return this.pharmacy.listImports(requireRequestContext(request), query);
  }

  @Get('imports/:importId')
  @RequirePermissions('pharmacy.import.read')
  getImport(@Param('importId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: HidRequest) {
    return this.pharmacy.getImport(requireRequestContext(request), id);
  }
}
