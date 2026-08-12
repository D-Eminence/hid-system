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

/**
 * Laboratory bounded-context composition point.
 *
 * Imported external evidence is Lab-owned and deliberately separate from
 * native accession/specimen/execution workflows, which remain future work.
 */
@Module({ imports: [LabIdentityAuthorizationModule], controllers: [LabImportsController, LabWorkItemsController, LabAccessionsController, LabExecutionsController],
  providers: [LabImportsService, LabWorkItemsService, LabAccessionsService, LabExecutionsService],
  exports: [LabImportsService, LabWorkItemsService, LabAccessionsService, LabExecutionsService] })
export class LabModule {}
