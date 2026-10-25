import { Module } from '@nestjs/common';
import { OrderRouteReader } from '../order-routes/order-route-reader';
import { ClinicalRepository } from './clinical.repository';

@Module({
  providers: [ClinicalRepository, OrderRouteReader],
  exports: [ClinicalRepository, OrderRouteReader],
})
export class ClinicalInfrastructureModule {}
