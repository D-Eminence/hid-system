import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AuditFailuresOnly, RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { PatientChatDto } from './patient-chat.dto';
import { PatientChatService } from './patient-chat.service';
import { StaffChatScopeService } from './staff-chat-scope.service';
import { StaffEvidenceService } from './staff-evidence.service';
import { StaffChatHistoryService } from './staff-chat-history.service';

@Controller('ehr/patients/:patientId/chat')
@AuditFailuresOnly()
@RequirePermissions('ehr.note.read')
export class StaffPatientChatController {
  constructor(private readonly scopes: StaffChatScopeService, private readonly evidence: StaffEvidenceService,
    private readonly history: StaffChatHistoryService, private readonly chat: PatientChatService) {}
  @Post() @Header('Cache-Control', 'no-store')
  async answer(@Param('patientId', new ParseUUIDPipe()) id: string, @Body() body: PatientChatDto, @Req() request: HidRequest) {
    const scope = await this.scopes.open(request, id);
    return this.chat.answer(request, body.question, { ...scope, chunksTable: 'ehr.staff_evidence_chunks',
      audit: this.evidence.auditScope(scope), evidence: this.evidence.bind(scope), history: this.history.bind(scope) });
  }
  @Get('history') @Header('Cache-Control', 'no-store')
  async read(@Param('patientId', new ParseUUIDPipe()) id: string, @Req() request: HidRequest) {
    return this.history.read(await this.scopes.open(request, id), request);
  }
  @Delete('history') @Header('Cache-Control', 'no-store')
  async clear(@Param('patientId', new ParseUUIDPipe()) id: string, @Req() request: HidRequest) {
    return this.history.clear(await this.scopes.open(request, id), request);
  }
  @Get('sources/:kind/:sourceId') @Header('Cache-Control', 'no-store')
  async source(@Param('patientId', new ParseUUIDPipe()) patientId: string, @Param('kind') kind: string,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string, @Req() request: HidRequest) {
    return this.evidence.source(await this.scopes.open(request, patientId), request, kind, sourceId);
  }
}
