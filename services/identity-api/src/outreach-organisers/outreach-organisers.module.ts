import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { OutreachInvitationsController, OutreachInvitationsPreviewController, OutreachInvitationsPublicController,
  OutreachInvitationsSignedInController } from './outreach-invitations.controller';
import { OutreachInvitationsService } from './outreach-invitations.service';
import { OutreachOrganiserAccountController, OutreachOrganiserController } from './outreach-organiser.controller';
import { OutreachOrganiserService } from './outreach-organiser.service';
import { OutreachRetentionSweeper } from './outreach-retention.sweeper';
import { OutreachCampaignsAdminController, OutreachOrganisersAdminController,
  OutreachOrganisersAdminService } from './outreach-organisers-admin';

/**
 * Open sign-up on outreach. (plan PR-3): the public sign-up, "Start an
 * outreach group" for an existing account, outreach invitations and
 * support's tools. The static segments (for-my-account, accept, preview, signed-in)
 * are registered before the routes that share their prefix.
 */
@Module({
  imports: [AuthModule, IdentityModule],
  controllers: [OutreachOrganiserAccountController, OutreachOrganiserController,
    OutreachInvitationsSignedInController, OutreachInvitationsPublicController, OutreachInvitationsPreviewController,
    OutreachInvitationsController,
    OutreachOrganisersAdminController, OutreachCampaignsAdminController],
  providers: [OutreachOrganiserService, OutreachInvitationsService, OutreachOrganisersAdminService,
    OutreachRetentionSweeper],
})
export class OutreachOrganisersModule {}
