import { Module } from '@nestjs/common';
import { PharmacyIdentityModule } from '../identity/pharmacy-identity.module';
import { PharmacyController } from './pharmacy.controller';
import { PharmacyService } from './pharmacy.service';

@Module({ imports: [PharmacyIdentityModule], controllers: [PharmacyController], providers: [PharmacyService] })
export class PharmacyModule {}
