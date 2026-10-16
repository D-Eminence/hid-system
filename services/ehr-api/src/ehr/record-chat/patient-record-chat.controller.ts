import { Body, Controller, Delete, Get, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, PatientOnly } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { AskRecordChatDto } from './ask-record-chat.dto';
import { PatientRecordChatService } from './patient-record-chat.service';

/**
 * Patient record chat (owner decision 1 of 2026-10-16). Patient sessions only:
 * the guard refuses any other session with 403 PATIENT_SESSION_REQUIRED,
 * audited, before a handler runs (A9-EHR). Every answer is no-store
 * (preventResponseCaching). The history routes stay available while chat is
 * off, so a patient can always read and delete their own data.
 */
@Controller('ehr/me/chat')
@PatientOnly()
@AuditFailuresOnly()
export class PatientRecordChatController {
  constructor(private readonly chat: PatientRecordChatService) {}

  @Get('availability')
  availability() { return this.chat.availability(); }

  @Post()
  @HttpCode(200)
  @AuditAction('ehr.record-chat.ask')
  ask(@Body() body: AskRecordChatDto, @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest) {
    return this.chat.ask(request, body, idempotencyKey);
  }

  @Get('history')
  @AuditAction('ehr.record-chat.history.read.request')
  history(@Req() request: HidRequest) { return this.chat.history(request); }

  @Delete('history')
  @HttpCode(200)
  @AuditAction('ehr.record-chat.history.clear.request')
  clear(@Req() request: HidRequest) { return this.chat.clear(request); }
}
