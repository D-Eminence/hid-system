import { Module } from '@nestjs/common';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { PatientReferralsController, ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

/** REF-1 (0191-0193): referrals between facilities, behind REFERRALS_ENABLED. */
@Module({
  imports: [ClinicalInfrastructureModule],
  controllers: [ReferralsController, PatientReferralsController],
  providers: [ReferralsService],
})
export class ReferralsModule {}
