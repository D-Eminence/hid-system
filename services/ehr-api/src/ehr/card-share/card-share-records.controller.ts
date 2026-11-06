import { Controller, Get, Header, Req } from '@nestjs/common';
import { NoAudit, Public } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { CardShareRecordsService } from './card-share-records.service';

/**
 * GET /api/v1/card-share/records (0118): what a card link shows, to the
 * person it was sent to. Public: it never reads or refreshes a patient or
 * staff session, and never answers 401. The view is named in X-Card-View and
 * proved by its own cookie (hid_cv_<view id>, Path /api/v1/card-share), so
 * two links open in one browser never mix. The database audits each read
 * (ehr.card-share.records.read), so the interceptor records nothing here.
 */
@Controller('card-share')
@Public()
@NoAudit()
export class CardShareRecordsController {
  constructor(private readonly records: CardShareRecordsService) {}

  @Get('records')
  @Header('Cache-Control', 'no-store')
  read(@Req() request: HidRequest) {
    return this.records.read(request);
  }
}
