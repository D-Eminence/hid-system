import { Body, Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import { InternalCaller, ReadOnlyPost, RequirePermissions } from '../common/decorators';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { WorkItemProgressBatchDto, WorkItemProgressDto } from './dto/work-item-progress.dto';
import { OWN_PROGRESS_ACCEPTED_HEADER, OWN_PROGRESS_ACCEPTED_VERSION, OWN_PROGRESS_HEADER, OWN_PROGRESS_VERSION,
  PharmacyWorkItemProgressService } from './work-item-progress.service';

/**
 * The progress versions the caller reads (ORD-3 0133, ORD-4), each value matched exactly; shared by both routes, so
 * the batch form answers by header exactly as the one-patient route does. A repeated header, which node joins
 * ('0133, 0133'), is not a match.
 */
export function progressVersions(request: HidRequest): { current: boolean; accepted: boolean } {
  const current = request.headers[OWN_PROGRESS_HEADER] === OWN_PROGRESS_VERSION;
  return { current, accepted: current && request.headers[OWN_PROGRESS_ACCEPTED_HEADER] === OWN_PROGRESS_ACCEPTED_VERSION };
}

/**
 * ORD-3. Read-only, for ehr-api only (the internal caller check), with the
 * clinician's own credentials and the EHR permission to read prescriptions:
 * the doctor's read does not depend on any pharmacist's grant. A POST so the
 * ids stay in the body; it changes nothing. The 0133 statuses ('withdrawn',
 * 'sent_elsewhere') are answered only when the call carries
 * X-HID-Own-Progress: 0133, as the new ehr-api always sends it. ORD-4's
 * ('accepted', `acceptedAt`) only when it also carries
 * X-HID-Own-Progress-Accepted: ord4. Each value is matched exactly. The batch
 * form (decision 4, `progress/batch`) answers several patients in one call,
 * each as by a call of its own, under direct care only.
 */
@Controller('pharmacy/work-items')
export class PharmacyWorkItemProgressController {
  constructor(private readonly progress: PharmacyWorkItemProgressService) {}

  @Post('progress')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @InternalCaller('ehr-api')
  @ReadOnlyPost()
  @RequirePermissions('ehr.prescription.read')
  read(@Body() input: WorkItemProgressDto, @Req() request: HidRequest) {
    const { current, accepted } = progressVersions(request);
    return this.progress.read(requireRequestContext(request), input, current, accepted);
  }

  @Post('progress/batch')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @InternalCaller('ehr-api')
  @ReadOnlyPost()
  @RequirePermissions('ehr.prescription.read')
  readBatch(@Body() input: WorkItemProgressBatchDto, @Req() request: HidRequest) {
    const { current, accepted } = progressVersions(request);
    return this.progress.readBatch(requireRequestContext(request), input, current, accepted);
  }
}
