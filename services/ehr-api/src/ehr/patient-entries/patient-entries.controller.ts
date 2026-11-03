import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { AuditFailuresOnly, FacilityOptional, PatientAllowed, RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext } from '../shared/clinical-context';
import { PatientEntriesEnabledGuard } from './patient-entries-enabled.guard';
import { CreatePatientEntryDto } from './patient-entries.dto';
import { PatientEntriesService } from './patient-entries.service';

/**
 * Records patients add themselves, text only (0116): the patient adds and
 * withdraws their own records; a clinician with access reads them, labelled
 * by the website "Added by the patient. Not checked by a health worker." The
 * patient's list comes with GET ehr/me/records (patientEntries); there is no
 * list route of its own. While PATIENT_ENTRIES_ENABLED is off every route
 * answers a plain 404 (PatientEntriesModule's middleware, then this guard).
 * Successes are audited by the commands and ClinicalRepository; the
 * interceptor records failures.
 */
@Controller('ehr')
@AuditFailuresOnly()
@UseGuards(PatientEntriesEnabledGuard)
export class PatientEntriesController {
  constructor(private readonly entries: PatientEntriesService) {}

  @Post('me/patient-entries')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @FacilityOptional()
  @PatientAllowed()
  create(@Req() request: HidRequest, @Body() input: CreatePatientEntryDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined) {
    return this.entries.create(request, input, idempotencyKey);
  }

  @Post('me/patient-entries/:entryId/withdraw')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @FacilityOptional()
  @PatientAllowed()
  withdraw(@Param('entryId', new ParseUUIDPipe()) entryId: string, @Req() request: HidRequest) {
    return this.entries.withdraw(request, entryId);
  }

  @Get('patients/:patientId/patient-entries')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('ehr.note.read')
  staffList(@Param('patientId', new ParseUUIDPipe()) patientId: string, @Req() request: HidRequest) {
    return this.entries.staffList(patientId, clinicalContext(request));
  }
}
