import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { InternalCaller } from '../common/decorators';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { LabWorkItemsService } from './lab-work-items.service';
import { requireIdempotencyKey } from '../common/idempotency';
import { AcceptEhrOrderDto } from './dto/accept-ehr-order.dto';

@Controller('lab/work-items')
export class LabWorkItemsController {
  constructor(private readonly workItems: LabWorkItemsService) {}

  @Post('accept-ehr-order') @HttpCode(201) @InternalCaller('ehr-api') @RequirePermissions('lab.work-item.accept')
  @AuditAction('lab.work-item.accept.request')
  accept(@Body() input:AcceptEhrOrderDto,@Headers('idempotency-key') key:string|undefined,@Req() request:HidRequest) {
    requireIdempotencyKey(key); return this.workItems.acceptEhrOrder(requireRequestContext(request),input);
  }

  @Get()
  @RequirePermissions('lab.work-item.read')
  @AuditAction('lab.work-item.list.request')
  list(@Req() request: HidRequest) {
    return this.workItems.list(requireRequestContext(request));
  }

  @Get(':workItemId')
  @RequirePermissions('lab.work-item.read')
  @AuditAction('lab.work-item.read.request')
  get(@Param('workItemId', new ParseUUIDPipe({ version: '4' })) workItemId: string,
    @Req() request: HidRequest) {
    return this.workItems.get(requireRequestContext(request), workItemId);
  }
}
