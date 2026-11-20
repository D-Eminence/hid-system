import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import { CreateConsultationDraftDto, SaveConsultationDraftDto } from './consultation-drafts.dto';
import { ConsultationDraftsService } from './consultation-drafts.service';

/**
 * EHR-C6 (0141, owner decision Q126 A): consultation drafts, author only.
 * Every route needs ehr.note.write; GET, POST and PATCH only (ehr-api's CORS).
 */
@Controller('ehr/patients/:patientId/consultation-drafts')
@RequirePermissions('ehr.note.write')
export class ConsultationDraftsController {
  constructor(private readonly drafts: ConsultationDraftsService) {}

  @Post()
  @HttpCode(201)
  create(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CreateConsultationDraftDto) {
    return this.drafts.create(clinicalContext(request), patientId, input, requireIdempotencyKey(key));
  }

  @Get()
  list(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string) {
    return this.drafts.list(clinicalContext(request), patientId);
  }

  @Get(':draftId')
  read(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('draftId', new ParseUUIDPipe()) draftId: string) {
    return this.drafts.read(clinicalContext(request), patientId, draftId);
  }

  @Patch(':draftId')
  save(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('draftId', new ParseUUIDPipe()) draftId: string, @Body() input: SaveConsultationDraftDto) {
    return this.drafts.save(clinicalContext(request), patientId, draftId, input);
  }

  /** The body is `{}` and is not read. Safe to repeat. */
  @Post(':draftId/discard')
  @HttpCode(204)
  async discard(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('draftId', new ParseUUIDPipe()) draftId: string): Promise<void> {
    await this.drafts.discard(clinicalContext(request), patientId, draftId);
  }
}

/** EHR-C6: the author's drafts across patients at this facility. */
@Controller('ehr/my-consultation-drafts')
@RequirePermissions('ehr.note.write')
export class MyConsultationDraftsController {
  constructor(private readonly drafts: ConsultationDraftsService) {}

  @Get()
  mine(@Req() request: HidRequest) {
    return this.drafts.mine(clinicalContext(request));
  }
}
