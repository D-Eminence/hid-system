import { Body,Controller,Get,Headers,HttpCode,Param,ParseUUIDPipe,Post,Req } from '@nestjs/common';
import { AuditAction,RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext,type HidRequest } from '../common/request-context';
import { CompleteExecutionDto,CorrectResultDto,EnterResultDto,GovernResultDto,StartExecutionDto } from './dto/execution.dto';
import { LabExecutionsService } from './lab-executions.service';

@Controller('lab')
export class LabExecutionsController {
 constructor(private readonly executions:LabExecutionsService) {}
 @Post('specimens/:specimenId/executions') @HttpCode(201) @RequirePermissions('lab.execution.start') @AuditAction('lab.execution.start.request')
 start(@Param('specimenId',new ParseUUIDPipe({version:'4'})) specimenId:string,@Body() input:StartExecutionDto,
  @Headers('idempotency-key') key:string|undefined,@Req() request:HidRequest) { return this.executions.start(requireRequestContext(request),specimenId,input,requireIdempotencyKey(key)); }
 @Get('specimens/:specimenId/executions') @RequirePermissions('lab.execution.read')
 list(@Param('specimenId',new ParseUUIDPipe({version:'4'})) specimenId:string,@Req() request:HidRequest) { return this.executions.listForSpecimen(requireRequestContext(request),specimenId); }
 @Get('executions/:executionId') @RequirePermissions('lab.execution.read')
 get(@Param('executionId',new ParseUUIDPipe({version:'4'})) executionId:string,@Req() request:HidRequest) { return this.executions.get(requireRequestContext(request),executionId); }
 @Post('executions/:executionId/complete') @RequirePermissions('lab.execution.complete') @AuditAction('lab.execution.complete.request')
 complete(@Param('executionId',new ParseUUIDPipe({version:'4'})) executionId:string,@Body() input:CompleteExecutionDto,
  @Headers('idempotency-key') key:string|undefined,@Req() request:HidRequest) { return this.executions.complete(requireRequestContext(request),executionId,input,requireIdempotencyKey(key)); }
 @Post('executions/:executionId/results') @HttpCode(201) @RequirePermissions('lab.result.enter') @AuditAction('lab.result.enter.request')
 enter(@Param('executionId',new ParseUUIDPipe({version:'4'})) executionId:string,@Body() input:EnterResultDto,
  @Headers('idempotency-key') key:string|undefined,@Req() request:HidRequest) { return this.executions.enterResult(requireRequestContext(request),executionId,input,requireIdempotencyKey(key)); }
 @Post('executions/:executionId/results/:resultId/corrections') @RequirePermissions('lab.result.correct') @AuditAction('lab.result.correct.request')
 correct(@Param('executionId',new ParseUUIDPipe({version:'4'})) executionId:string,
  @Param('resultId',new ParseUUIDPipe({version:'4'})) resultId:string,@Body() input:CorrectResultDto,
  @Headers('idempotency-key') key:string|undefined,@Req() request:HidRequest) { return this.executions.correctResult(requireRequestContext(request),executionId,resultId,input,requireIdempotencyKey(key)); }
 @Post('results/:resultId/verify') @RequirePermissions('lab.result.verify')
 verify(@Param('resultId',new ParseUUIDPipe({version:'4'})) resultId:string,@Body() input:GovernResultDto,@Headers('idempotency-key') key:string|undefined,@Req() request:HidRequest){return this.executions.verifyResult(requireRequestContext(request),resultId,input,requireIdempotencyKey(key));}
 @Post('results/:resultId/release') @RequirePermissions('lab.result.release')
 release(@Param('resultId',new ParseUUIDPipe({version:'4'})) resultId:string,@Body() input:GovernResultDto,@Headers('idempotency-key') key:string|undefined,@Req() request:HidRequest){return this.executions.releaseResult(requireRequestContext(request),resultId,input,requireIdempotencyKey(key));}
 @Get('results/:resultId/history') @RequirePermissions('lab.result.released.read')
 history(@Param('resultId',new ParseUUIDPipe({version:'4'})) resultId:string,@Req() request:HidRequest){return this.executions.getResultHistory(requireRequestContext(request),resultId);}
}
