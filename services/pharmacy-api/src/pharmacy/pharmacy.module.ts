import { Module } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { PharmacyIdentityModule } from '../identity/pharmacy-identity.module';
import { PharmacyController } from './pharmacy.controller';
import { PharmacyService } from './pharmacy.service';
import { PharmacyOrderRoutesController } from './pharmacy-order-routes.controller';
import { PharmacyOrderRoutesService } from './pharmacy-order-routes.service';
import { PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards } from './order-route-cards';
import { PharmacyOwnWorkPatientCards } from './own-work-patient-cards';
import { PharmacyOwnWork } from './own-work-access';
import { PharmacyPrescriptionDetails } from './prescription-dispensing-details';
import { PharmacyChangesAfterDispensing } from './changes-after-dispensing';
import { PharmacyRefills } from './prescription-refills';
import { HealthIdInUrlRefusalModule } from './health-id-in-url';
// ORD-3: read-only progress of this facility's own work items, for ehr-api.
import { PharmacyWorkItemProgressController } from './work-item-progress.controller';
import { PharmacyWorkItemProgressService } from './work-item-progress.service';

@Module({ imports: [PharmacyIdentityModule, HealthIdInUrlRefusalModule], controllers: [PharmacyController, PharmacyOrderRoutesController, PharmacyWorkItemProgressController],
  providers: [PharmacyService, PharmacyOrderRoutesService, PharmacyWorkItemProgressService, PharmacyOrderRouteAccess, PharmacyOrderRouteCards,
    // The patient on own work (0124), on only while OWN_WORK_PATIENT_CARD_ENABLED is true.
    { provide: PharmacyOwnWorkPatientCards,
      useFactory: () => new PharmacyOwnWorkPatientCards(getEnvironment().OWN_WORK_PATIENT_CARD_ENABLED) },
    // The prescription details on own work (0125), on only while PRESCRIPTION_DISPENSING_DETAILS_ENABLED is true.
    { provide: PharmacyPrescriptionDetails,
      useFactory: () => new PharmacyPrescriptionDetails(getEnvironment().PRESCRIPTION_DISPENSING_DETAILS_ENABLED) },
    // This facility's own work for its pharmacy staff (0133): always on; a schema without 0133 answers as before.
    { provide: PharmacyOwnWork, useFactory: () => new PharmacyOwnWork(true) },
    // Q132 A (0148): the notice on a dispensed item whose prescription changed afterwards: always on, with no
    // environment setting (0133 D12's rule); a schema without 0148 answers no notice (42883), as before.
    { provide: PharmacyChangesAfterDispensing, useFactory: () => new PharmacyChangesAfterDispensing(true) },
    // Recording refills (ORD-12, 0154), on only while PRESCRIPTION_REFILLS_ENABLED is true; separate from 0125's
    // setting. One row per item, the replay and the latest-fill reversal rule do not depend on it.
    { provide: PharmacyRefills, useFactory: () => new PharmacyRefills(getEnvironment().PRESCRIPTION_REFILLS_ENABLED) }] })
export class PharmacyModule {}
