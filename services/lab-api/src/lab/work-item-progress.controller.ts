import { Body, Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import { AuditAction, InternalCaller, ReadOnlyPost, RequirePermissions } from '../common/decorators';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { LabWorkItemProgressDto } from './dto/work-item-progress.dto';
import { LabWorkItemProgressService } from './work-item-progress.service';

/**
 * ORD-3. Read-only, for ehr-api only (the internal caller check), with the
 * clinician's own credentials and the EHR permission to read lab requests:
 * the doctor's read does not depend on any laboratory member's grant. A POST
 * so the ids stay in the body; it changes nothing.
 */
@Controller('lab/work-items')
export class LabWorkItemProgressController {
  constructor(private readonly progress: LabWorkItemProgressService) {}

  @Post('progress')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @InternalCaller('ehr-api')
  @ReadOnlyPost()
  @RequirePermissions('ehr.lab-request.read')
  @AuditAction('lab.work-item.progress.request')
  read(@Body() input: LabWorkItemProgressDto, @Req() request: HidRequest) {
    return this.progress.read(requireRequestContext(request), input);
  }
}
