import { Module } from '@nestjs/common';
import { ClinicalRepository } from './clinical.repository';

@Module({
  providers: [ClinicalRepository],
  exports: [ClinicalRepository],
})
export class ClinicalInfrastructureModule {}
