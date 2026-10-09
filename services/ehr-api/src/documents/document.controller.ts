import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, Public, RequirePermissions } from '../common/decorators';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { DocumentService } from './document.service';
import { CreateDocumentUploadDto } from './dto/create-document-upload.dto';
import { DocumentScanEventDto } from './dto/document-scan-event.dto';
import { IdentityApiService } from '../integrations/identity-api.service';
import { ListDocumentsDto } from './dto/list-documents.dto';

@Controller('ehr/documents')
export class DocumentController {
  constructor(
    private readonly documents: DocumentService,
    private readonly identity: IdentityApiService,
  ) {}

  @Post('upload-intents')
  @RequirePermissions('ehr.document.write')
  @AuditAction('ehr.document.upload-intent.request')
  createUpload(
    @Body() input: CreateDocumentUploadDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest,
  ) {
    const context = requireRequestContext(request);
    return this.documents.createUploadIntent(input, idempotencyKey ?? '', context);
  }

  @Get()
  @RequirePermissions('ehr.document.read')
  @AuditAction('ehr.document.list.request')
  list(@Query() query: ListDocumentsDto, @Req() request: HidRequest) {
    return this.documents.list(query.patientId, query.encounterId, requireRequestContext(request));
  }

  @Post(':id/complete')
  @RequirePermissions('ehr.document.write')
  @AuditAction('ehr.document.upload-complete.request')
  complete(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: HidRequest,
  ) {
    return this.documents.complete(id, requireRequestContext(request));
  }

  @Get(':id/download')
  @RequirePermissions('ehr.document.read')
  @AuditAction('ehr.document.download.request')
  download(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: HidRequest,
  ) {
    return this.documents.createDownload(id, requireRequestContext(request));
  }

  @Post('scan-events')
  @Public()
  @AuditAction('ehr.document.scan-event.request')
  @HttpCode(202)
  async recordScan(@Body() input: DocumentScanEventDto, @Req() request: HidRequest) {
    const actor = await this.identity.authorizeDocumentScanner(
      request.header('authorization'),
      request.correlationId,
    );
    return this.documents.recordScan(input, actor, request.correlationId);
  }
}
