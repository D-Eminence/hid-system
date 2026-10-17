import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { AskRecordChatDto } from './ask-record-chat.dto';
import { StaffRecordChatService } from './staff-record-chat.service';

/**
 * Staff record chat (ADR-069). A staff session holding ehr.record-chat.use,
 * for direct care only (X-Purpose-Of-Use: direct-care, else 400
 * PURPOSE_OF_USE_REQUIRED) and never under break-glass (403
 * BREAK_GLASS_EXCLUDED, audited). The patient is named in the path and Identity
 * authorizes this member for that patient on every question; the history
 * routes stay available while chat is off, so a member can always read and
 * delete their own history. Every answer is no-store (preventResponseCaching).
 */
@Controller('ehr/patients/:patientId/chat')
@RequirePermissions('ehr.record-chat.use')
@AuditFailuresOnly()
export class StaffRecordChatController {
  constructor(private readonly chat: StaffRecordChatService) {}

  @Get('availability')
  availability(@Param('patientId', new ParseUUIDPipe()) _patientId: string, @Req() request: HidRequest) {
    return this.chat.availability(request);
  }

  @Post()
  @HttpCode(200)
  @AuditAction('ehr.record-chat.staff.ask')
  ask(@Param('patientId', new ParseUUIDPipe()) patientId: string, @Body() body: AskRecordChatDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HidRequest) {
    return this.chat.ask(request, patientId, body, idempotencyKey);
  }

  @Get('history')
  history(@Param('patientId', new ParseUUIDPipe()) patientId: string, @Req() request: HidRequest) {
    return this.chat.history(request, patientId);
  }

  @Delete('history')
  @HttpCode(200)
  clear(@Param('patientId', new ParseUUIDPipe()) patientId: string, @Req() request: HidRequest) {
    return this.chat.clear(request, patientId);
  }
}
