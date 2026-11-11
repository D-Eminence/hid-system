import { Module } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
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
import { LabOrderRoutesController } from './lab-order-routes.controller';
import { LabOrderRoutesService } from './lab-order-routes.service';
import { LabOrderRouteAccess } from './order-route-access';
import { LabOrderRouteCards } from './order-route-cards';
import { LabOwnWorkPatientCards } from './own-work-patient-cards';
import { HealthIdInUrlRefusalModule } from './health-id-in-url';

/**
 * Laboratory bounded-context composition point.
 *
 * Imported external evidence is Lab-owned and deliberately separate from
 * native accession/specimen/execution workflows, which remain future work.
 */
@Module({ imports: [LabIdentityAuthorizationModule, HealthIdInUrlRefusalModule], controllers: [StaffResultsController,LabImportsController, LabWorkItemsController, LabAccessionsController, LabExecutionsController, PatientResultsController, LabOrderRoutesController],
  providers: [LabImportsService, LabWorkItemsService, LabAccessionsService, LabExecutionsService, PatientResultsService,
    LabOrderRoutesService, LabOrderRouteAccess, LabOrderRouteCards,
    // The patient on own work (0121), on only while OWN_WORK_PATIENT_CARD_ENABLED is true.
    { provide: LabOwnWorkPatientCards,
      useFactory: () => new LabOwnWorkPatientCards(getEnvironment().OWN_WORK_PATIENT_CARD_ENABLED) }],
  exports: [LabImportsService, LabWorkItemsService, LabAccessionsService, LabExecutionsService] })
export class LabModule {}
