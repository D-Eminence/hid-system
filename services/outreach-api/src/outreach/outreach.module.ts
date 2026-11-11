import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OutreachController } from './outreach.controller';
import { OutreachService } from './outreach.service';

@Module({ imports: [IdentityModule], controllers: [OutreachController], providers: [OutreachService] })
export class OutreachModule {}
