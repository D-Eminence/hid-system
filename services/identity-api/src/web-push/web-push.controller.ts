import { Body, Controller, Get, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, PatientOnly } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { RemoveWebPushSubscriptionDto, SubscribeWebPushDto } from './dto/web-push.dto';
import { WebPushConfiguredGuard } from './web-push-configured.guard';
import { WebPushService } from './web-push.service';

/**
 * Phone and computer notifications (B6, migration 0097): R1 to R3 of the B6
 * contract. Patient sessions only; the PUT and the POST are cookie writes
 * with Origin and CSRF, as every patient write. The SECURITY DEFINER commands
 * write the success audit; the interceptor records failures. While push is
 * not configured every route answers 404 before authentication
 * (WebPushModule's WebPushOffMiddleware, then WebPushConfiguredGuard).
 */
@Controller('identity/me/web-push')
@PatientOnly()
@AuditFailuresOnly()
@UseGuards(WebPushConfiguredGuard)
export class WebPushController {
  constructor(private readonly webPush: WebPushService) {}

  @Get()
  state(@Req() request: HidRequest) {
    return this.webPush.state(request);
  }

  @Put('subscription')
  @HttpCode(200)
  @AuditAction('identity.patient.web-push.subscribe.command')
  subscribe(@Req() request: HidRequest, @Body() input: SubscribeWebPushDto) {
    return this.webPush.subscribe(request, input);
  }

  @Post('subscription/remove')
  @HttpCode(200)
  @AuditAction('identity.patient.web-push.unsubscribe.command')
  unsubscribe(@Req() request: HidRequest, @Body() input: RemoveWebPushSubscriptionDto) {
    return this.webPush.unsubscribe(request, input);
  }
}
