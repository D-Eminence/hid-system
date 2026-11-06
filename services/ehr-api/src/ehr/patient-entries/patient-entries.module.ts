import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { PatientEntriesEnabledGuard } from './patient-entries-enabled.guard';
import { PatientEntriesController } from './patient-entries.controller';
import { PatientEntriesOffMiddleware } from './patient-entries-off.middleware';
import { PatientEntriesService } from './patient-entries.service';

/**
 * Records patients add themselves (0116). DatabaseService, IdentityApiService
 * and AuditService come from the global modules. While PATIENT_ENTRIES_ENABLED
 * is off, PatientEntriesOffMiddleware answers the routes' plain 404 before any
 * guard runs; PatientEntriesEnabledGuard on the controller checks again.
 */
@Module({
  imports: [ClinicalInfrastructureModule],
  controllers: [PatientEntriesController],
  providers: [PatientEntriesEnabledGuard, PatientEntriesService],
})
export class PatientEntriesModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(PatientEntriesOffMiddleware).forRoutes(PatientEntriesController);
  }
}
