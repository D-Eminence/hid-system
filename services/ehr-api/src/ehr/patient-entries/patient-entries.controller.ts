import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards }
  from '@nestjs/common';
import type { Response } from 'express';
import { AuditFailuresOnly, FacilityOptional, PatientAllowed, RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext } from '../shared/clinical-context';
import { PatientEntriesEnabledGuard } from './patient-entries-enabled.guard';
import { CreatePatientEntryDto, PatientEntriesPageDto } from './patient-entries.dto';
import { PatientEntriesService } from './patient-entries.service';

/**
 * Records patients add themselves, text only (0116): the patient adds,
 * lists and withdraws their own records; a clinician with access reads them,
 * labelled by the website "Added by the patient. Not checked by a health
 * worker." The first page of the patient's list also comes with GET
 * ehr/me/records (patientEntries); both lists page on with `before`. While
 * PATIENT_ENTRIES_ENABLED is off every route answers a plain 404
 * (PatientEntriesModule's middleware, then this guard). Writes are audited
 * by the commands, the patient's list here and the staff read by
 * ClinicalRepository; the interceptor records failures.
 */
@Controller('ehr')
@AuditFailuresOnly()
@UseGuards(PatientEntriesEnabledGuard)
export class PatientEntriesController {
  constructor(private readonly entries: PatientEntriesService) {}

  /** 201 for a new record; 200 for a replay (the same key and values, or a double tap), with the same entry. */
  @Post('me/patient-entries')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @FacilityOptional()
  @PatientAllowed()
  async create(@Req() request: HidRequest, @Body() input: CreatePatientEntryDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Res({ passthrough: true }) response: Response) {
    const saved = await this.entries.create(request, input, idempotencyKey);
    if (saved.replayed) response.status(200);
    return saved;
  }

  @Post('me/patient-entries/:entryId/withdraw')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @FacilityOptional()
  @PatientAllowed()
  withdraw(@Param('entryId', new ParseUUIDPipe()) entryId: string, @Req() request: HidRequest) {
    return this.entries.withdraw(request, entryId);
  }

  @Get('me/patient-entries')
  @Header('Cache-Control', 'no-store')
  @FacilityOptional()
  @PatientAllowed()
  list(@Query() query: PatientEntriesPageDto, @Req() request: HidRequest) {
    return this.entries.list(request, query.before);
  }

  @Get('patients/:patientId/patient-entries')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('ehr.note.read')
  staffList(@Param('patientId', new ParseUUIDPipe()) patientId: string, @Query() query: PatientEntriesPageDto,
    @Req() request: HidRequest) {
    return this.entries.staffList(patientId, clinicalContext(request), query.before);
  }
}
