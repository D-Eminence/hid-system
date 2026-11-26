import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/** REP-1 (0203, 0204): the facility's operations report, behind REPORTS_ENABLED and REPORTS_EXPORT_ENABLED. */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
