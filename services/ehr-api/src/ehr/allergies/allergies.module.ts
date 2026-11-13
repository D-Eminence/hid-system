import { Module } from '@nestjs/common';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { AllergiesController } from './allergies.controller';
import { AllergiesService } from './allergies.service';

@Module({ imports: [ClinicalInfrastructureModule], controllers: [AllergiesController], providers: [AllergiesService] })
export class AllergiesModule {}
