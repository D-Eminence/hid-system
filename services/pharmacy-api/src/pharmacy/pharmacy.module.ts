import { Module } from '@nestjs/common';
import { PharmacyIdentityModule } from '../identity/pharmacy-identity.module';
import { PharmacyController } from './pharmacy.controller';
import { PharmacyService } from './pharmacy.service';
import { PharmacyOrderRoutesController } from './pharmacy-order-routes.controller';
import { PharmacyOrderRoutesService } from './pharmacy-order-routes.service';
import { PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards } from './order-route-cards';

@Module({ imports: [PharmacyIdentityModule], controllers: [PharmacyController, PharmacyOrderRoutesController],
  providers: [PharmacyService, PharmacyOrderRoutesService, PharmacyOrderRouteAccess, PharmacyOrderRouteCards] })
export class PharmacyModule {}
