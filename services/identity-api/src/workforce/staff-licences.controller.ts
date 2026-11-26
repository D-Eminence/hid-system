import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, Res, UseFilters }
  from '@nestjs/common';
import type { Response } from 'express';
import { AuditAction } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { type DataAccessContext, type HidRequest, requireRequestContext } from '../common/request-context';
import { StaffLicencesService } from './staff-licences.service';
import { RecordLicenceRenewalDto, WithdrawLicenceRenewalDto } from './workforce.dto';
import { requireEnabled, requireLicenceAccess } from './workforce-problems';
import { WorkforceProblemFilter } from './workforce-validation.filter';

/**
 * The context of a licence route: HR_CREDENTIALS_ENABLED first (503
 * HR_CREDENTIALS_NOT_AVAILABLE while off), then the session at this facility
 * (workforce.manage at a self-signed-up facility); purpose is always
 * healthcare-operations. The database checks it all again and audits.
 */
function licenceContext(request: HidRequest): DataAccessContext {
  requireEnabled('hr');
  requireLicenceAccess(request);
  return requireRequestContext(request, 'healthcare-operations');
}

const uuid = () => new ParseUUIDPipe();

/**
 * ROS-1 routes 1-5 (0199): HR & Credentials' licence renewals and expiry, for
 * the facility's administrator. A warning only (Q243 A): an expired licence
 * never changes a role or access. Health ID connects to no regulator register
 * (Q247 A): the administrator records how they checked.
 */
@Controller('identity/staff-licences')
@UseFilters(WorkforceProblemFilter)
export class StaffLicencesController {
  constructor(private readonly licences: StaffLicencesService) {}

  /** Route 1: every member, each licensed role with its status, and the counts. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.staff-licence.list')
  list(@Req() request: HidRequest) {
    return this.licences.list(licenceContext(request));
  }

  /** Route 3: the list as CSV (UTF-8 with a byte-order mark), the last 4 characters of each number only. */
  @Get('export')
  @AuditAction('identity.staff-licence.export')
  async export(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    const answer = await this.licences.export(licenceContext(request));
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${answer.filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    return answer.body;
  }

  /** Route 2: one member's licences with every renewal. */
  @Get(':membershipId')
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.staff-licence.member-read')
  member(@Req() request: HidRequest, @Param('membershipId', uuid()) membershipId: string) {
    return this.licences.member(licenceContext(request), membershipId);
  }

  /** Route 4: record a renewal (after support's review). */
  @Post('renewals')
  @AuditAction('identity.staff-licence.renewal-record')
  async record(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined,
    @Body() input: RecordLicenceRenewalDto, @Res({ passthrough: true }) response: Response) {
    const context = licenceContext(request);
    const answer = await this.licences.record(context, input, requireIdempotencyKey(key));
    response.status(answer.status);
    return answer.body;
  }

  /** Route 5: withdraw a renewal entered by mistake. */
  @Post('renewals/:renewalId/withdraw')
  @HttpCode(200)
  @AuditAction('identity.staff-licence.renewal-withdraw')
  withdraw(@Req() request: HidRequest, @Param('renewalId', uuid()) renewalId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: WithdrawLicenceRenewalDto) {
    const context = licenceContext(request);
    return this.licences.withdraw(context, renewalId, input, requireIdempotencyKey(key));
  }
}
