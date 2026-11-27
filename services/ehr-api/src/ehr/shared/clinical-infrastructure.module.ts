import { Module } from '@nestjs/common';
import { OrderRouteReader } from '../order-routes/order-route-reader';
import { ClinicalRepository } from './clinical.repository';
import { NAME_ONLY_CODES_PROVIDER, NameOnlyCodes } from './name-only-codes';

@Module({
  // NameOnlyCodes: lab tests and diagnoses by name only (0156), each on only while its setting is true.
  providers: [ClinicalRepository, OrderRouteReader, NAME_ONLY_CODES_PROVIDER],
  exports: [ClinicalRepository, OrderRouteReader, NameOnlyCodes],
})
export class ClinicalInfrastructureModule {}
