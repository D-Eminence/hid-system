import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, PatientOnly } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { PatientSelfService } from './patient-self.service';
import { WorkloadAuthService } from './workload-auth.service';
import { SetPatientAccessPinDto } from './dto/set-patient-access-pin.dto';
import { ImportedHistorySharingDto } from './dto/imported-history-sharing.dto';
import { ImportedHistorySharingEnabledGuard } from './imported-history-sharing.guard';

// Patient-only (A9): a staff or platform session is refused by the guard with
// 403 PATIENT_SESSION_REQUIRED and that refusal is audited.
@Controller('identity')
@PatientOnly()
@AuditFailuresOnly()
export class PatientSelfController {
  constructor(private readonly self: PatientSelfService, private readonly workload: WorkloadAuthService) {}

  @Get('me')
  profile(@Req() request: HidRequest) { return this.self.profile(request); }

  @Get('me/access-history')
  history(@Req() request: HidRequest) { return this.self.history(request); }

  @Get('me/notifications')
  notificationInbox(@Req() request: HidRequest, @Query('limit') limit?: string) {
    const parsed = limit === undefined ? undefined : Number(limit);
    if (parsed !== undefined && (!Number.isInteger(parsed) || parsed < 1 || parsed > 100)) {
      throw new DomainProblem(400, 'INVALID_NOTIFICATION_LIMIT', 'Notification limit must be an integer from 1 to 100');
    }
    return this.self.notificationInbox(request, parsed);
  }

  @Post('me/notifications/:notificationId/read')
  @HttpCode(200)
  @AuditAction('identity.patient.notification.read.command')
  markNotificationRead(@Req() request: HidRequest,
    @Param('notificationId', new ParseUUIDPipe()) notificationId: string) {
    return this.self.markNotificationRead(request, notificationId);
  }

  @Post('me/access-pin')
  @HttpCode(200)
  @AuditAction('identity.patient-access-pin.configure.command')
  setAccessPin(@Req() request: HidRequest, @Body() input: SetPatientAccessPinDto) {
    return this.self.setAccessPin(request, input.pin);
  }

  @Delete('me/access-pin')
  @HttpCode(200)
  @AuditAction('identity.patient-access-pin.revoke.command')
  revokeAccessPin(@Req() request: HidRequest) {
    return this.self.revokeAccessPin(request);
  }

  // The patient's choice to share imported legacy history with staff they
  // consent to (ADR-065), behind its own switch.
  @Get('me/imported-history-sharing')
  @UseGuards(ImportedHistorySharingEnabledGuard)
  importedHistorySharing(@Req() request: HidRequest) { return this.self.importedHistorySharing(request); }

  @Post('me/imported-history-sharing')
  @HttpCode(200)
  @UseGuards(ImportedHistorySharingEnabledGuard)
  @AuditAction('identity.patient.imported-history-sharing.change.command')
  setImportedHistorySharing(@Req() request: HidRequest, @Body() input: ImportedHistorySharingDto) {
    return this.self.setImportedHistorySharing(request, input.shared);
  }

  @Get('service/patient-self-authorization')
  async authorize(@Req() request: HidRequest) {
    if (request.header('x-hid-internal-caller') !== 'ehr-api') {
      throw new DomainProblem(403, 'WORKLOAD_AUTHENTICATION_REQUIRED', 'The EHR service is required');
    }
    await this.workload.authenticateService(request.header('x-hid-internal-caller'),
      request.header('x-hid-service-authorization'), request.header('x-hid-service-token'));
    return this.self.authorize(request);
  }
}
