import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { InternalCaller } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { CreateLabImportDto, ListLabImportsQueryDto, ListOtherFacilityLabImportsQueryDto } from './dto/create-lab-import.dto';
import { OcrLabImportDto } from './dto/ocr-lab-import.dto';
import { LabImportsService } from './lab-imports.service';

@Controller('lab/imports')
export class LabImportsController {
  constructor(private readonly imports: LabImportsService) {}

  @Post('from-ocr') @HttpCode(201) @InternalCaller('ocr-api') @RequirePermissions('lab.import.write')
  @AuditAction('lab.import.create-from-ocr.request')
  fromOcr(@Body() input:OcrLabImportDto,@Headers('idempotency-key') key:string|undefined,@Req() request:HidRequest) {
    requireIdempotencyKey(key); return this.imports.createFromOcr(requireRequestContext(request),input);
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('lab.import.write')
  @AuditAction('lab.import.create.request')
  create(@Body() input: CreateLabImportDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest) {
    return this.imports.createExternal(
      requireRequestContext(request, input.purpose), input, requireIdempotencyKey(key));
  }

  /** One patient's imported Lab evidence, newest first, paged by cursor (patient id is the Identity UUID, never a Health ID). */
  @Get()
  @RequirePermissions('lab.import.read')
  @AuditAction('lab.import.list.request')
  list(@Query() query: ListLabImportsQueryDto, @Req() request: HidRequest) {
    return this.imports.listForPatient(requireRequestContext(request), query);
  }

  /**
   * 0124 (Q64 option A): the patient's imported Lab evidence from OTHER
   * facilities, for staff at the facility of an active patient share to their
   * membership that includes other facilities. The SQL function checks the
   * share and writes the read's audit row; no Identity decision is asked.
   * Declared before :importId.
   */
  @Get('other-facilities')
  @RequirePermissions('lab.import.read')
  @AuditAction('lab.import.other-facilities.list.request')
  listOtherFacilities(@Query() query: ListOtherFacilityLabImportsQueryDto, @Req() request: HidRequest) {
    return this.imports.listOtherFacilities(requireRequestContext(request), query);
  }

  @Get(':importId')
  @RequirePermissions('lab.import.read')
  @AuditAction('lab.import.read.request')
  get(@Param('importId', new ParseUUIDPipe({ version: '4' })) importId: string, @Req() request: HidRequest) {
    return this.imports.get(requireRequestContext(request), importId);
  }
}
