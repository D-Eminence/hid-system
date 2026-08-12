import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import {
  CreateClinicalNoteDto,
  CreateClinicalNoteRevisionDto,
  TimelineQueryDto,
  UpdateClinicalNoteDto,
} from '../shared/clinical.dto';
import { ClinicalNotesService } from './clinical-notes.service';

@Controller('ehr/patients/:patientId/encounters/:encounterId/clinical-notes')
export class ClinicalNotesController {
  constructor(private readonly notes: ClinicalNotesService) {}

  @Get()
  @RequirePermissions('ehr.note.read')
  list(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string, @Query() query: TimelineQueryDto) {
    return this.notes.list(clinicalContext(request), patientId, encounterId, query);
  }

  @Get(':noteId')
  @RequirePermissions('ehr.note.read')
  get(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('noteId', new ParseUUIDPipe()) noteId: string) {
    return this.notes.get(clinicalContext(request), patientId, encounterId, noteId);
  }

  @Get(':noteId/revisions')
  @RequirePermissions('ehr.note.read')
  revisions(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('noteId', new ParseUUIDPipe()) noteId: string) {
    return this.notes.listRevisions(clinicalContext(request), patientId, encounterId, noteId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('ehr.note.write')
  create(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CreateClinicalNoteDto) {
    return this.notes.create(clinicalContext(request), patientId, encounterId, input, requireIdempotencyKey(key));
  }

  @Patch(':noteId')
  @RequirePermissions('ehr.note.write')
  update(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('noteId', new ParseUUIDPipe()) noteId: string, @Body() input: UpdateClinicalNoteDto) {
    return this.notes.update(clinicalContext(request), patientId, encounterId, noteId, input);
  }

  @Post(':noteId/revisions')
  @HttpCode(201)
  @RequirePermissions('ehr.note.write')
  addRevision(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('noteId', new ParseUUIDPipe()) noteId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CreateClinicalNoteRevisionDto) {
    return this.notes.addRevision(
      clinicalContext(request), patientId, encounterId, noteId, input, requireIdempotencyKey(key),
    );
  }
}
