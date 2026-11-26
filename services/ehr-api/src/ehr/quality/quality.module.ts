import { Module } from '@nestjs/common';
import { QualityController } from './quality.controller';
import { QualityService } from './quality.service';

/** QUAL-1 (0197, 0198): quality and safety reporting, behind QUALITY_INCIDENTS_ENABLED. */
@Module({
  controllers: [QualityController],
  providers: [QualityService],
})
export class QualityModule {}
