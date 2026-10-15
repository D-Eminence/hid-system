import { Module } from '@nestjs/common';
import { LabIdentityAuthorizationModule } from '../identity/lab-identity-authorization.module';
import { LabImportsController } from './lab-imports.controller';
import { LabImportsService } from './lab-imports.service';
import { LabWorkItemsController } from './lab-work-items.controller';
import { LabWorkItemsService } from './lab-work-items.service';
import { LabAccessionsController } from './lab-accessions.controller';
import { LabAccessionsService } from './lab-accessions.service';
import { LabExecutionsController } from './lab-executions.controller';
import { LabExecutionsService } from './lab-executions.service';
import { PatientResultsController,StaffResultsController } from './patient-results.controller';
import { PatientResultsService } from './patient-results.service';

/**
 * Laboratory bounded-context composition point.
 *
 * Imported external evidence is Lab-owned and deliberately separate from
 * native accession/specimen/execution workflows, which remain future work.
 */
@Module({ imports: [LabIdentityAuthorizationModule], controllers: [StaffResultsController,LabImportsController, LabWorkItemsController, LabAccessionsController, LabExecutionsController, PatientResultsController],
  providers: [LabImportsService, LabWorkItemsService, LabAccessionsService, LabExecutionsService, PatientResultsService],
  exports: [LabImportsService, LabWorkItemsService, LabAccessionsService, LabExecutionsService] })
export class LabModule {}
