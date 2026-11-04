import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import type { HidRequest } from '../common/request-context';
import { RecordResultDiscussionDto, WithdrawResultDiscussionDto } from './dto/result-discussion.dto';
import { ResultDiscussionsService } from './result-discussions.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * The EHR's "Discussed with the patient" button (patient chat part 2, 0121).
 * Browser routes through the gateway (/api/v1/lab/...), facility required,
 * direct care only; never an internal caller. Listing needs
 * lab.result.released.read; marking and withdrawing need lab.result.discuss
 * (doctor, clinician). The database checks the member's care access to the
 * patient again (write consent to mark or withdraw, read consent to list).
 */
@Controller('lab/patients/:patientId')
export class ResultDiscussionsController {
  constructor(private readonly discussions: ResultDiscussionsService) {}

  @Get('result-discussions') @Header('Cache-Control', 'no-store')
  @RequirePermissions('lab.result.released.read') @AuditAction('lab.result.discussion.list.request')
  list(@Param('patientId', uuid()) patientId: string, @Req() request: HidRequest) {
    return this.discussions.list(request, patientId);
  }

  @Post('results/:resultId/discussion') @HttpCode(201) @Header('Cache-Control', 'no-store')
  @RequirePermissions('lab.result.discuss') @AuditAction('lab.result.discussion.record.request')
  record(@Param('patientId', uuid()) patientId: string, @Param('resultId', uuid()) resultId: string,
    @Body() input: RecordResultDiscussionDto, @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.discussions.record(request, patientId, resultId, input, idempotencyKey);
  }

  /** The interceptor's row carries no body: the reason is never audited. */
  @Post('results/:resultId/discussion/withdrawal') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @RequirePermissions('lab.result.discuss') @AuditAction('lab.result.discussion.withdraw.request')
  withdraw(@Param('patientId', uuid()) patientId: string, @Param('resultId', uuid()) resultId: string,
    @Body() input: WithdrawResultDiscussionDto, @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.discussions.withdraw(request, patientId, resultId, input, idempotencyKey);
  }
}
