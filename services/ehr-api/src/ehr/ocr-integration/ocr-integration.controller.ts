import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { OcrInternalCallerGuard } from '../../auth/ocr-internal-caller.guard';
import { AuditAction, RequirePermissions } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import { requireRequestContext, type HidRequest } from '../../common/request-context';
import { DocumentService } from '../../documents/document.service';
import { ClinicalNotesService } from '../clinical-notes/clinical-notes.service';
import { ImportOcrClinicalNoteDto } from './dto/import-ocr-clinical-note.dto';

@Controller('ehr/internal/ocr')
@UseGuards(OcrInternalCallerGuard)
export class OcrIntegrationController {
  constructor(
    private readonly documents: DocumentService,
    private readonly clinicalNotes: ClinicalNotesService,
  ) {}

  @Get('documents/:documentId/source')
  @RequirePermissions('ocr.job.read')
  @AuditAction('ehr.ocr-source.read.request')
  source(
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @Req() request: HidRequest,
  ) {
    return this.documents.getOcrSource(documentId, requireRequestContext(request));
  }

  @Post('patients/:patientId/clinical-notes')
  @RequirePermissions('ocr.publication.write')
  @AuditAction('ehr.ocr-clinical-note.import.request')
  importClinicalNote(
    @Param('patientId', new ParseUUIDPipe({ version: '4' })) patientId: string,
    @Body() input: ImportOcrClinicalNoteDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest,
  ) {
    if (idempotencyKey !== `ocr-publication:${input.publicationId}`) {
      throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT',
        'The EHR import command must bind idempotency to the OCR publication');
    }
    return this.clinicalNotes.createImportedFromOcr(
      requireRequestContext(request), patientId, input,
    );
  }
}
