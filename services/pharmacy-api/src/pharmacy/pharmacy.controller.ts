import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { InternalCaller, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { AcceptEhrPrescriptionDto } from './dto/accept-ehr-prescription.dto';
import { CreateDispensingDto, ReverseDispensingDto } from './dto/dispensing.dto';
import { ListImportedMedicationsQueryDto, ListOtherFacilityImportedMedicationsQueryDto, OcrMedicationImportBatchDto,
  OcrMedicationImportDto } from './dto/ocr-medication-import.dto';
import { PharmacyService } from './pharmacy.service';

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

  @Post('work-items/:workItemId/dispensings')
  @HttpCode(201)
  @RequirePermissions('pharmacy.dispensing.create')
  dispense(@Param('workItemId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: CreateDispensingDto, @Headers('idempotency-key') key: string | undefined,
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

  /**
   * 0124 (Q64 option A): the patient's imported medication records from OTHER
   * facilities, for staff at the facility of an active patient share to their
   * membership that includes other facilities. The SQL function checks the
   * share and writes the read's audit row; no Identity decision is asked.
   * Declared before imports/:importId.
   */
  @Get('imports/other-facilities')
  @RequirePermissions('pharmacy.import.read')
  listOtherFacilityImports(@Query() query: ListOtherFacilityImportedMedicationsQueryDto, @Req() request: HidRequest) {
    return this.pharmacy.listOtherFacilityImports(requireRequestContext(request), query);
  }

  @Get('imports/:importId')
  @RequirePermissions('pharmacy.import.read')
  getImport(@Param('importId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: HidRequest) {
    return this.pharmacy.getImport(requireRequestContext(request), id);
  }
}
