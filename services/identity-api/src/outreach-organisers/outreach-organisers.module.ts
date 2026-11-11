import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { OutreachInvitationsController, OutreachInvitationsPublicController,
  OutreachInvitationsSignedInController } from './outreach-invitations.controller';
import { OutreachInvitationsService } from './outreach-invitations.service';
import { OutreachOrganiserAccountController, OutreachOrganiserController } from './outreach-organiser.controller';
import { OutreachOrganiserService } from './outreach-organiser.service';
import { OutreachCampaignsAdminController, OutreachOrganisersAdminController,
  OutreachOrganisersAdminService } from './outreach-organisers-admin';

/**
 * Open sign-up on outreach. (plan PR-3): the public sign-up, "Start an
 * outreach group" for an existing account, outreach invitations and
 * support's tools. The static segments (for-my-account, accept, signed-in)
 * are registered before the routes that share their prefix.
 */
@Module({
  imports: [AuthModule, IdentityModule],
  controllers: [OutreachOrganiserAccountController, OutreachOrganiserController,
    OutreachInvitationsSignedInController, OutreachInvitationsPublicController, OutreachInvitationsController,
    OutreachOrganisersAdminController, OutreachCampaignsAdminController],
  providers: [OutreachOrganiserService, OutreachInvitationsService, OutreachOrganisersAdminService],
})
export class OutreachOrganisersModule {}
