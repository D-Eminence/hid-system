import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OutreachController } from './outreach.controller';
import { OutreachFeatures, VisitsEnabledGuard } from './outreach-features';
import { OutreachService } from './outreach.service';
import { OutreachVisitsService } from './outreach-visits.service';

@Module({ imports: [IdentityModule], controllers: [OutreachController], providers: [OutreachService, OutreachVisitsService, OutreachFeatures, VisitsEnabledGuard] })
export class OutreachModule {}
