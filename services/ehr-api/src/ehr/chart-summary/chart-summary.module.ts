import { Module } from '@nestjs/common';
import { ServiceClientsModule } from '../../integrations/service-clients.module';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { ChartSummaryController } from './chart-summary.controller';
import { ChartSummaryService } from './chart-summary.service';

/** EHR-C4: the chart summary. */
@Module({
  imports: [ClinicalInfrastructureModule, ServiceClientsModule],
  controllers: [ChartSummaryController],
  providers: [ChartSummaryService],
})
export class ChartSummaryModule {}
