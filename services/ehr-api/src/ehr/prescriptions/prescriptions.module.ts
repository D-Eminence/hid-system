import { Module } from '@nestjs/common';
import { getEnvironment } from '../../config/environment';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { ServiceClientsModule } from '../../integrations/service-clients.module';
import { PrescriptionDispensingDetails } from './prescription-dispensing-details';
import { nursingEnabled, PrescriptionInpatientSchedule } from './inpatient-schedule';
import { PrescriptionsController } from './prescriptions.controller';
import { PrescriptionsService } from './prescriptions.service';
import { OwnPharmacySend } from './own-pharmacy-send';
// ORD-10 phase 1: the duplicate-medicine warning.
import { DuplicateMedicineChecker, DuplicateMedicinesController } from './duplicate-medicines';

@Module({
  imports: [ClinicalInfrastructureModule, ServiceClientsModule],
  controllers: [PrescriptionsController, DuplicateMedicinesController],
  providers: [PrescriptionsService, DuplicateMedicineChecker,
    // The dispensing details (0125), on only while PRESCRIPTION_DISPENSING_DETAILS_ENABLED is true.
    { provide: PrescriptionDispensingDetails,
      useFactory: () => new PrescriptionDispensingDetails(getEnvironment().PRESCRIPTION_DISPENSING_DETAILS_ENABLED) },
    // NUR-1 (0175): inpatient schedules, on only while NURSING_ENABLED (and INPATIENT_ENABLED) is true.
    { provide: PrescriptionInpatientSchedule, useFactory: () => new PrescriptionInpatientSchedule(nursingEnabled()) },
    // Activated prescriptions go to this hospital's own pharmacy (0133): always on; a schema without 0133 sends nothing.
    { provide: OwnPharmacySend, useFactory: () => new OwnPharmacySend(true) }],
})
export class PrescriptionsModule {}
