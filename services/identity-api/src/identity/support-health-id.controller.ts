import { Body, Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import { Public } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { WorkloadAuthService } from '../auth/workload-auth.service';
import { SupportHealthIdMatchesDto } from './dto/support-health-id-matches.dto';
import { SupportHealthIdService } from './support-health-id.service';

/**
 * POST /api/v1/identity/service/support/health-id-matches, for support-api's workload alone (it is not an
 * IdentityCaller, so no other service route accepts it, and this route accepts no other caller). There is no
 * browser session: the workload token is the only credential. support-api calls it on the internal load balancer;
 * the public gateway refuses the path.
 */
@Controller('identity')
export class SupportHealthIdController {
  constructor(
    private readonly workloadAuth: WorkloadAuthService,
    private readonly support: SupportHealthIdService,
  ) {}

  @Post('service/support/health-id-matches')
  @Public()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async matches(@Body() input: SupportHealthIdMatchesDto, @Req() request: HidRequest) {
    await this.workloadAuth.authenticateSupport(
      request.header('x-hid-internal-caller'),
      request.header('x-hid-service-authorization'),
      request.header('x-hid-service-token'),
    );
    return this.support.matches(input.candidates);
  }
}
