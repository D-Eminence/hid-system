import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { FacilityOptional, PatientAllowed } from '../../common/decorators';
import { requireIdempotencyKey } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import { requireRequestContext, type DataAccessContext, type HidRequest } from '../../common/request-context';
import {
  AcceptReferralDto, ArriveReferralDto, CompleteReferralDto, DeclineReferralDto, PatientReferralsQueryDto,
  PatientWithdrawReferralDto, ReferralAttestationQueryDto, ReferralListQueryDto, SendReferralDto, WithdrawReferralDto,
} from './referrals.dto';
import {
  REFERRAL_MESSAGES, ReferralsService, notAvailable, referralsEnabled, requireReferralAccess, type ReferralAccess,
} from './referrals.service';

/**
 * The staff context of a referral route: the service flag first (503
 * REFERRALS_NOT_AVAILABLE while it is off), then the purpose (missing: 400
 * PURPOSE_OF_USE_REQUIRED, as EHR-C7; another purpose: 403
 * REFERRAL_NOT_ALLOWED), then the session's codes at this facility (403 in
 * plain words). The database checks all of it again and audits.
 */
function staffContext(request: HidRequest, access: ReferralAccess): DataAccessContext {
  if (!referralsEnabled()) throw notAvailable();
  const purpose = request.header('x-purpose-of-use');
  if (!purpose) throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', REFERRAL_MESSAGES.purposeRequired);
  const context = requireRequestContext(request, purpose);
  if (context.purposeOfUse !== 'direct-care') {
    throw access === 'arrive'
      ? new DomainProblem(403, 'REFERRAL_ARRIVAL_NOT_ALLOWED', REFERRAL_MESSAGES.arrivalNotAllowed)
      : new DomainProblem(403, 'REFERRAL_NOT_ALLOWED', REFERRAL_MESSAGES.notAllowed);
  }
  requireReferralAccess(request, access);
  return context;
}

const uuid = () => new ParseUUIDPipe();

/**
 * REF-1 (0191-0193): referrals between facilities, the staff routes of both
 * facilities. No Health ID or NIN in any path or query: patients and visits by
 * UUID, referrals by UUID.
 */
@Controller('ehr')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  /** Route 1: the agreement text to confirm. */
  @Get('referral-attestation')
  @Header('Cache-Control', 'no-store')
  attestation(@Req() request: HidRequest, @Query() query: ReferralAttestationQueryDto) {
    return this.referrals.attestation(staffContext(request, 'send'), query.destinationKind);
  }

  /** Route 2: send from a signed visit, to a facility on Health ID or as a printed letter. */
  @Post('patients/:patientId/encounters/:encounterId/referrals')
  @HttpCode(201)
  send(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) encounterId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() input: SendReferralDto) {
    const context = staffContext(request, 'send');
    if (!(request.actor?.permissions ?? []).includes('ehr.encounter.write')) {
      throw new DomainProblem(403, 'REFERRAL_NOT_ALLOWED', REFERRAL_MESSAGES.notAllowed);
    }
    return this.referrals.send(context, patientId, encounterId, input, requireIdempotencyKey(key));
  }

  /** Route 3: this facility's sent referrals. */
  @Get('referrals/sent')
  @Header('Cache-Control', 'no-store')
  sent(@Req() request: HidRequest, @Query() query: ReferralListQueryDto) {
    return this.referrals.sentList(staffContext(request, 'read'), query);
  }

  /** Route 9: referrals waiting for this facility's answer. */
  @Get('referrals/incoming')
  @Header('Cache-Control', 'no-store')
  incoming(@Req() request: HidRequest) {
    return this.referrals.incoming(staffContext(request, 'receive'));
  }

  /** Route 10: referrals this facility answered. */
  @Get('referrals/received')
  @Header('Cache-Control', 'no-store')
  received(@Req() request: HidRequest, @Query() query: ReferralListQueryDto) {
    return this.referrals.receivedList(staffContext(request, 'receive'), query);
  }

  /** Route 13: the front desk's expected arrivals. */
  @Get('referrals/expected')
  @Header('Cache-Control', 'no-store')
  expected(@Req() request: HidRequest) {
    return this.referrals.expected(staffContext(request, 'arrive'));
  }

  /** Route 7: one referral, from either side. */
  @Get('referrals/:referralId')
  @Header('Cache-Control', 'no-store')
  read(@Req() request: HidRequest, @Param('referralId', uuid()) referralId: string) {
    return this.referrals.read(staffContext(request, 'readOrReceive'), referralId);
  }

  /** Route 4: the referring facility withdraws. */
  @Post('referrals/:referralId/withdraw')
  @HttpCode(200)
  withdraw(@Req() request: HidRequest, @Param('referralId', uuid()) referralId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: WithdrawReferralDto) {
    const context = staffContext(request, 'send');
    return this.referrals.withdraw(context, referralId, input, requireIdempotencyKey(key));
  }

  /** Route 5: the printable letter (one print per call, audited). */
  @Get('referrals/:referralId/letter')
  @Header('Cache-Control', 'no-store')
  letter(@Req() request: HidRequest, @Param('referralId', uuid()) referralId: string) {
    return this.referrals.letter(staffContext(request, 'send'), referralId);
  }

  /** Route 11: accept. */
  @Post('referrals/:referralId/accept')
  @HttpCode(200)
  accept(@Req() request: HidRequest, @Param('referralId', uuid()) referralId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: AcceptReferralDto) {
    const context = staffContext(request, 'receive');
    return this.referrals.accept(context, referralId, input, requireIdempotencyKey(key));
  }

  /** Route 12: decline. */
  @Post('referrals/:referralId/decline')
  @HttpCode(200)
  decline(@Req() request: HidRequest, @Param('referralId', uuid()) referralId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: DeclineReferralDto) {
    const context = staffContext(request, 'receive');
    return this.referrals.decline(context, referralId, input, requireIdempotencyKey(key));
  }

  /** Route 14: the patient arrived (0135's own check-in after a fresh search). */
  @Post('referrals/:referralId/arrive')
  @HttpCode(200)
  arrive(@Req() request: HidRequest, @Param('referralId', uuid()) referralId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: ArriveReferralDto) {
    const context = staffContext(request, 'arrive');
    return this.referrals.arrive(context, referralId, input, requireIdempotencyKey(key));
  }

  /** Route 15: complete with the outcome (the counter-referral). */
  @Post('referrals/:referralId/complete')
  @HttpCode(200)
  complete(@Req() request: HidRequest, @Param('referralId', uuid()) referralId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CompleteReferralDto) {
    const context = staffContext(request, 'receive');
    return this.referrals.complete(context, referralId, input, requireIdempotencyKey(key));
  }

  /** Route 8: this patient's referrals at this facility (the visit's, with encounterId). */
  @Get('patients/:patientId/referrals')
  @Header('Cache-Control', 'no-store')
  patient(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Query() query: PatientReferralsQueryDto) {
    return this.referrals.patientList(staffContext(request, 'read'), patientId, query.encounterId);
  }
}

/**
 * Routes 16 and 17: the signed-in patient's own referrals and withdraw before
 * acceptance (Q262 A, Q-REF-12 A). A staff session answers 403
 * PATIENT_SESSION_REQUIRED. Nothing else is served under me/referrals.
 */
@Controller('ehr/me/referrals')
@FacilityOptional()
@PatientAllowed()
export class PatientReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: HidRequest) {
    if (!referralsEnabled()) throw notAvailable();
    return this.referrals.myList(request);
  }

  @Post(':referralId/withdraw')
  @HttpCode(200)
  withdraw(@Req() request: HidRequest, @Param('referralId', uuid()) referralId: string,
    @Body() input: PatientWithdrawReferralDto) {
    if (!referralsEnabled()) throw notAvailable();
    return this.referrals.myWithdraw(request, referralId, input.expectedRowVersion);
  }
}
