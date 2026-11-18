import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext } from '../shared/clinical-context';
import { CheckInToVisitQueueDto, ListVisitQueueQueryDto, UpdateVisitQueueEntryDto } from './visit-queue.dto';
import { VisitQueueService } from './visit-queue.service';

/**
 * EHR-C7 (0135): this facility's waiting list. Front desk, nurses, clinicians
 * and doctors (encounter read and write); not lab or pharmacy staff. Direct
 * care only. No Health ID in any path, query or answer.
 */
@Controller('ehr/visit-queue')
export class VisitQueueController {
  constructor(private readonly visitQueue: VisitQueueService) {}

  @Get()
  @RequirePermissions('ehr.encounter.read', 'ehr.encounter.write')
  list(@Req() request: HidRequest, @Query() query: ListVisitQueueQueryDto) {
    return this.visitQueue.list(clinicalContext(request), query.includeClosedToday === true);
  }

  @Post('check-in')
  @HttpCode(200)
  @RequirePermissions('ehr.encounter.read', 'ehr.encounter.write')
  checkIn(@Req() request: HidRequest, @Body() input: CheckInToVisitQueueDto) {
    return this.visitQueue.checkIn(clinicalContext(request), input);
  }

  @Patch(':entryId')
  @RequirePermissions('ehr.encounter.read', 'ehr.encounter.write')
  update(
    @Req() request: HidRequest,
    @Param('entryId', new ParseUUIDPipe()) entryId: string,
    @Body() input: UpdateVisitQueueEntryDto,
  ) {
    return this.visitQueue.update(clinicalContext(request), entryId, input);
  }
}
