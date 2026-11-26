import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditFailuresOnly, RequireAnyPermission } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext } from '../shared/clinical-context';
import { ListOrderNoticesQueryDto, MarkOrderNoticesReadDto } from './order-notices.dto';
import { OrderNoticesService } from './order-notices.service';

/**
 * ORD-11 (0159, owner decision Q128 A): the ordering doctor's notices about
 * their own orders, at the session facility. Staff only (not
 * @PatientAllowed), a facility required, X-Purpose-Of-Use direct-care, and
 * either read permission; the database then shows lab notices only with
 * ehr.lab-request.read and dispensing notices only with
 * ehr.prescription.read (as MY-1), and a member with neither is 403
 * PERMISSION_DENIED there too. The summary is polled, so the interceptor
 * records it only when it fails (as the patient bell count); the list, mark
 * read and Seen keep the interceptor's row, beside the definers' own audit
 * rows.
 */
@Controller('ehr/me/order-notices')
@RequireAnyPermission('ehr.lab-request.read', 'ehr.prescription.read')
export class OrderNoticesController {
  constructor(private readonly notices: OrderNoticesService) {}

  @Get('summary')
  @AuditFailuresOnly()
  @Header('Cache-Control', 'no-store')
  summary(@Req() request: HidRequest) {
    return this.notices.summary(clinicalContext(request));
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: HidRequest, @Query() query: ListOrderNoticesQueryDto) {
    return this.notices.list(clinicalContext(request), query);
  }

  @Post('read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  markRead(@Req() request: HidRequest, @Body() body: MarkOrderNoticesReadDto) {
    return this.notices.markRead(clinicalContext(request), body);
  }

  /** The body is `{}` and is not read. Safe to repeat: Seen is final. */
  @Post(':noticeId/seen')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  seen(@Req() request: HidRequest, @Param('noticeId', new ParseUUIDPipe()) noticeId: string) {
    return this.notices.seen(clinicalContext(request), noticeId);
  }
}
