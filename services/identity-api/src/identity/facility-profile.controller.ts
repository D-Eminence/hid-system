import { Body, Controller, Get, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { type HidRequest, requireRequestContext } from '../common/request-context';
import { FacilityProfileDto } from './dto/facility-profile.dto';
import { FacilityProfileService, facilityProfileVersion } from './facility-profile.service';

/**
 * The facility profile (0122): the details collected at facility sign-up
 * and in the setup wizard, read and saved by the facility administrator
 * (workforce.manage at the X-Facility-ID facility). The save is a POST (the
 * API's CORS allows GET and POST only) with If-Match (the version the page
 * loaded, 0 when there was no profile) and Idempotency-Key.
 */
@Controller('identity')
export class FacilityProfileController {
  constructor(private readonly profiles: FacilityProfileService) {}

  /** 200 { facility, version, profile }; the ETag is the version. */
  @Get('facility-profile')
  @RequirePermissions('workforce.manage')
  @AuditAction('identity.facility-profile.read')
  async read(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    const answer = await this.profiles.read(requireRequestContext(request, 'healthcare-operations'));
    response.setHeader('ETag', `"${answer.version}"`);
    return answer;
  }

  /** 200 { facilityId, version, changedFields, replayed }; the ETag is the new version. */
  @Post('facility-profile')
  @HttpCode(200)
  @RequirePermissions('workforce.manage')
  @AuditAction('identity.facility-profile.set')
  async save(@Body() input: FacilityProfileDto, @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    const version = facilityProfileVersion(ifMatch);
    const idempotencyKey = requireIdempotencyKey(key);
    const answer = await this.profiles.save(requireRequestContext(request, 'healthcare-operations'), version, input,
      idempotencyKey);
    response.setHeader('ETag', `"${answer.version}"`);
    return answer;
  }
}
