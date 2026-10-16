import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, PatientOnly, RequirePermissions } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import { requireRequestContext, type HidRequest } from '../../common/request-context';
import { PatientRecordsService } from './patient-records.service';

@Controller('ehr')
@AuditFailuresOnly()
export class PatientRecordsController {
  constructor(private readonly records: PatientRecordsService) {}

  // Patient sessions only: the guard refuses any other session with 403
  // PATIENT_SESSION_REQUIRED, audited, before this handler runs (A9-EHR).
  @Get('me/records')
  @PatientOnly()
  self(@Req() request: HidRequest) { return this.records.self(request); }

  // The patient's own released document (patient record release, D7): a 60 s
  // attachment URL, or one 404 DOCUMENT_NOT_AVAILABLE for anything else.
  // Patient sessions only, as above.
  @Get('me/documents/:documentId/download')
  @PatientOnly()
  @AuditAction('ehr.patient.self.document.download.request')
  downloadOwnDocument(@Param('documentId', new ParseUUIDPipe()) documentId: string, @Req() request: HidRequest) {
    return this.records.downloadOwnDocument(request, documentId);
  }

  @Get('patients/:patientId/emergency-records')
  @RequirePermissions('ehr.encounter.read','ehr.note.read')
  emergency(@Param('patientId', new ParseUUIDPipe()) patientId: string, @Req() request: HidRequest) {
    if (request.header('x-purpose-of-use') !== 'emergency') {
      throw new DomainProblem(400, 'EMERGENCY_PURPOSE_REQUIRED', 'Emergency purpose is required');
    }
    return this.records.emergency(patientId, requireRequestContext(request, 'emergency'));
  }
}
