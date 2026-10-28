import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, FacilityOptional, PatientAllowed } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { PatientSelfService } from './patient-self.service';
import { WorkloadAuthService } from './workload-auth.service';
import { SetPatientAccessPinDto } from './dto/set-patient-access-pin.dto';
import { decodeAccessLogCursor } from './patient-access-log';

@Controller('identity')
@PatientAllowed()
@FacilityOptional()
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

  /** The bell's count (0093): unread inbox items plus unread imported hid-1.0 notifications. Not audited when it succeeds: it is polled. */
  @Get('me/notifications/unread-count')
  unreadNotificationCount(@Req() request: HidRequest) { return this.self.unreadNotificationCount(request); }

  /** Who viewed or changed the patient's record (0093), newest first; `before` is the previous page's nextBefore. */
  @Get('me/access-log')
  accessLog(@Req() request: HidRequest, @Query('limit') limit?: string, @Query('before') before?: string) {
    const parsed = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new DomainProblem(400, 'INVALID_ACCESS_LOG_LIMIT', 'Access log limit must be an integer from 1 to 100');
    }
    if (before !== undefined && typeof before !== 'string') {
      throw new DomainProblem(400, 'INVALID_ACCESS_LOG_CURSOR', 'The access log cursor is invalid');
    }
    return this.self.accessLog(request, parsed, before === undefined ? undefined : decodeAccessLogCursor(before));
  }

  @Get('me/imported-notifications')
  importedNotifications(@Req() request: HidRequest, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    const parsed = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new DomainProblem(400, 'INVALID_NOTIFICATION_LIMIT', 'Notification limit must be an integer from 1 to 100');
    const start = offset === undefined ? 0 : Number(offset);
    if (!Number.isSafeInteger(start) || start < 0 || start > 2147483647) throw new DomainProblem(400, 'INVALID_NOTIFICATION_OFFSET', 'Notification offset must be an integer from 0 to 2147483647');
    return this.self.importedNotifications(request, parsed, undefined, start);
  }

  @Post('me/imported-notifications/:notificationId/read')
  @HttpCode(200)
  markImportedNotificationRead(@Req() request: HidRequest, @Param('notificationId', new ParseUUIDPipe()) id: string) {
    return this.self.importedNotifications(request, 50, id);
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

  @Get('service/patient-self-authorization')
  async authorize(@Req() request: HidRequest) {
    if (!['ehr-api','lab-api'].includes(request.header('x-hid-internal-caller') ?? '')) {
      throw new DomainProblem(403, 'WORKLOAD_AUTHENTICATION_REQUIRED', 'An authorized patient record service is required');
    }
    await this.workload.authenticateService(request.header('x-hid-internal-caller'),
      request.header('x-hid-service-authorization'), request.header('x-hid-service-token'));
    return this.self.authorize(request);
  }
}
