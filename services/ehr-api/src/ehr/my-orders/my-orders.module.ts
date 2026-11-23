import { Module } from '@nestjs/common';
import { ServiceClientsModule } from '../../integrations/service-clients.module';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { MyOrdersController } from './my-orders.controller';
import { MyOrdersService } from './my-orders.service';

/** MY-1 (0143): "Ordered by me". DatabaseService comes from the global module. */
@Module({
  imports: [ClinicalInfrastructureModule, ServiceClientsModule],
  controllers: [MyOrdersController],
  providers: [MyOrdersService],
})
export class MyOrdersModule {}
