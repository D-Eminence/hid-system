import { Module } from '@nestjs/common';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { ConsultationDraftsController, MyConsultationDraftsController } from './consultation-drafts.controller';
import { ConsultationDraftSweeper, ConsultationDraftsService } from './consultation-drafts.service';

/** EHR-C6 (0141): consultation drafts. DatabaseService and AuditService come from the global modules. */
@Module({
  imports: [ClinicalInfrastructureModule],
  controllers: [ConsultationDraftsController, MyConsultationDraftsController],
  providers: [ConsultationDraftsService, ConsultationDraftSweeper],
})
export class ConsultationDraftsModule {}
