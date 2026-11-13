import { Body, Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import { WorkloadAuthService } from '../auth/workload-auth.service';
import { AuditAction, AuditSuccessBestEffort } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { ConfirmOutreachHealthIdDto, CreateUnclaimedOutreachHealthIdDto,
  StartOutreachHealthIdDto } from './dto/outreach-health-id.dto';
import { OutreachHealthIdService } from './outreach-health-id.service';

const WRITE_PERMISSION = 'outreach.registration.write';

/**
 * Assisted Health ID at an outreach (0119, and 0120's no-contact path), for outreach-api's workload only:
 * it forwards the volunteer's browser sign-in (cookie, CSRF token, Origin) as
 * it does for POST identity/outreach/authorize. These are writes, so they are
 * not delegated-browser routes: the guard always applies the browser-write
 * Origin and CSRF check to a forwarded cookie.
 */
@Controller('identity/outreach/health-id')
export class OutreachHealthIdController {
  constructor(private readonly healthIds: OutreachHealthIdService,
    private readonly workloadAuth: WorkloadAuthService) {}

  @Post('start')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.outreach.health-id.start.request')
  async start(@Body() input: StartOutreachHealthIdDto, @Req() request: HidRequest) {
    const context = await this.authorize(request);
    const idempotencyKey = request.header('idempotency-key');
    return this.healthIds.start({ caseId: input.caseId, channel: input.channel, email: input.email }, context,
      idempotencyKey && /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey) ? idempotencyKey : undefined);
  }

  @Post('confirm')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.outreach.health-id.confirm.request')
  async confirm(@Body() input: ConfirmOutreachHealthIdDto, @Req() request: HidRequest) {
    const context = await this.authorize(request);
    return this.healthIds.confirm({ caseId: input.caseId, code: input.code }, context);
  }

  /**
   * No contact at all (0120): the Health ID with no account and a one-time
   * claim code, answered here only. The audit row of this request carries the
   * route and status, never the answer. The database function writes its own
   * audit row in the creating transaction, so a failure of the request's
   * success row afterwards is logged and the 201 still answered: a 503 would
   * lose a claim code that can never be shown again.
   */
  @Post('create-unclaimed')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.outreach.health-id.create-unclaimed.request')
  @AuditSuccessBestEffort()
  async createUnclaimed(@Body() input: CreateUnclaimedOutreachHealthIdDto, @Req() request: HidRequest) {
    const context = await this.authorize(request);
    return this.healthIds.createUnclaimed({ caseId: input.caseId }, context);
  }

  private async authorize(request: HidRequest) {
    await this.workloadAuth.authenticateOutreach(
      request.header('x-hid-internal-caller'),
      request.header('x-hid-service-authorization'),
      request.header('x-hid-service-token'),
    );
    // Never on the strength of a reported browser read (these routes are not
    // marked for delegation, so the guard never sets it; kept as a backstop).
    if (request.delegatedBrowserMethod) {
      throw new DomainProblem(403, 'CSRF_VALIDATION_FAILED', 'An Outreach write requires a valid origin and CSRF token');
    }
    const context = requireRequestContext(request, 'direct-care');
    if (context.actor.kind === 'patient' || !context.actor.permissions.includes(WRITE_PERMISSION)) {
      throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required Outreach permission is missing');
    }
    return context;
  }
}
