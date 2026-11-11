import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OutreachController } from './outreach.controller';
import { OutreachRetentionSweeper } from './outreach-retention.sweeper';
import { OutreachService } from './outreach.service';

@Module({ imports: [IdentityModule], controllers: [OutreachController],
  providers: [OutreachService, OutreachRetentionSweeper] })
export class OutreachModule {}
