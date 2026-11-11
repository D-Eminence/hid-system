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
import { PharmacyPrescriptionDetails } from './prescription-dispensing-details';
import { HealthIdInUrlRefusalModule } from './health-id-in-url';

@Module({ imports: [PharmacyIdentityModule, HealthIdInUrlRefusalModule], controllers: [PharmacyController, PharmacyOrderRoutesController],
  providers: [PharmacyService, PharmacyOrderRoutesService, PharmacyOrderRouteAccess, PharmacyOrderRouteCards,
    // The patient on own work (0121), on only while OWN_WORK_PATIENT_CARD_ENABLED is true.
    { provide: PharmacyOwnWorkPatientCards,
      useFactory: () => new PharmacyOwnWorkPatientCards(getEnvironment().OWN_WORK_PATIENT_CARD_ENABLED) },
    // The prescription details on own work (0122), on only while PRESCRIPTION_DISPENSING_DETAILS_ENABLED is true.
    { provide: PharmacyPrescriptionDetails,
      useFactory: () => new PharmacyPrescriptionDetails(getEnvironment().PRESCRIPTION_DISPENSING_DETAILS_ENABLED) }] })
export class PharmacyModule {}
