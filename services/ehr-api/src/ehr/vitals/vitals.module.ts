import { Module } from '@nestjs/common';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { VitalsController } from './vitals.controller';
import { VitalsService } from './vitals.service';

@Module({ imports: [ClinicalInfrastructureModule], controllers: [VitalsController], providers: [VitalsService] })
export class VitalsModule {}
