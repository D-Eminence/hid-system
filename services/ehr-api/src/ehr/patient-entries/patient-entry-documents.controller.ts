import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { AuditFailuresOnly, FacilityOptional, PatientAllowed, RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext } from '../shared/clinical-context';
import { PatientEntryFilesEnabledGuard } from './patient-entry-files-enabled.guard';
import { CreatePatientEntryDocumentUploadDto } from './patient-entry-documents.dto';
import { PatientEntryDocumentsService } from './patient-entry-documents.service';

/**
 * Photos and files on the records patients add themselves (0117; health main
 * BACKEND-NEEDS.md section 1): ask for an upload link per file, PUT the bytes
 * to the link, confirm. A patient session only, with no facility. The list
 * comes with GET ehr/me/records (patientEntries[].documents). A clinician with
 * the patient's access opens a confirmed, clean file through the logged
 * download. While PATIENT_ENTRY_FILES_ENABLED is off every route answers a
 * plain 404 (PatientEntriesModule's middleware, then this guard). Writes are
 * audited by the commands, the staff download by ClinicalRepository; the
 * interceptor records failures.
 */
@Controller('ehr')
@AuditFailuresOnly()
@UseGuards(PatientEntryFilesEnabledGuard)
export class PatientEntryDocumentsController {
  constructor(private readonly documents: PatientEntryDocumentsService) {}

  /** 201 for a new file and for the same key before its file is confirmed (with a fresh link). */
  @Post('me/patient-entries/:entryId/documents/upload-intents')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @FacilityOptional()
  @PatientAllowed()
  createUploadIntent(@Param('entryId', new ParseUUIDPipe()) entryId: string, @Req() request: HidRequest,
    @Body() input: CreatePatientEntryDocumentUploadDto, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    return this.documents.createUploadIntent(request, entryId, input, idempotencyKey);
  }

  @Post('me/patient-entries/:entryId/documents/:documentId/complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @FacilityOptional()
  @PatientAllowed()
  complete(@Param('entryId', new ParseUUIDPipe()) entryId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string, @Req() request: HidRequest) {
    return this.documents.complete(request, entryId, documentId);
  }

  @Get('patients/:patientId/patient-entries/:entryId/documents/:documentId/download')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('ehr.note.read', 'ehr.document.read')
  staffDownload(@Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('entryId', new ParseUUIDPipe()) entryId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string, @Req() request: HidRequest) {
    return this.documents.staffDownload(patientId, entryId, documentId, clinicalContext(request));
  }
}
