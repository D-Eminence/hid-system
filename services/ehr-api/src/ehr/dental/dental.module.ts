import { Module } from '@nestjs/common';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { DentalController } from './dental.controller';
import { DentalService } from './dental.service';

/** DEN-1 (0194, 0195): the dental clinic, behind DENTAL_ENABLED. */
@Module({
  imports: [ClinicalInfrastructureModule],
  controllers: [DentalController],
  providers: [DentalService],
})
export class DentalModule {}
