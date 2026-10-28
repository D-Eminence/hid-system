import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { consentContext } from './consent-context';
import { PatientSharesService } from './patient-shares.service';

/**
 * The clinician's side of patient sharing (B4, 0095): the shares made to the
 * caller's membership ("Shared with you") and the invitations addressed to
 * the caller's verified sign-in email, with Accept. A staff session at the
 * X-Facility-ID facility, purpose direct-care, identity.consent.write. No
 * patient identity before the patient confirms an invitation.
 */
@Controller('identity')
export class StaffSharesController {
  constructor(private readonly shares: PatientSharesService) {}

  @Get('shared-with-me')
  @RequirePermissions('identity.consent.write')
  @AuditAction('identity.shared-with-me.list.request')
  sharedWithMe(@Req() request: HidRequest) {
    this.shares.assertServed();
    return this.shares.sharedWithMe(consentContext(request, ['direct-care']));
  }

  @Get('share-invitations')
  @RequirePermissions('identity.consent.write')
  @AuditAction('identity.share-invitation.list-mine.request')
  invitations(@Req() request: HidRequest) {
    this.shares.assertServed();
    return this.shares.staffInvitations(consentContext(request, ['direct-care']));
  }

  @Post('share-invitations/:invitationId/accept')
  @HttpCode(200)
  @RequirePermissions('identity.consent.write')
  @AuditAction('identity.share-invitation.accept.command')
  accept(@Req() request: HidRequest, @Param('invitationId', new ParseUUIDPipe()) invitationId: string) {
    this.shares.assertServed();
    return this.shares.accept(consentContext(request, ['direct-care']), invitationId);
  }
}
