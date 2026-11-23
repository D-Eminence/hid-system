import { Controller, Get, Header } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import { usualRanges } from './usual-ranges';

/**
 * VIT-1: the adult usual-ranges table the warnings come from (no patient, no
 * consent check, no patient audit). The screen fetches it once a session.
 */
@Controller('ehr/vitals')
export class UsualRangesController {
  @Get('usual-ranges')
  @RequirePermissions('ehr.vital.read')
  @Header('Cache-Control', 'private, max-age=3600')
  usualRanges() {
    return usualRanges();
  }
}
