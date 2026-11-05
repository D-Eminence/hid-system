import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { PatientEntriesEnabledGuard } from './patient-entries-enabled.guard';
import { PatientEntriesController } from './patient-entries.controller';
import { PatientEntriesOffMiddleware } from './patient-entries-off.middleware';
import { PatientEntriesService } from './patient-entries.service';
import { PatientEntryDocumentsController } from './patient-entry-documents.controller';
import { PatientEntryDocumentsService } from './patient-entry-documents.service';
import { PatientEntryFilesEnabledGuard } from './patient-entry-files-enabled.guard';
import { PatientEntryFilesOffMiddleware } from './patient-entry-files-off.middleware';

/**
 * Records patients add themselves (0116). DatabaseService, IdentityApiService
 * and AuditService come from the global modules. While PATIENT_ENTRIES_ENABLED
 * is off, PatientEntriesOffMiddleware answers the routes' plain 404 before any
 * guard runs; PatientEntriesEnabledGuard on the controller checks again.
 * Their photos and files (0117) have their own switch,
 * PATIENT_ENTRY_FILES_ENABLED: PatientEntryFilesOffMiddleware and
 * PatientEntryFilesEnabledGuard answer those routes' plain 404 the same way.
 */
@Module({
  imports: [ClinicalInfrastructureModule, StorageModule],
  controllers: [PatientEntriesController, PatientEntryDocumentsController],
  providers: [PatientEntriesEnabledGuard, PatientEntriesService, PatientEntryFilesEnabledGuard,
    PatientEntryDocumentsService],
})
export class PatientEntriesModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(PatientEntriesOffMiddleware).forRoutes(PatientEntriesController, PatientEntryDocumentsController);
    consumer.apply(PatientEntryFilesOffMiddleware).forRoutes(PatientEntryDocumentsController);
  }
}
