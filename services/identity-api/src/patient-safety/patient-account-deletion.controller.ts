import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, PatientOnly } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { CancelAccountDeletionDto, ConfirmAccountDeletionDto } from './dto/account-deletion.dto';
import { PatientAccountDeletionService } from './patient-account-deletion.service';

/**
 * Delete my account (B5, migration 0096; main's controller). Patient sessions
 * only; every POST is a cookie write with Origin and CSRF. The SECURITY
 * DEFINER commands write the success audit for every state change; the
 * interceptor records failures. GET is the website's served probe: 404 while
 * ACCOUNT_DELETION_ENABLED is false, as on an older Identity.
 */
@Controller('identity/me/account-deletion')
@PatientOnly()
@AuditFailuresOnly()
export class PatientAccountDeletionController {
  constructor(private readonly deletion: PatientAccountDeletionService) {}

  @Get()
  status(@Req() request: HidRequest) {
    return this.deletion.status(request);
  }

  @Post()
  @HttpCode(201)
  @AuditAction('identity.patient-account-deletion.request.command')
  requestDeletion(@Req() request: HidRequest) {
    return this.deletion.request(request);
  }

  @Post('confirm')
  @HttpCode(200)
  @AuditAction('identity.patient-account-deletion.confirm.command')
  confirm(@Req() request: HidRequest, @Body() input: ConfirmAccountDeletionDto) {
    return this.deletion.confirm(request, input);
  }

  @Post('cancel')
  @HttpCode(200)
  @AuditAction('identity.patient-account-deletion.cancel.command')
  cancel(@Req() request: HidRequest, @Body() input: CancelAccountDeletionDto) {
    return this.deletion.cancel(request, input);
  }
}
