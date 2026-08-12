import { Module } from '@nestjs/common';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { DiagnosesController } from './diagnoses.controller';
import { DiagnosesService } from './diagnoses.service';

@Module({ imports: [ClinicalInfrastructureModule], controllers: [DiagnosesController], providers: [DiagnosesService] })
export class DiagnosesModule {}
