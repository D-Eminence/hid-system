import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, FacilityOptional, PatientAllowed } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { PatientSelfService } from './patient-self.service';
import { WorkloadAuthService } from './workload-auth.service';
import { SetPatientAccessPinDto } from './dto/set-patient-access-pin.dto';

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
    if (request.header('x-hid-internal-caller') !== 'ehr-api') {
      throw new DomainProblem(403, 'WORKLOAD_AUTHENTICATION_REQUIRED', 'The EHR service is required');
    }
    await this.workload.authenticateService(request.header('x-hid-internal-caller'),
      request.header('x-hid-service-authorization'), request.header('x-hid-service-token'));
    return this.self.authorize(request);
  }
}
