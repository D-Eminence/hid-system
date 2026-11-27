import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { PatientMergeStartupCheck } from './patient-merges';
import { PatientMergesController } from './patient-merges.controller';
import { PatientMergesOffMiddleware } from './patient-merges-off.middleware';
import { PatientMergesService } from './patient-merges.service';

/**
 * ID-8a (0207): merge requests and the review list. DatabaseService and
 * AuditService come from the global modules. PatientMergeStartupCheck refuses
 * to start with PATIENT_MERGE_REQUESTS_ENABLED=true while one of 0207's
 * functions or its grant is missing; while the setting is false the routes
 * answer 404 (PatientMergesOffMiddleware).
 */
@Module({
  controllers: [PatientMergesController],
  providers: [PatientMergesService, PatientMergeStartupCheck],
})
export class PatientMergesModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(PatientMergesOffMiddleware).forRoutes(PatientMergesController);
  }
}
