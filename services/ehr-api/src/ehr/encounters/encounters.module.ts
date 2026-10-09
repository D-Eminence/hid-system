import { Module } from '@nestjs/common';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { EncountersController } from './encounters.controller';
import { EncountersService } from './encounters.service';

@Module({
  imports: [ClinicalInfrastructureModule],
  controllers: [EncountersController],
  providers: [EncountersService],
})
export class EncountersModule {}
